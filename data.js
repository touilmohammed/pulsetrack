// PulseTrack — données locales et synchronisation, partagées par la page et le Service Worker.
// Script classique (pas de module) : chargé par <script> dans la page et par importScripts() dans sw.js.
// Dépend de vendor/idb.js (globale idb). N'utilise ni window ni document.
(function (global) {
  'use strict';

  // Bonus activés sprint par sprint (voir plan) : désactivés tant que leur sprint n'est pas validé.
  const FEATURES = { conflicts: false, push: false };

  const API_BASE = '/api';
  const DB_NAME = 'pulsetrack-db';
  const DB_VERSION = 1;

  // --- Base -----------------------------------------------------------------
  // IndexedDB est la source de vérité hors ligne. Les quatre stores existent dès la v1.
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = global.idb
        ? global.idb.openDB(DB_NAME, DB_VERSION, {
          upgrade(database, oldVersion) {
            if (oldVersion < 1) {
              const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
              sessions.createIndex('date', 'date');
              sessions.createIndex('syncState', 'syncState');
              // Opérations en attente d'envoi : opId, type, sessionId, payload, baseVersion, timestamp.
              const outbox = database.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
              outbox.createIndex('timestamp', 'timestamp');
              const photos = database.createObjectStore('photos', { keyPath: 'id' });
              photos.createIndex('sessionId', 'sessionId');
              database.createObjectStore('meta', { keyPath: 'key' });
            }
          },
          // Un autre onglet ouvre une version plus récente de la base : on lui laisse la place.
          blocking(currentVersion, blockedVersion, event) {
            event.target.close();
            dbPromise = null;
          },
        })
        : Promise.reject(new Error('Librairie idb indisponible'));
    }
    return dbPromise;
  }

  // Navigateurs anciens (iOS < 15.4) : crypto.randomUUID absent.
  function uuid() {
    if (global.crypto.randomUUID) return global.crypto.randomUUID();
    const b = global.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  async function getMeta(key) {
    const entry = await (await db()).get('meta', key);
    return entry ? entry.value : undefined;
  }

  async function setMeta(key, value) {
    await (await db()).put('meta', { key, value });
  }

  // Identité anonyme de l'appareil : rattache les séances côté serveur (en-tête X-Device-Id).
  async function getDeviceId() {
    let deviceId = await getMeta('deviceId');
    if (!deviceId) {
      deviceId = uuid();
      await setMeta('deviceId', deviceId);
    }
    return deviceId;
  }

  // --- Séances --------------------------------------------------------------
  // Plus récentes d'abord. Dates en ISO UTC : l'ordre lexical est l'ordre chronologique.
  async function listSessions() {
    return (await (await db()).getAllFromIndex('sessions', 'date')).reverse();
  }

  async function getSession(id) {
    return (await db()).get('sessions', id);
  }

  // Ce que le serveur reçoit : ni état local (syncState, seed, photoId), ni version.
  function toPayload(session) {
    const { id, type, date, durationMin, distanceKm, note, location } = session;
    return { id, type, date, durationMin, distanceKm, note, location };
  }

  function outboxEntry(type, session) {
    return {
      opId: uuid(), // Idempotency-Key : un rejeu n'est jamais appliqué deux fois par le serveur
      type,
      sessionId: session.id,
      payload: type === 'delete' ? null : toPayload(session),
      baseVersion: session.version ?? null,
      timestamp: Date.now(),
    };
  }

  // Écriture locale d'abord : la séance et son opération d'envoi sont écrites dans la même
  // transaction, donc aucune modification ne peut exister sans son entrée dans l'outbox.
  async function saveSession(fields, id) {
    const database = await db();
    const tx = database.transaction(['sessions', 'outbox'], 'readwrite');
    const sessions = tx.objectStore('sessions');
    const now = new Date().toISOString();
    const existing = id ? await sessions.get(id) : null;
    const session = existing
      ? { ...existing, ...fields, seed: false, updatedAt: now, syncState: 'pending' }
      : {
        id: uuid(),
        ...fields,
        location: fields.location ?? null,
        photoId: null,
        version: null, // attribuée par le serveur, utilisée par If-Match
        seed: false,
        createdAt: now,
        updatedAt: now,
        syncState: 'pending',
      };
    await sessions.put(session);
    // Création : POST. Modification : PUT (le serveur crée la séance s'il ne la connaît pas encore,
    // cas d'un exemple modifié).
    await tx.objectStore('outbox').add(outboxEntry(existing ? 'update' : 'create', session));
    await tx.done;
    return session;
  }

  async function deleteSession(id) {
    const database = await db();
    const tx = database.transaction(['sessions', 'photos', 'outbox'], 'readwrite');
    const session = await tx.objectStore('sessions').get(id);
    if (!session) return tx.done;
    const photoKeys = await tx.objectStore('photos').index('sessionId').getAllKeys(id);
    await Promise.all([
      tx.objectStore('sessions').delete(id),
      ...photoKeys.map((key) => tx.objectStore('photos').delete(key)),
    ]);
    // Un exemple jamais modifié n'a jamais quitté l'appareil : rien à envoyer.
    if (!(session.seed && session.version == null)) {
      await tx.objectStore('outbox').add(outboxEntry('delete', session));
    }
    return tx.done;
  }

  async function countPending() {
    return (await db()).count('outbox');
  }

  // --- Synchronisation ------------------------------------------------------
  function buildRequest(op, session, deviceId) {
    const headers = {
      'X-Device-Id': deviceId,
      'Idempotency-Key': op.opId,
    };
    const url = op.type === 'create' ? `${API_BASE}/sessions` : `${API_BASE}/sessions/${encodeURIComponent(op.sessionId)}`;
    if (op.type === 'delete') return new Request(url, { method: 'DELETE', headers });

    headers['Content-Type'] = 'application/json';
    // If-Match : la version serveur sur laquelle reposent les modifications locales. C'est celle de la
    // séance au moment de l'envoi, mise à jour après chaque opération confirmée (sprint 8).
    if (FEATURES.conflicts && op.type === 'update' && session?.version != null) {
      headers['If-Match'] = `"${session.version}"`;
    }
    return new Request(url, {
      method: op.type === 'create' ? 'POST' : 'PUT',
      headers,
      body: JSON.stringify(op.payload),
    });
  }

  // Après un succès : l'opération quitte l'outbox, la séance prend la version du serveur
  // et redevient « synchronisée » s'il ne reste aucune autre opération en attente pour elle.
  async function applySuccess(op, serverSession) {
    const database = await db();
    const tx = database.transaction(['sessions', 'outbox'], 'readwrite');
    await tx.objectStore('outbox').delete(op.id);
    const session = await tx.objectStore('sessions').get(op.sessionId);
    if (session && op.type !== 'delete') {
      const remaining = (await tx.objectStore('outbox').getAll()).some((o) => o.sessionId === op.sessionId);
      if (serverSession) session.version = serverSession.version;
      session.syncState = remaining ? 'pending' : 'synced';
      delete session.syncError;
      await tx.objectStore('sessions').put(session);
    }
    await tx.done;
  }

  // Erreur 4xx définitive (hors 412) : réessayer ne servirait à rien et bloquerait la file.
  // L'opération est retirée, la séance reste sur l'appareil, marquée « refusée », et l'utilisateur est prévenu.
  async function applyRejected(op, message) {
    const database = await db();
    const tx = database.transaction(['sessions', 'outbox'], 'readwrite');
    await tx.objectStore('outbox').delete(op.id);
    const session = await tx.objectStore('sessions').get(op.sessionId);
    if (session) {
      session.syncState = 'error';
      session.syncError = message;
      await tx.objectStore('sessions').put(session);
    }
    await tx.done;
  }

  // 412 : le serveur a une version plus récente. Rien n'est écrasé : on garde sa copie à côté
  // de la nôtre, l'utilisateur choisira (bannière du sprint 8).
  async function applyConflict(op, serverSession) {
    const database = await db();
    const tx = database.transaction(['sessions', 'outbox'], 'readwrite');
    await tx.objectStore('outbox').delete(op.id);
    const session = await tx.objectStore('sessions').get(op.sessionId);
    if (session) {
      session.syncState = 'conflict';
      session.serverCopy = serverSession ?? null;
      await tx.objectStore('sessions').put(session);
    }
    await tx.done;
  }

  async function readBody(response) {
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  // Rejoue l'outbox dans l'ordre. Une opération n'est retirée qu'après la réponse du serveur.
  // Appelée par la page (événement online, démarrage) et par le Service Worker (Background Sync).
  async function syncPendingData() {
    const run = async () => {
      const result = { sent: 0, rejected: [], conflicts: 0, remaining: 0, retry: false };
      const database = await db();
      const deviceId = await getDeviceId();
      const ops = await database.getAll('outbox');

      for (const op of ops) {
        // Une autre exécution (page ou Service Worker) a pu traiter l'opération entre-temps.
        if (!(await database.get('outbox', op.id))) continue;
        const session = await database.get('sessions', op.sessionId);
        let response;
        try {
          response = await fetch(buildRequest(op, session, deviceId));
        } catch {
          // Réseau absent, même si navigator.onLine disait le contraire : on réessaiera.
          result.retry = true;
          break;
        }
        const body = await readBody(response);
        if (response.ok) {
          await applySuccess(op, body?.session);
          result.sent++;
        } else if (response.status === 412) {
          await applyConflict(op, body?.session);
          result.conflicts++;
        } else if (response.status >= 500 || response.status === 408 || response.status === 429) {
          // Serveur indisponible ou saturé : l'opération reste dans l'outbox.
          result.retry = true;
          break;
        } else {
          const message = body?.error || `Erreur ${response.status}`;
          await applyRejected(op, message);
          result.rejected.push({ sessionId: op.sessionId, message });
        }
      }
      result.remaining = await database.count('outbox');
      return result;
    };
    // Verrou partagé entre onglets et Service Worker : un seul rejeu à la fois.
    const locks = global.navigator && global.navigator.locks;
    return locks ? locks.request('pulsetrack-sync', run) : run();
  }

  // Lecture : réseau d'abord, repli silencieux sur IndexedDB (rien à faire, la base locale est déjà affichée).
  // Les séances en attente d'envoi ne sont jamais écrasées par la copie du serveur.
  async function pullSessions() {
    let response;
    try {
      response = await fetch(`${API_BASE}/sessions`, { headers: { 'X-Device-Id': await getDeviceId() } });
    } catch {
      return { updated: 0, offline: true };
    }
    if (!response.ok) return { updated: 0, offline: false };
    const { sessions: remote = [] } = await response.json();

    const database = await db();
    const tx = database.transaction(['sessions', 'outbox'], 'readwrite');
    const pendingIds = new Set((await tx.objectStore('outbox').getAll()).map((op) => op.sessionId));
    let updated = 0;
    for (const server of remote) {
      if (pendingIds.has(server.id)) continue;
      const local = await tx.objectStore('sessions').get(server.id);
      if (local && (local.syncState !== 'synced' || (local.version ?? 0) >= server.version)) continue;
      await tx.objectStore('sessions').put({
        ...server,
        photoId: local?.photoId ?? null,
        seed: false,
        syncState: 'synced',
      });
      updated++;
    }
    await tx.done;
    return { updated, offline: false };
  }

  global.PulseData = {
    FEATURES,
    db,
    uuid,
    getMeta,
    setMeta,
    getDeviceId,
    listSessions,
    getSession,
    saveSession,
    deleteSession,
    countPending,
    syncPendingData,
    pullSessions,
  };
})(self);
