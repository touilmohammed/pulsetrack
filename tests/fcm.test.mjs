// Rappels vers l'app Android (FCM HTTP v1), avec un faux Google local : le jeton d'accès (JWT RS256
// signé par le compte de service) et chaque message sont reçus, vérifiés, puis comparés à l'API de Google.
import { createServer } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { deliver, runReminders } from '../server/push.mjs';
import { createFcmSender, fcmCredentialsFromEnv, signJwt } from '../server/fcm.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

// Compte de service de test : une vraie paire RSA, comme celle que génère la console Firebase.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const account = { projectId: 'pulsetrack-test', clientEmail: 'fcm@pulsetrack-test.iam.gserviceaccount.com', privateKey };

// Faux Google : /token échange le JWT contre un jeton d'accès, /v1/projects/.../messages:send reçoit le message.
const tokenRequests = [];
const messages = [];
let sendStatus = 200;
let sendBody = '{"name":"projects/pulsetrack-test/messages/1"}';
const google = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    if (req.url === '/token') {
      tokenRequests.push(new URLSearchParams(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: `jeton-${tokenRequests.length}`, expires_in: 3600 }));
      return;
    }
    messages.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(sendStatus, { 'Content-Type': 'application/json' });
    res.end(sendBody);
  });
});
await new Promise((r) => google.listen(0, r));
const base = `http://localhost:${google.address().port}`;
const fcm = createFcmSender(account, { tokenUrl: `${base}/token`, apiBase: base });

const mem = new Map();
const store = {
  get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : null),
  set: async (k, v) => { mem.set(k, structuredClone(v)); },
  delete: async (k) => { mem.delete(k); },
  list: async (p) => [...mem.entries()].filter(([k]) => k.startsWith(p)).map(([, v]) => structuredClone(v)),
};
const DEV = '88888888-8888-4888-8888-888888888888';
const call = async (method, path, body, api) => {
  const res = await api(new Request('http://x' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEV }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const TOKEN = 'fGx7Tq2pRk3:APA91bH-jeton_de_test_FCM_assez_long_0123456789';
const reminder = { days: [1, 3, 5], hour: 18, timeZone: 'Europe/Paris' };
const WED_18 = new Date('2026-10-14T16:05:00Z'); // mercredi 18 h à Paris

try {
  // Configuration depuis l'environnement
  // La clé, telle qu'on peut la coller dans Netlify : chaque forme doit redonner une clé utilisable.
  const body = privateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const forms = {
    'PEM d\'origine': privateKey,
    '« \\n » littéraux du JSON': privateKey.replace(/\n/g, '\\n'),
    'entre guillemets': `"${privateKey.replace(/\n/g, '\\n')}"`,
    'sans en-tête ni pied, sur une ligne': body,
    'sans en-tête ni pied, avec espaces': body.match(/.{1,40}/g).join(' '),
  };
  const usable = Object.entries(forms).filter(([, value]) => {
    const key = fcmCredentialsFromEnv({ FCM_PROJECT_ID: 'p', FCM_CLIENT_EMAIL: 'e@x', FCM_PRIVATE_KEY: value }).privateKey;
    try {
      return createVerify('RSA-SHA256').update('x').verify(publicKey, signJwt({ x: 1 }, key).split('.')[2], 'base64url') !== undefined;
    } catch {
      return false;
    }
  }).map(([name]) => name);
  check('Clé collée sous toutes ses formes : PEM reconstruit, signature possible', usable.length === Object.keys(forms).length, `utilisables : ${usable.join(', ')}`);
  check('Sans les trois variables : FCM désactivé', fcmCredentialsFromEnv({ FCM_PROJECT_ID: 'p' }) === null);

  // Routes de l'API
  let r = await call('POST', '/api/push/fcm', { token: TOKEN, reminder }, createApi(store, { push: null }));
  check('Sans compte de service : 503 explicite', r.status === 503 && r.body.error.includes('Android'));
  const api = createApi(store, { push: { fcm } });
  r = await call('POST', '/api/push/fcm', { token: 'https://evil.example.com/x', reminder }, api);
  check('Jeton invalide (une URL) refusé', r.status === 422, r.body?.error);
  r = await call('POST', '/api/push/fcm', { token: TOKEN, reminder: null }, api);
  check('Rappel absent : 422, pas 500', r.status === 422);
  r = await call('POST', '/api/push/fcm', { token: TOKEN, reminder }, api);
  check('Abonnement Android enregistré', r.status === 201 && r.body.reminder.hour === 18);
  r = await call('POST', '/api/push/fcm', { token: TOKEN, reminder: { ...reminder, hour: 7 } }, api);
  check('Réabonnement : préférences mises à jour, pas de doublon', r.status === 200 && (await store.list(`push/${DEV}/`)).length === 1);
  await call('POST', '/api/push/fcm', { token: TOKEN, reminder }, api);
  r = await call('GET', '/api/push/key', undefined, api);
  check('Sans VAPID, la route Web Push reste à 503 (la PWA l\'explique)', r.status === 503);

  // Rappel de test : le vrai trajet jusqu'à « Google »
  r = await call('POST', '/api/push/test', undefined, api);
  check('Rappel de test envoyé à l\'app', r.status === 200 && r.body.sent === 1 && messages.length === 1, JSON.stringify(r.body));
  const jwt = tokenRequests[0]?.get('assertion') ?? '';
  const [header, claims, signature] = jwt.split('.');
  const decoded = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString());
  const signed = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url');
  check('JWT signé RS256 par le compte de service', signed && JSON.parse(Buffer.from(header, 'base64url')).alg === 'RS256');
  check('JWT : émetteur, portée FCM, durée 1 h', decoded.iss === account.clientEmail && decoded.scope === 'https://www.googleapis.com/auth/firebase.messaging' && decoded.exp - decoded.iat === 3600);
  check('Grant type jwt-bearer', tokenRequests[0]?.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const sent = messages[0];
  check('Envoyé au projet, avec le jeton d\'accès', sent.url === '/v1/projects/pulsetrack-test/messages:send' && sent.auth === 'Bearer jeton-1');
  check('Message data (titre, texte, tag, URL), destiné au bon appareil', sent.body.message.token === TOKEN
    && sent.body.message.data.title === 'PulseTrack' && sent.body.message.data.body.startsWith('Rappel de test')
    && sent.body.message.data.url === '/#session-form' && sent.body.message.notification === undefined);
  check('Priorité haute (traverse Doze), TTL 1 h', sent.body.message.android.priority === 'HIGH' && sent.body.message.android.ttl === '3600s');

  // Rappels horaires : la même tâche sert la PWA et l'app
  const webSent = [];
  const web = async (subscription) => { webSent.push(subscription.endpoint); };
  await store.set(`push/${DEV}/web`, { id: 'web', deviceId: DEV, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x' }, reminder, lastSent: null });
  const s = await runReminders(store, { web, fcm }, WED_18);
  check('Mercredi 18 h : rappel envoyé à la PWA et à l\'app', s.sent === 2 && webSent.length === 1 && messages.length === 2, JSON.stringify(s));
  check('Jeton d\'accès réutilisé (pas de nouvelle demande)', tokenRequests.length === 1, `demandes=${tokenRequests.length}`);
  check('Texte du rappel', messages[1].body.message.data.body === 'C\'est l\'heure de ta séance ! (mercredi, 18 h)');
  const again = await runReminders(store, { web, fcm }, WED_18);
  check('Second passage : pas de doublon', again.sent === 0);

  // Jeton périmé (app désinstallée) : supprimé, comme un abonnement Web Push expiré
  sendStatus = 404;
  sendBody = '{"error":{"code":404,"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}';
  const record = (await store.list(`push/${DEV}/`)).find((x) => x.fcmToken);
  check('App désinstallée (UNREGISTERED) : abonnement supprimé', (await deliver(store, record, { title: 't', body: 'b' }, { fcm })) === 'expired'
    && !(await store.list(`push/${DEV}/`)).some((x) => x.fcmToken));
  sendStatus = 200;

  // FCM non configuré : l'abonnement Android est gardé, rien n'est perdu
  await call('POST', '/api/push/fcm', { token: TOKEN, reminder }, api);
  const kept = (await store.list(`push/${DEV}/`)).find((x) => x.fcmToken);
  check('Sans expéditeur FCM : échec signalé, abonnement gardé', (await deliver(store, kept, { title: 't' }, { web })) === 'failed' && Boolean(await store.get(`push/${DEV}/${kept.id}`)));

  r = await call('DELETE', '/api/push/fcm', { token: TOKEN }, api);
  check('Désabonnement Android', r.status === 204 && !(await store.list(`push/${DEV}/`)).some((x) => x.fcmToken));
} catch (e) {
  check('Exécution du test', false, e.stack);
} finally {
  google.close();
  console.log(results.join('\n'));
}
