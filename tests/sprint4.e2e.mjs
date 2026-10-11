// Sprint 4 : outbox, synchronisation (online, Background Sync / repli), idempotence, serveur coupé, 4xx, pull.
// Lance son propre serveur (server/server.mjs) sur une base vierge, pour pouvoir le couper et le relancer.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.SYNC_TEST_PORT) || 3102;
const BASE = `http://localhost:${PORT}`;
const DATA_FILE = join(tmpdir(), `pulsetrack-sync-test-${process.pid}.json`);
rmSync(DATA_FILE, { force: true });

let server;
async function startServer() {
  server = spawn(process.execPath, ['server/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_FILE } });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('serveur non démarré');
}
function stopServer() {
  return new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
}

const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return v;
    await settle(200);
  }
}

await startServer();
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_')) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  const outboxCount = () => page.evaluate(async () => (await idb.openDB('pulsetrack-db')).count('outbox'));
  const local = () => page.evaluate(async () => (await idb.openDB('pulsetrack-db')).getAll('sessions'));
  const badges = () => page.$$eval('#session-list li', (lis) => Object.fromEntries(lis.map((li) => [li.dataset.id, li.querySelector('.badge')?.textContent])));
  let deviceId;
  const remote = async () => (await (await fetch(BASE + '/api/sessions', { headers: { 'X-Device-Id': deviceId } })).json()).sessions;
  async function createSession(duration, note) {
    await page.$eval('#durationMin', (el) => { el.value = ''; });
    await page.type('#durationMin', String(duration));
    await page.$eval('#note', (el) => { el.value = ''; });
    await page.type('#note', note);
    await page.click('#submit-btn');
    await settle(300);
  }

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'load' });
  await settle();
  deviceId = await page.evaluate(async () => (await (await idb.openDB('pulsetrack-db')).get('meta', 'deviceId')).value);
  check('Exemples : badge « Exemple », jamais envoyés', Object.values(await badges()).every((b) => b === 'Exemple') && (await remote()).length === 0);
  check('/api/* non mis en cache par le SW', !(await page.evaluate(async () => !!(await caches.match('/api/sessions')))));

  // 1. En ligne : envoi immédiat
  await createSession(25, 'En ligne');
  await waitFor(async () => (await outboxCount()) === 0);
  let srv = await remote();
  let loc = await local();
  const online1 = loc.find((s) => s.note === 'En ligne');
  check('En ligne : séance envoyée, version 1, badge Synchronisée',
    srv.length === 1 && srv[0].id === online1.id && online1.version === 1 && online1.syncState === 'synced'
    && (await badges())[online1.id] === 'Synchronisée', `server=${srv.length}`);

  // 2. Hors ligne : création x2, modification, suppression d'un exemple
  await page.setOfflineMode(true);
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const swCdp = await swTarget.createCDPSession();
  await swCdp.send('Network.enable');
  const swOffline = (offline) => swCdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await swOffline(true);
  await settle();
  check('Hors ligne : bandeau affiché', !(await page.$eval('#offline-banner', (el) => el.hidden)));
  await createSession(30, 'Hors ligne A');
  await createSession(40, 'Hors ligne B');
  await page.click(`#session-list li[data-id="${online1.id}"] button[data-action="edit"]`);
  await settle(300);
  await page.$eval('#durationMin', (el) => { el.value = ''; });
  await page.type('#durationMin', '99');
  await page.click('#submit-btn');
  await settle(300);
  await page.click('#session-list li[data-id="seed-1"] button[data-action="delete"]');
  await settle(300);
  const pending = await outboxCount();
  const statusText = await page.$eval('#sync-status', (el) => el.textContent);
  check('Hors ligne : 3 opérations dans l\'outbox (suppression d\'exemple non envoyée)', pending === 3, `outbox=${pending}`);
  check('Hors ligne : compteur « en attente » + bouton', statusText.startsWith('3 modifications en attente') && !(await page.$eval('#sync-now', (el) => el.hidden)), statusText);
  const b = await badges();
  check('Hors ligne : badges « En attente »', b[online1.id] === 'En attente' && Object.values(b).filter((x) => x === 'En attente').length === 3);
  check('Hors ligne : rien n\'est arrivé au serveur', (await remote()).length === 1 && (await remote())[0].durationMin === 25);

  // 3. Retour du réseau : rejeu (événement online côté page et/ou Background Sync côté SW)
  await swOffline(false);
  await page.setOfflineMode(false);
  await waitFor(async () => (await outboxCount()) === 0);
  await settle(800);
  srv = await remote();
  loc = await local();
  const ids = srv.map((s) => s.id);
  check('Retour en ligne : outbox vidée', (await outboxCount()) === 0);
  check('Retour en ligne : 3 séances au serveur, sans doublon', srv.length === 3 && new Set(ids).size === 3, `server=${srv.length}`);
  check('Retour en ligne : modification appliquée (version 2)', srv.find((s) => s.id === online1.id)?.durationMin === 99 && loc.find((s) => s.id === online1.id)?.version === 2);
  check('Retour en ligne : badges Synchronisée', loc.filter((s) => !s.seed).every((s) => s.syncState === 'synced'));
  const toastText = await page.$eval('#toast', (el) => el.textContent);
  check('Retour en ligne : toast de confirmation', toastText.includes('envoyée'), toastText);

  // 4. navigator.onLine ment : serveur injoignable alors que le navigateur se croit en ligne
  await stopServer();
  await createSession(15, 'Serveur coupé');
  await settle(1500);
  check('Serveur coupé : l\'opération reste dans l\'outbox', (await outboxCount()) === 1);
  await startServer();
  await page.click('#sync-now');
  await waitFor(async () => (await outboxCount()) === 0);
  check('Serveur relancé : « Synchroniser maintenant » envoie la séance', (await remote()).length === 4);

  // 5. Rejeu : la même opération envoyée deux fois ne crée pas de doublon
  const replay = await page.evaluate(async (dev) => {
    const opId = crypto.randomUUID();
    const body = JSON.stringify({ id: crypto.randomUUID(), type: 'marche', date: new Date().toISOString(), durationMin: 10, distanceKm: null, note: '', location: null });
    const send = () => fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': dev, 'Idempotency-Key': opId }, body });
    const a = await send(); const b2 = await send();
    return [a.status, b2.status, b2.headers.get('Idempotent-Replayed')];
  }, deviceId);
  check('Rejeu d\'une opération : pas de doublon', (await remote()).length === 5 && replay[2] === 'true', JSON.stringify(replay));

  // 6. Erreur 4xx définitive : opération retirée, séance marquée « Refusée », utilisateur prévenu
  await page.evaluate(async () => {
    const db = await idb.openDB('pulsetrack-db');
    const s = { id: crypto.randomUUID(), type: 'course', date: new Date().toISOString(), durationMin: 5, distanceKm: null, note: 'invalide', location: null, photoId: null, version: null, seed: false, syncState: 'pending' };
    await db.put('sessions', s);
    await db.add('outbox', { opId: crypto.randomUUID(), type: 'create', sessionId: s.id, payload: { ...s, durationMin: -1 }, baseVersion: null, timestamp: Date.now() });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(async () => (await outboxCount()) === 0);
  await settle(300);
  const rejected = (await local()).find((s) => s.note === 'invalide');
  check('4xx : séance marquée « Refusée », file non bloquée', rejected?.syncState === 'error' && (await outboxCount()) === 0, rejected?.syncError);
  check('4xx : message affiché', (await page.$eval('#toast', (el) => el.textContent)).includes('refusée'));

  // 7. Lecture réseau d'abord : une séance présente au serveur seulement apparaît au chargement
  await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
    body: JSON.stringify({ id: crypto.randomUUID(), type: 'velo', date: new Date().toISOString(), durationMin: 77, distanceKm: 20, note: 'Depuis le serveur', location: null }) });
  await page.reload({ waitUntil: 'load' });
  await waitFor(async () => (await local()).some((s) => s.note === 'Depuis le serveur'));
  check('Pull : séance du serveur importée et affichée', (await page.$$eval('#session-list .session-note', (n) => n.map((x) => x.textContent))).includes('Depuis le serveur'));

  // 8. Background Sync : la page reste « hors ligne » (son repli ne peut pas agir),
  // seul l'événement sync du Service Worker peut vider l'outbox.
  const cdp = await page.createCDPSession();
  const registrations = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => registrations.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');
  await settle(300);
  await page.setOfflineMode(true);
  await swOffline(true);
  await settle(300);
  await createSession(12, 'Background Sync');
  check('BG Sync : opération en attente', (await outboxCount()) === 1);
  const before = (await remote()).length;
  await swOffline(false); // réseau rendu au SW seulement
  const reg = registrations.find((r) => !r.isDeleted);
  await cdp.send('ServiceWorker.dispatchSyncEvent', { origin: BASE, registrationId: reg.registrationId, tag: 'sync-pending', lastChance: false });
  await waitFor(async () => (await outboxCount()) === 0);
  await settle(500);
  check('BG Sync : le Service Worker a vidé l\'outbox', (await outboxCount()) === 0 && (await remote()).length === before + 1);
  check('BG Sync : la page est prévenue (SYNC_RESULT → toast, badge)', (await page.$eval('#toast', (el) => el.textContent)).includes('envoyée')
    && Object.values(await badges()).every((x) => x !== 'En attente'));
  await page.setOfflineMode(false);

  check('Aucune erreur console', errors.filter((e) => !e.includes('422')).length === 0, errors.join(' | '));
} catch (e) {
  check('Exécution du test', false, e.stack);
} finally {
  await browser.close();
  await stopServer();
  console.log(results.join('\n'));
}
