// Sprint 2 : IndexedDB, CRUD, validation, import unique des exemples, hors ligne, XSS.
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://localhost:3000';
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const items = (page) => page.$$eval('#session-list li', (lis) => lis.map((li) => ({
  id: li.dataset.id, seed: li.dataset.seed, type: li.querySelector('.session-type')?.textContent,
  note: li.querySelector('.session-note')?.textContent ?? '', buttons: li.querySelectorAll('button').length,
})));
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_INTERNET_DISCONNECTED')) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  // HTML initial (vu par un robot) : 3 exemples sans JS
  const html = await (await fetch(BASE + '/')).text();
  check('HTML initial : 3 <li data-seed>', (html.match(/<li data-seed/g) || []).length === 3);

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await settle();
  let list = await items(page);
  check('Exemples importés dans IndexedDB et rendus', list.length === 3 && list.every((i) => i.id && i.buttons === 3), JSON.stringify(list.map((i) => i.id)));
  const db = await page.evaluate(async () => {
    const d = await idb.openDB('pulsetrack-db');
    return { stores: [...d.objectStoreNames], deviceId: (await d.get('meta', 'deviceId'))?.value, count: await d.count('sessions') };
  });
  check('Stores sessions/outbox/photos/meta', ['meta', 'outbox', 'photos', 'sessions'].every((s) => db.stores.includes(s)), db.stores.join(','));
  check('deviceId généré', /^[0-9a-f-]{36}$/.test(db.deviceId || ''), db.deviceId);
  const dateDefault = await page.$eval('#date', (el) => el.value);
  check('Date par défaut = maintenant', dateDefault.length === 16, dateDefault);

  // Validation
  await page.$eval('#durationMin', (el) => { el.value = ''; });
  await page.click('#submit-btn');
  const err = await page.$eval('#form-error', (el) => (el.hidden ? '' : el.textContent));
  check('Validation : durée manquante refusée', err.includes('durée'), err);
  check('Validation : rien enregistré', (await items(page)).length === 3);

  // Création (avec tentative d'injection HTML dans la note)
  const evil = '<img src=x onerror="window.__xss=1">Côte <b>est</b>';
  await page.select('#type', 'marche');
  await page.type('#durationMin', '30');
  await page.type('#distanceKm', '3.456');
  await page.type('#note', evil);
  await page.click('#submit-btn');
  await settle();
  list = await items(page);
  const created = list.find((i) => i.type === 'Marche');
  check('Création : séance ajoutée', list.length === 4 && !!created);
  check('XSS : note affichée comme texte', created?.note === evil && !(await page.evaluate(() => window.__xss)) && !(await page.$('#session-list img')));
  const stored = await page.evaluate(async (id) => (await (await idb.openDB('pulsetrack-db')).get('sessions', id)), created.id);
  check('Création : champs stockés', stored.distanceKm === 3.46 && ['pending', 'synced'].includes(stored.syncState) && stored.durationMin === 30, JSON.stringify({ d: stored.distanceKm, s: stored.syncState }));

  // Rechargement : pas de réimport
  await page.reload({ waitUntil: 'load' });
  await settle();
  check('Rechargement : 4 séances, pas de doublon d\'exemples', (await items(page)).length === 4);

  // Modification
  await page.click(`#session-list li[data-id="${created.id}"] button[data-action="edit"]`);
  await settle();
  const pre = { d: await page.$eval('#durationMin', (el) => el.value), t: await page.$eval('#form-titre', (el) => el.textContent), n: await page.$eval('#note', (el) => el.value) };
  check('Édition : formulaire prérempli', pre.d === '30' && pre.t === 'Modifier la séance' && pre.n === evil, JSON.stringify(pre));
  await page.$eval('#durationMin', (el) => { el.value = ''; });
  await page.type('#durationMin', '42');
  await page.click('#submit-btn');
  await settle();
  const edited = await page.evaluate(async (id) => (await (await idb.openDB('pulsetrack-db')).get('sessions', id)), created.id);
  check('Édition : même id, durée mise à jour', edited.durationMin === 42 && (await items(page)).length === 4);
  check('Édition : formulaire réinitialisé', (await page.$eval('#form-titre', (el) => el.textContent)) === 'Nouvelle séance');

  // Filtre
  await page.select('#type-filter', 'velo');
  check('Filtre : 1 séance vélo', (await items(page)).length === 1);
  await page.select('#type-filter', '');

  // Hors ligne
  await page.setOfflineMode(true);
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const swCdp = await swTarget.createCDPSession();
  await swCdp.send('Network.enable');
  await swCdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.reload({ waitUntil: 'load' });
  await settle();
  check('Hors ligne : séances lisibles', (await items(page)).length === 4);
  await page.$eval('#durationMin', (el) => { el.value = ''; });
  await page.type('#durationMin', '20');
  await page.click('#submit-btn');
  await settle();
  check('Hors ligne : création possible', (await items(page)).length === 5);
  await page.setOfflineMode(false);
  await swCdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // Suppression de toutes les séances puis rechargement : exemples non réimportés
  // La liste peut être re-rendue (synchronisation) entre la recherche du bouton et le clic : on réessaie.
  for (let guard = 0; guard < 50; guard++) {
    const btn = await page.$('#session-list li button[data-action="delete"]');
    if (!btn) break;
    try { await btn.click(); } catch { /* bouton détaché par un re-rendu */ }
    await settle(250);
  }
  await settle(800);
  check('Suppression : liste vide + message', (await items(page)).length === 0 && !(await page.$eval('#empty-state', (el) => el.hidden)));
  await page.reload({ waitUntil: 'load' });
  await settle();
  check('Rechargement après tout supprimer : exemples non réimportés', (await items(page)).length === 0);

  const caches = await page.evaluate(async () => ({ keys: await caches.keys(), idb: !!(await caches.match('/vendor/idb.js')) }));
  check('Cache versionné contient vendor/idb.js', caches.keys.some((k) => /^pulsetrack-v\d+$/.test(k)) && caches.idb, caches.keys.join(','));

  check('Aucune erreur console', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Exécution du test', false, e.stack);
} finally {
  await browser.close();
  console.log(results.join('\n'));
}
