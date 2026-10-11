// API PulseTrack — indépendante de l'hébergement : reçoit une Request, renvoie une Response.
// Utilisée par netlify/functions/api.mjs (Netlify Blobs) et server/server.mjs (fichier JSON, en local).
//
// Le stockage est injecté : { get(key), set(key, value), delete(key), list(prefix) }.
// Clés : sessions/<deviceId>/<sessionId> et ops/<deviceId>/<opId> (réponses mémorisées pour l'idempotence).

const TYPES = new Set(['course', 'velo', 'marche', 'musculation', 'autre']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Identifiant de séance généré par le client : UUID, ou seed-N pour un exemple modifié.
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const NOTE_MAX = 500;
const DURATION_MAX = 24 * 60;
const DISTANCE_MAX = 1000;
const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

// Mêmes règles que le client : le serveur ne fait jamais confiance à ce qu'il reçoit.
export function validateSession(input) {
  const errors = [];
  if (typeof input !== 'object' || input === null) return { errors: ['Corps JSON attendu.'], value: null };

  const type = input.type;
  if (!TYPES.has(type)) errors.push('type invalide');

  const date = new Date(input.date);
  if (typeof input.date !== 'string' || Number.isNaN(date.getTime())) errors.push('date invalide');

  const durationMin = input.durationMin;
  if (!Number.isInteger(durationMin) || durationMin <= 0 || durationMin > DURATION_MAX) errors.push('durationMin invalide');

  let distanceKm = input.distanceKm ?? null;
  if (distanceKm !== null) {
    if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm < 0 || distanceKm > DISTANCE_MAX) {
      errors.push('distanceKm invalide');
    } else {
      distanceKm = round(distanceKm, 2);
    }
  }

  const note = input.note ?? '';
  if (typeof note !== 'string' || note.length > NOTE_MAX) errors.push(`note invalide (${NOTE_MAX} caractères max)`);

  let location = input.location ?? null;
  if (location !== null) {
    const { lat, lng, accuracy } = location;
    const ok = typeof lat === 'number' && lat >= -90 && lat <= 90
      && typeof lng === 'number' && lng >= -180 && lng <= 180
      && (accuracy == null || (typeof accuracy === 'number' && accuracy >= 0));
    if (!ok) errors.push('location invalide');
    else location = { lat: round(lat, 5), lng: round(lng, 5), accuracy: accuracy == null ? null : Math.round(accuracy) };
  }

  return {
    errors,
    value: errors.length ? null : { type, date: date.toISOString(), durationMin, distanceKm, note, location },
  };
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Corps de requête trop volumineux.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON invalide.');
  }
}

// If-Match: "3" → 3 ; absent → null ; * → '*'
function parseIfMatch(header) {
  if (header == null) return null;
  const value = header.trim();
  if (value === '*') return '*';
  const n = Number(value.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n)) throw new HttpError(400, 'En-tête If-Match invalide.');
  return n;
}

const etag = (session) => ({ ETag: `"${session.version}"` });

export function createApi(store, { now = () => new Date().toISOString() } = {}) {
  const sessionKey = (deviceId, id) => `sessions/${deviceId}/${id}`;

  async function list(deviceId) {
    const sessions = await store.list(`sessions/${deviceId}/`);
    sessions.sort((a, b) => b.date.localeCompare(a.date));
    return json(200, { sessions });
  }

  async function get(deviceId, id) {
    const session = await store.get(sessionKey(deviceId, id));
    if (!session) throw new HttpError(404, 'Séance introuvable.');
    return json(200, { session }, etag(session));
  }

  // POST : création. Rejouer la même séance (même id) ne crée pas de doublon.
  async function create(deviceId, request) {
    const body = await readJson(request);
    if (!SESSION_ID_RE.test(body?.id ?? '')) throw new HttpError(400, 'id de séance invalide.');
    const { errors, value } = validateSession(body);
    if (errors.length) throw new HttpError(422, `Séance invalide : ${errors.join(', ')}.`);

    const key = sessionKey(deviceId, body.id);
    const existing = await store.get(key);
    if (existing) return json(200, { session: existing }, etag(existing));

    const timestamp = now();
    const session = { id: body.id, ...value, version: 1, createdAt: timestamp, updatedAt: timestamp };
    await store.set(key, session);
    return json(201, { session }, etag(session));
  }

  // PUT : modification. Avec If-Match, refus (412) si le serveur a une version plus récente :
  // rien n'est écrasé et la copie du serveur est renvoyée pour la réconciliation.
  async function update(deviceId, id, request) {
    const ifMatch = parseIfMatch(request.headers.get('If-Match'));
    const body = await readJson(request);
    const { errors, value } = validateSession(body);
    if (errors.length) throw new HttpError(422, `Séance invalide : ${errors.join(', ')}.`);

    const key = sessionKey(deviceId, id);
    const existing = await store.get(key);
    if (existing && ifMatch !== null && ifMatch !== '*' && ifMatch !== existing.version) {
      return json(412, { error: 'La séance a été modifiée ailleurs.', session: existing }, etag(existing));
    }

    const timestamp = now();
    // Absente du serveur (création encore jamais reçue, exemple modifié) : on la crée.
    const session = existing
      ? { ...existing, ...value, version: existing.version + 1, updatedAt: timestamp }
      : { id, ...value, version: 1, createdAt: timestamp, updatedAt: timestamp };
    await store.set(key, session);
    return json(existing ? 200 : 201, { session }, etag(session));
  }

  // DELETE : idempotent, 204 même si la séance n'existe plus.
  async function remove(deviceId, id) {
    await store.delete(sessionKey(deviceId, id));
    return json(204, null);
  }

  async function route(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/sessions(?:\/([^/]+))?\/?$/);
    if (!match) throw new HttpError(404, 'Route inconnue.');

    const deviceId = request.headers.get('X-Device-Id') ?? '';
    if (!UUID_RE.test(deviceId)) throw new HttpError(400, 'En-tête X-Device-Id manquant ou invalide.');

    const id = match[1] ? decodeURIComponent(match[1]) : null;
    if (id !== null && !SESSION_ID_RE.test(id)) throw new HttpError(400, 'id de séance invalide.');

    const method = request.method;
    if (method === 'GET') return id ? get(deviceId, id) : list(deviceId);
    if (method === 'POST' && !id) return idempotent(deviceId, request, () => create(deviceId, request));
    if (method === 'PUT' && id) return idempotent(deviceId, request, () => update(deviceId, id, request));
    if (method === 'DELETE' && id) return idempotent(deviceId, request, () => remove(deviceId, id));
    throw new HttpError(405, 'Méthode non autorisée.');
  }

  // Idempotency-Key = opId de l'outbox. Une opération rejouée (réponse perdue, double envoi
  // page + Service Worker) renvoie la réponse mémorisée au lieu d'être appliquée deux fois.
  async function idempotent(deviceId, request, handler) {
    const opId = request.headers.get('Idempotency-Key');
    if (opId === null) return handler();
    if (!UUID_RE.test(opId)) throw new HttpError(400, 'En-tête Idempotency-Key invalide.');

    const opKey = `ops/${deviceId}/${opId}`;
    const previous = await store.get(opKey);
    if (previous) {
      return json(previous.status, previous.body, { 'Idempotent-Replayed': 'true' });
    }
    const response = await handler();
    // Seuls les succès sont mémorisés : un 412 ou un 5xx peut réussir au prochain essai.
    if (response.ok) {
      const body = response.status === 204 ? null : await response.clone().json();
      await store.set(opKey, { status: response.status, body, at: now() });
    }
    return response;
  }

  return async function handle(request) {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      console.error(error);
      return json(500, { error: 'Erreur interne.' });
    }
  };
}
