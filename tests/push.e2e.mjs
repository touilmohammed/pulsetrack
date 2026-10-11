// Bonus push (T16) de bout en bout : permission au clic seulement, refus géré, abonnement, rappel de
// test réellement envoyé par le serveur (Web Push chiffré vers un faux service local), notification
// affichée par le Service Worker, clic → « Nouvelle séance », désactivation.
// Le serveur testé doit accepter le faux service : PUSH_EXTRA_HOSTS=localhost (fait par run-all.mjs).
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';

const BASE = process.argv[2];
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// Faux service de push et clés de l'abonnement simulé
const received = [];
const pushService = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { received.push(Buffer.concat(chunks)); res.writeHead(201); res.end(); });
});
await new Promise((r) => pushService.listen(0, r));
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const authSecret = randomBytes(16);
const fakeSubscription = {
  endpoint: `http://localhost:${pushService.address().port}/push/device-1`,
  keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
};
const decrypt = (body) => ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret }).toString();

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|404/.test(m.text())) errors.push(m.text()); });
  const cdp = await page.createCDPSession();
  const registrations = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => registrations.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');

  // Compteur d'appels à la permission, et abonnement simulé (pas de service de push en mode headless).
  await page.evaluateOnNewDocument((sub) => {
    window.__permissionCalls = 0;
    const real = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (...a) => { window.__permissionCalls++; return real(...a); };
    let current = null;
    const make = () => ({
      endpoint: sub.endpoint,
      toJSON: () => ({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
      unsubscribe: async () => { current = null; window.__unsubscribed = true; return true; },
    });
    PushManager.prototype.subscribe = async function subscribe(options) {
      window.__subscribeOptions = { userVisibleOnly: options.userVisibleOnly, keyLength: options.applicationServerKey.byteLength };
      current = make();
      return current;
    };
    PushManager.prototype.getSubscription = async () => current;
  }, fakeSubscription);

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'load' });
  await settle(600);

  check('Aucune demande de permission au chargement', (await page.evaluate(() => window.__permissionCalls)) === 0);
  const defaults = await page.evaluate(() => ({
    days: [...document.querySelectorAll('input[name="push-day"]:checked')].map((i) => i.value).join(','),
    hour: document.getElementById('push-hour').value,
    visible: !document.getElementById('push-settings').hidden,
  }));
  check('Réglages : section visible, lun/mer/ven à 18 h par défaut', defaults.visible && defaults.days === '1,3,5' && defaults.hour === '18', JSON.stringify(defaults));

  // Refus
  await cdp.send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'denied', origin: BASE });
  await page.click('#push-enable');
  await settle();
  const denied = await page.$eval('#push-status', (el) => el.textContent);
  check('Refus : message clair, pas d\'erreur, permission demandée au clic', denied.startsWith('Notifications refusées') && (await page.evaluate(() => window.__permissionCalls)) === 1, denied);
  check('Refus : le reste de l\'app fonctionne', !(await page.$eval('#submit-btn', (el) => el.disabled)) && (await page.$eval('#push-test', (el) => el.hidden)));

  // Aucun jour choisi
  await page.evaluate(() => document.querySelectorAll('input[name="push-day"]').forEach((i) => { i.checked = false; }));
  await page.click('#push-enable');
  await settle(200);
  check('Aucun jour : message, pas de demande de permission', (await page.$eval('#push-status', (el) => el.textContent)) === 'Choisissez au moins un jour.' && (await page.evaluate(() => window.__permissionCalls)) === 1);

  // Acceptation
  await page.click('input[name="push-day"][value="2"]');
  await page.click('input[name="push-day"][value="4"]');
  await page.select('#push-hour', '7');
  await cdp.send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'granted', origin: BASE });
  await page.click('#push-enable');
  await page.waitForFunction(() => document.getElementById('push-status').textContent.startsWith('Rappels activés'), { timeout: 8000 });
  const enabled = await page.evaluate(() => ({ status: document.getElementById('push-status').textContent, opts: window.__subscribeOptions, test: !document.getElementById('push-test').hidden }));
  check('Activation : abonnement avec la clé VAPID du serveur (65 octets)', enabled.opts?.userVisibleOnly === true && enabled.opts.keyLength === 65, JSON.stringify(enabled.opts));
  check('Activation : jours et heure confirmés, boutons test et désactivation', enabled.status === 'Rappels activés : mar. jeu. à 7 h.' && enabled.test, enabled.status);

  // Rappel de test : le serveur envoie une vraie requête Web Push au faux service
  await page.click('#push-test');
  await page.waitForFunction(() => document.getElementById('push-status').textContent.startsWith('Rappel de test envoyé'), { timeout: 8000 });
  await settle(300);
  const payload = received.length ? decrypt(received.at(-1)) : null;
  check('Rappel de test : requête Web Push reçue et déchiffrée', payload?.includes('Rappel de test'), payload);

  // Le message déchiffré est remis au Service Worker comme un vrai push
  const reg = registrations.find((r) => !r.isDeleted);
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId: reg.registrationId, data: payload });
  await settle(800);
  const shown = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return (await r.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, icon: new URL(n.icon).pathname, url: n.data?.url }));
  });
  check('Notification affichée : titre, texte, icône 192 px, tag unique', shown.length === 1 && shown[0].title === 'PulseTrack' && shown[0].body.startsWith('Rappel de test') && shown[0].icon === '/icons/icon-192.png' && shown[0].tag === 'pulsetrack-reminder', JSON.stringify(shown));

  // Clic sur la notification → l'app ouvre « Nouvelle séance »
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.$eval('#note', (el) => { el.value = 'saisie en cours'; });
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const sw = await swTarget.createCDPSession();
  await sw.send('Runtime.evaluate', {
    expression: `(async () => {
      const [n] = await self.registration.getNotifications();
      self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n }));
      return true;
    })()`,
    awaitPromise: true,
  });
  await settle(1000);
  const afterClick = await page.evaluate(async () => ({
    focused: document.activeElement?.id,
    note: document.getElementById('note').value,
    open: (await (await navigator.serviceWorker.ready).getNotifications()).length,
  }));
  check('Clic : formulaire « Nouvelle séance » au premier plan, saisie conservée, notification fermée', afterClick.focused === 'type' && afterClick.note === 'saisie en cours' && afterClick.open === 0, JSON.stringify(afterClick));

  // Hors ligne : actions réseau désactivées et expliquées
  await page.setOfflineMode(true);
  await settle(300);
  const off = await page.evaluate(() => ({ enable: document.getElementById('push-enable').disabled, test: document.getElementById('push-test').disabled, status: document.getElementById('push-status').textContent }));
  check('Hors ligne : boutons désactivés, message', off.enable && off.test && off.status.includes('connexion'), off.status);
  await page.setOfflineMode(false);
  await settle(300);
  check('Retour en ligne : état réel réaffiché', (await page.$eval('#push-status', (el) => el.textContent)) === 'Rappels activés : mar. jeu. à 7 h.' && !(await page.$eval('#push-enable', (el) => el.disabled)));

  // Désactivation : abonnement retiré du serveur et du navigateur
  await page.click('#push-disable');
  await page.waitForFunction(() => document.getElementById('push-status').textContent === 'Rappels désactivés.', { timeout: 8000 });
  const deviceId = await page.evaluate(async () => (await (await idb.openDB('pulsetrack-db')).get('meta', 'deviceId')).value);
  const testAfter = await fetch(`${BASE}/api/push/test`, { method: 'POST', headers: { 'X-Device-Id': deviceId } });
  check('Désactivation : supprimé du serveur et du navigateur', testAfter.status === 404 && (await page.evaluate(() => window.__unsubscribed)) === true);

  check('Aucune erreur console', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Exécution du test', false, e.stack);
} finally {
  await browser.close();
  pushService.close();
  console.log(results.join('\n'));
}
