// Rappels push côté serveur, avec un faux service de push local : la requête Web Push réelle
// (chiffrée, signée VAPID) est reçue puis déchiffrée avec la clé de l'abonnement.
import { createServer } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import ece from 'http_ece';
import { createApi } from '../server/api.mjs';
import { runReminders, isAllowedEndpoint, createSender } from '../server/push.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

// Faux service de push
const received = [];
let nextStatus = 201;
const pushService = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(nextStatus);
    res.end();
  });
});
await new Promise((r) => pushService.listen(0, r));
const endpoint = `http://localhost:${pushService.address().port}/push/abc`;

// Abonnement côté « navigateur » : paire ECDH P-256 + secret d'authentification
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const authSecret = randomBytes(16);
const subscription = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };
const decrypt = (body) => JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret }).toString());

const vapid = webpush.generateVAPIDKeys();
const mem = new Map();
const store = {
  get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : null),
  set: async (k, v) => { mem.set(k, structuredClone(v)); },
  delete: async (k) => { mem.delete(k); },
  list: async (p) => [...mem.entries()].filter(([k]) => k.startsWith(p)).map(([, v]) => structuredClone(v)),
};
const send = createSender(webpush, { subject: 'https://pulsetrackisco.netlify.app', ...vapid });
const api = createApi(store, { push: { publicKey: vapid.publicKey, sendNotification: send, extraHosts: ['localhost'] } });
const DEV = '77777777-7777-4777-8777-777777777777';
const call = async (method, path, body, a = api) => {
  const res = await a(new Request('http://x' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEV }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
// Mercredi 14 octobre 2026, 18 h à Paris (16 h UTC)
const reminder = { days: [1, 3, 5], hour: 18, timeZone: 'Europe/Paris' };
const WED_18 = new Date('2026-10-14T16:05:00Z');

try {
  check('Liste blanche : services connus acceptés, autres refusés',
    isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/x') && isAllowedEndpoint('https://web.push.apple.com/abc')
    && isAllowedEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x') && !isAllowedEndpoint('https://evil.example.com/x')
    && !isAllowedEndpoint('http://fcm.googleapis.com/x') && !isAllowedEndpoint('https://fcm.googleapis.com.evil.com/x'));

  let r = await call('GET', '/api/push/key');
  check('Clé publique VAPID exposée', r.status === 200 && r.body.publicKey === vapid.publicKey);
  r = await call('GET', '/api/push/key', undefined, createApi(store));
  check('Sans clés VAPID : 503 explicite', r.status === 503);

  r = await call('POST', '/api/push/subscribe', { subscription: { ...subscription, endpoint: 'https://evil.example.com/x' }, reminder });
  check('Abonnement vers un hôte inconnu refusé (anti-SSRF)', r.status === 422, r.body.error);
  r = await call('POST', '/api/push/subscribe', { subscription, reminder: { ...reminder, days: [] } });
  check('Abonnement sans jour refusé', r.status === 422);
  r = await call('POST', '/api/push/subscribe', { subscription, reminder });
  check('Abonnement enregistré', r.status === 201 && r.body.reminder.hour === 18);
  r = await call('POST', '/api/push/subscribe', { subscription, reminder: { ...reminder, hour: 7 } });
  check('Réabonnement : préférences mises à jour, pas de doublon', r.status === 200 && (await store.list(`push/${DEV}/`)).length === 1);
  await call('POST', '/api/push/subscribe', { subscription, reminder });

  r = await call('POST', '/api/push/test');
  const test = received.at(-1);
  check('Rappel de test : requête Web Push envoyée', r.status === 200 && r.body.sent === 1 && received.length === 1);
  check('Requête signée VAPID et chiffrée (aes128gcm), TTL', test.headers.authorization?.startsWith('vapid t=') && test.headers['content-encoding'] === 'aes128gcm' && test.headers.ttl === '3600');
  const testMsg = decrypt(test.body);
  check('Contenu déchiffré : titre, texte, tag, URL « Nouvelle séance »', testMsg.title === 'PulseTrack' && testMsg.body.startsWith('Rappel de test') && testMsg.tag === 'pulsetrack-reminder' && testMsg.url === '/#session-form');

  let s = await runReminders(store, send, new Date('2026-10-13T16:05:00Z')); // mardi 18 h
  check('Mardi : pas de rappel (jour non choisi)', s.sent === 0 && received.length === 1);
  s = await runReminders(store, send, new Date('2026-10-14T15:05:00Z')); // mercredi 17 h
  check('Mercredi 17 h : pas encore', s.sent === 0);
  s = await runReminders(store, send, WED_18);
  const msg = decrypt(received.at(-1).body);
  check('Mercredi 18 h (heure de Paris) : rappel envoyé', s.sent === 1 && msg.body === 'C\'est l\'heure de ta séance ! (mercredi, 18 h)', msg.body);
  s = await runReminders(store, send, new Date('2026-10-14T16:40:00Z'));
  check('Même heure, second passage : pas de doublon', s.sent === 0 && received.length === 2, `reçues=${received.length}`);

  nextStatus = 410;
  s = await runReminders(store, send, new Date('2026-10-16T16:05:00Z')); // vendredi 18 h
  check('Abonnement expiré (410) : supprimé', s.expired === 1 && (await store.list('push/')).length === 0);
  nextStatus = 201;

  await call('POST', '/api/push/subscribe', { subscription, reminder });
  r = await call('DELETE', '/api/push/subscribe', { endpoint });
  check('Désabonnement : supprimé du serveur', r.status === 204 && (await store.list('push/')).length === 0);
  r = await call('POST', '/api/push/test');
  check('Rappel de test sans abonnement : 404', r.status === 404);
} catch (e) {
  check('Exécution du test', false, e.stack);
} finally {
  pushService.close();
  console.log(results.join('\n'));
}
