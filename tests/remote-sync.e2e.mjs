// Synchronisation de bout en bout sur un déploiement réel (Netlify Function + Blobs).
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2];
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 20000) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v || Date.now() - start > timeout) return v; await settle(300); }
}

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_INTERNET_DISCONNECTED')) errors.push(m.text()); });
  const outbox = () => page.evaluate(async () => (await idb.openDB('pulsetrack-db')).count('outbox'));

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'load' });
  await settle();
  const deviceId = await page.evaluate(async () => (await (await idb.openDB('pulsetrack-db')).get('meta', 'deviceId')).value);
  const remote = async () => (await (await fetch(BASE + '/api/sessions', { headers: { 'X-Device-Id': deviceId } })).json()).sessions;

  await page.type('#durationMin', '33');
  await page.type('#note', 'Test en ligne');
  await page.click('#submit-btn');
  await waitFor(async () => (await outbox()) === 0);
  check('En ligne : séance stockée dans Netlify Blobs', (await remote()).some((s) => s.note === 'Test en ligne' && s.version === 1));

  await page.setOfflineMode(true);
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).createCDPSession();
  await sw.send('Network.enable');
  await sw.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.$eval('#durationMin', (el) => { el.value = ''; });
  await page.type('#durationMin', '44');
  await page.$eval('#note', (el) => { el.value = ''; });
  await page.type('#note', 'Test hors ligne');
  await page.click('#submit-btn');
  await settle();
  check('Hors ligne : en attente dans l\'outbox', (await outbox()) === 1);
  await sw.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.setOfflineMode(false);
  await waitFor(async () => (await outbox()) === 0);
  const srv = await remote();
  check('Retour en ligne : séance arrivée au serveur, sans doublon', srv.length === 2 && srv.filter((s) => s.note === 'Test hors ligne').length === 1, `server=${srv.length}`);
  check('Aucune erreur console', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Exécution du test', false, e.stack);
} finally {
  await browser.close();
  console.log(results.join('\n'));
}
