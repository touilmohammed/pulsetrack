// Sprint 3 : mise à jour proposée (bannière, Plus tard, SKIP_WAITING, rechargement), bandeau hors ligne.
// Usage : node test-sprint3.mjs <url> <chemin du sw.js servi (copie modifiable)>
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2];
const SW_PATH = process.argv[3];
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const original = readFileSync(SW_PATH, 'utf8');

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  let navigations = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

  // Première visite : installation sans rechargement intempestif
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await settle(1500);
  check('1re installation : aucun rechargement', navigations === 1, `navigations=${navigations}`);
  check('1re installation : pas de bannière', await page.$eval('#update-banner', (el) => el.hidden));
  const v1 = await page.$eval('#app-version', (el) => el.textContent);
  check('Version affichée', /pulsetrack-v\d+/.test(v1), v1);

  // Saisie en cours, puis « redéploiement »
  await page.type('#note', 'Saisie en cours');
  writeFileSync(SW_PATH, original.replace(/const CACHE_NAME = 'pulsetrack-v\d+';/, "const CACHE_NAME = 'pulsetrack-v99';"));
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForSelector('#update-banner:not([hidden])', { timeout: 15000 });
  check('Nouvelle version : bannière affichée', true);
  check('Nouvelle version : pas de rechargement, saisie conservée', (await page.$eval('#note', (el) => el.value)) === 'Saisie en cours' && navigations === 1);
  check('Ancienne version toujours active', (await page.$eval('#app-version', (el) => el.textContent)) === v1);

  // Plus tard : bannière masquée, revient au prochain chargement
  await page.click('#update-later');
  check('« Plus tard » masque la bannière', await page.$eval('#update-banner', (el) => el.hidden));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#update-banner:not([hidden])', { timeout: 10000 });
  check('Rechargement : la bannière revient (SW en attente)', true);

  // Mettre à jour : SKIP_WAITING → controllerchange → rechargement
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#update-apply')]);
  await settle(800);
  const after = await page.evaluate(async () => ({ keys: await caches.keys(), version: document.getElementById('app-version').textContent }));
  check('Après mise à jour : version v99', after.version === 'Version : pulsetrack-v99', after.version);
  check('Après mise à jour : anciens caches supprimés', after.keys.length === 1 && after.keys[0] === 'pulsetrack-v99', after.keys.join(','));
  check('Après mise à jour : bannière masquée', await page.$eval('#update-banner', (el) => el.hidden));

  // Bandeau hors ligne et toasts
  await page.setOfflineMode(true);
  await settle();
  const off = await page.evaluate(() => ({ banner: !document.getElementById('offline-banner').hidden, toast: document.getElementById('toast').textContent }));
  check('Hors ligne : bandeau + toast', off.banner && off.toast.includes('hors ligne'), JSON.stringify(off));
  await page.setOfflineMode(false);
  await settle();
  const on = await page.evaluate(() => ({ banner: !document.getElementById('offline-banner').hidden, toast: document.getElementById('toast').textContent }));
  check('Retour en ligne : bandeau masqué + toast', !on.banner && on.toast.includes('rétablie'), JSON.stringify(on));

  check('Aucune erreur console', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Exécution du test', false, e.stack);
} finally {
  writeFileSync(SW_PATH, original);
  await browser.close();
  console.log(results.join('\n'));
}
