// Tests unitaires de server/api.mjs avec un stockage en mémoire.
import { createApi } from '../server/api.mjs';

const mem = new Map();
const store = {
  get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : null),
  set: async (k, v) => { mem.set(k, structuredClone(v)); },
  delete: async (k) => { mem.delete(k); },
  list: async (p) => [...mem.entries()].filter(([k]) => k.startsWith(p)).map(([, v]) => structuredClone(v)),
};
const api = createApi(store);
const DEV = '11111111-1111-4111-8111-111111111111';
const DEV2 = '22222222-2222-4222-8222-222222222222';
const SID = '33333333-3333-4333-8333-333333333333';
const op = () => crypto.randomUUID();
const call = async (method, path, { body, headers = {}, device = DEV } = {}) => {
  const res = await api(new Request('http://x' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(device ? { 'X-Device-Id': device } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const base = { id: SID, type: 'course', date: '2026-10-11T08:00:00.000Z', durationMin: 30, distanceKm: 5.123, note: 'test' };

let r = await call('GET', '/api/sessions', { device: null });
check('Sans X-Device-Id → 400', r.status === 400);
r = await call('POST', '/api/sessions', { body: { ...base, durationMin: 0 } });
check('Validation durée → 422', r.status === 422, r.body.error);
r = await call('POST', '/api/sessions', { body: { ...base, note: 'x'.repeat(501) } });
check('Validation note > 500 → 422', r.status === 422);
r = await call('POST', '/api/sessions', { body: { ...base, type: '<script>' } });
check('Validation type → 422', r.status === 422);

const key1 = op();
r = await call('POST', '/api/sessions', { body: base, headers: { 'Idempotency-Key': key1 } });
check('Création → 201, version 1, ETag', r.status === 201 && r.body.session.version === 1 && r.headers.get('ETag') === '"1"' && r.body.session.distanceKm === 5.12);
r = await call('POST', '/api/sessions', { body: base, headers: { 'Idempotency-Key': key1 } });
check('Rejeu même opId → réponse mémorisée', r.status === 201 && r.headers.get('Idempotent-Replayed') === 'true');
r = await call('POST', '/api/sessions', { body: base, headers: { 'Idempotency-Key': op() } });
check('Même séance, autre opId → 200 sans doublon', r.status === 200);
r = await call('GET', '/api/sessions');
check('Liste : 1 séance', r.body.sessions.length === 1);

r = await call('PUT', `/api/sessions/${SID}`, { body: { ...base, durationMin: 40 }, headers: { 'If-Match': '"1"', 'Idempotency-Key': op() } });
check('PUT If-Match correct → 200, version 2', r.status === 200 && r.body.session.version === 2 && r.body.session.durationMin === 40);
r = await call('PUT', `/api/sessions/${SID}`, { body: { ...base, durationMin: 50 }, headers: { 'If-Match': '"1"', 'Idempotency-Key': op() } });
check('PUT If-Match périmé → 412 + copie serveur, rien écrasé', r.status === 412 && r.body.session.durationMin === 40 && r.body.session.version === 2);
r = await call('PUT', `/api/sessions/${SID}`, { body: { ...base, durationMin: 55 } });
check('PUT sans If-Match → accepté (version 3)', r.status === 200 && r.body.session.version === 3);
r = await call('PUT', '/api/sessions/seed-1', { body: { ...base, id: 'seed-1' } });
check('PUT séance absente (exemple modifié) → 201', r.status === 201 && r.body.session.id === 'seed-1');

r = await call('GET', '/api/sessions', { device: DEV2 });
check('Isolation par appareil', r.body.sessions.length === 0);

const delKey = op();
r = await call('DELETE', `/api/sessions/${SID}`, { headers: { 'Idempotency-Key': delKey } });
check('DELETE → 204', r.status === 204);
r = await call('DELETE', `/api/sessions/${SID}`, { headers: { 'Idempotency-Key': delKey } });
check('DELETE rejoué → 204', r.status === 204);
r = await call('GET', `/api/sessions/${SID}`);
check('GET après DELETE → 404', r.status === 404);
r = await call('PATCH', `/api/sessions/${SID}`);
check('Méthode inconnue → 405', r.status === 405);
r = await call('GET', '/api/autre');
check('Route inconnue → 404', r.status === 404);
r = await api(new Request('http://x/api/sessions', { method: 'POST', headers: { 'X-Device-Id': DEV }, body: '{oups' }));
check('JSON invalide → 400', r.status === 400);

console.log(results.join('\n'));

// Limitation de débit (instance séparée, limite basse)
{
  const limited = createApi(store, { rateLimit: { windowMs: 60_000, max: 3 } });
  const DEV3 = '44444444-4444-4444-8444-444444444444';
  const del = () => limited(new Request('http://x/api/sessions/abc', { method: 'DELETE', headers: { 'X-Device-Id': DEV3 } }));
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await del()).status);
  const last = await del();
  const read = await limited(new Request('http://x/api/sessions', { headers: { 'X-Device-Id': DEV3 } }));
  const other = await limited(new Request('http://x/api/sessions/abc', { method: 'DELETE', headers: { 'X-Device-Id': DEV } }));
  console.log(`${statuses.join(',') === '204,204,204,429' && last.headers.get('Retry-After') && read.status === 200 && other.status === 204 ? 'OK  ' : 'FAIL'} Limitation de débit : 429 + Retry-After, lectures et autres appareils non bloqués — ${statuses}`);
}

// X-If-Match (double de If-Match, Netlify ne transmet pas l'en-tête standard aux Functions)
{
  const DEV4 = '55555555-5555-4555-8555-555555555555';
  const SID4 = '66666666-6666-4666-8666-666666666666';
  const body = { ...base, id: SID4 };
  const send = (method, path, b, headers = {}) => api(new Request('http://x' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEV4, ...headers }, body: JSON.stringify(b) }));
  await send('POST', '/api/sessions', body);
  const ok = await send('PUT', `/api/sessions/${SID4}`, body, { 'X-If-Match': '"1"' });
  const stale = await send('PUT', `/api/sessions/${SID4}`, body, { 'X-If-Match': '"1"' });
  console.log(`${ok.status === 200 && stale.status === 412 ? 'OK  ' : 'FAIL'} X-If-Match : même effet que If-Match (200 puis 412) — ${ok.status},${stale.status}`);
}
