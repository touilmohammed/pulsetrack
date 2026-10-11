// Vérifie : SW actif et contrôlant, cache pré-rempli, installabilité, hors ligne (shell, ?session, offline.html).
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://localhost:3000';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_INTERNET_DISCONNECTED')) errors.push(m.text()); });

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'load' });
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  check('Service Worker contrôle la page', controlled);

  const cacheInfo = await page.evaluate(async () => {
    const keys = await caches.keys();
    const cache = await caches.open(keys[0]);
    return { keys, urls: (await cache.keys()).map((r) => new URL(r.url).pathname) };
  });
  check('Cache versionné', cacheInfo.keys.length === 1 && /^pulsetrack-v\d+$/.test(cacheInfo.keys[0]), cacheInfo.keys.join(','));
  check('sw.js absent du cache', !cacheInfo.urls.includes('/sw.js'));
  check('Shell pré-caché', ['/', '/index.html', '/offline.html', '/app.js', '/styles.css'].every((u) => cacheInfo.urls.includes(u)), cacheInfo.urls.length + ' entrées');

  const cdp = await page.createCDPSession();
  const manifest = await cdp.send('Page.getAppManifest');
  check('Manifest sans erreur', manifest.errors.length === 0, JSON.stringify(manifest.errors));
  const inst = await cdp.send('Page.getInstallabilityErrors');
  check('Installable (aucune erreur d\'installabilité)', inst.installabilityErrors.length === 0, JSON.stringify(inst.installabilityErrors));

  // Hors ligne
  await page.setOfflineMode(true);
  // L'émulation de la page ne couvre pas le Service Worker : on coupe aussi son réseau.
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const swCdp = await swTarget.createCDPSession();
  await swCdp.send('Network.enable');
  await swCdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.reload({ waitUntil: 'load' });
  const h1 = await page.$eval('h1', (el) => el.textContent);
  const lis = await page.$$eval('#session-list li', (els) => els.length);
  const cssOk = await page.evaluate(() => getComputedStyle(document.body).fontFamily.includes('system-ui'));
  check('Hors ligne : shell affiché', h1.includes('journal sportif') && lis >= 3 && cssOk, `h1="${h1}", li=${lis}, css=${cssOk}`);

  await page.goto(BASE + '/?session=abc123', { waitUntil: 'load' });
  check('Hors ligne : /?session=<id> sert le shell', (await page.$eval('h1', (el) => el.textContent)).includes('journal sportif'));

  await page.goto(BASE + '/page-inconnue', { waitUntil: 'load' });
  check('Hors ligne : navigation échouée → offline.html', (await page.$eval('h1', (el) => el.textContent)).includes('hors ligne'));

  await page.setOfflineMode(false);
  await swCdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check('Aucune erreur console', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Exécution du test', false, e.message);
} finally {
  await browser.close();
  console.log(results.join('\n'));
}
