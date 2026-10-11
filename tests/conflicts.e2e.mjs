// Bonus conflits (T9) : deux onglets hors ligne modifient la même séance → 412, bannière, deux choix,
// aucune donnée perdue ; et pas de faux conflit pour deux modifications successives dans le même onglet.
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2];
const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 10000) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v || Date.now() - start > timeout) return v; await settle(200); }
}

try {
  const errors = [];
  const open = async () => {
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_INTERNET_DISCONNECTED') && !m.text().includes('412')) errors.push(m.text()); });
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE + '/', { waitUntil: 'load' });
    await p.evaluate(() => navigator.serviceWorker.ready);
    await settle();
    return p;
  };
  const a = await open();
  await a.reload({ waitUntil: 'load' });
  await settle();
  const local = (id) => a.evaluate(async (i) => (await idb.openDB('pulsetrack-db')).get('sessions', i), id);
  const outbox = () => a.evaluate(async () => (await idb.openDB('pulsetrack-db')).count('outbox'));
  const deviceId = await a.evaluate(async () => (await (await idb.openDB('pulsetrack-db')).get('meta', 'deviceId')).value);
  const remote = async (id) => (await (await fetch(`${BASE}/api/sessions/${id}`, { headers: { 'X-Device-Id': deviceId } })).json()).session;

  // Séance synchronisée de départ
  await a.type('#durationMin', '10');
  await a.type('#note', 'Séance disputée');
  await a.click('#submit-btn');
  await waitFor(async () => (await outbox()) === 0);
  const id = await a.evaluate(async () => (await (await idb.openDB('pulsetrack-db')).getAll('sessions')).find((s) => s.note === 'Séance disputée').id);
  check('Départ : séance synchronisée en version 1', (await remote(id)).version === 1);

  const b = await open();
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).createCDPSession();
  await sw.send('Network.enable');
  const setOffline = async (offline) => {
    await sw.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await a.setOfflineMode(offline);
    await b.setOfflineMode(offline);
    await settle(300);
  };
  // Un onglet en arrière-plan ne se redessine pas : on le ramène au premier plan avant d'interagir.
  async function edit(page, duration) {
    await page.bringToFront();
    await page.click(`#session-list li[data-id="${id}"] button[data-action="edit"]`);
    await settle(300);
    return async () => {
      await page.bringToFront();
      await page.$eval('#durationMin', (el) => { el.value = ''; });
      await page.type('#durationMin', String(duration));
      await page.click('#submit-btn');
      await settle(300);
    };
  }
  async function conflictRound(durA, durB) {
    await setOffline(true);
    // Les deux onglets ouvrent le formulaire sur la même version, puis enregistrent chacun la leur.
    const saveA = await edit(a, durA);
    const saveB = await edit(b, durB);
    await saveA();
    await saveB();
    const queued = await outbox();
    await setOffline(false);
    await a.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitFor(async () => (await local(id))?.syncState === 'conflict');
    return queued;
  }

  const front = () => a.bringToFront();

  // Tour 1 : conflit → « Garder la mienne »
  const queued = await conflictRound(11, 22);
  let s = await local(id);
  let r = await remote(id);
  check('T9 : deux modifications hors ligne en attente', queued === 2, `outbox=${queued}`);
  check('T9 : un 412 → séance en conflit, rien d\'écrasé', s.syncState === 'conflict' && s.durationMin === 22 && s.serverCopy?.durationMin === 11 && r.durationMin === 11 && r.version === 2,
    JSON.stringify({ local: s.durationMin, copie: s.serverCopy?.durationMin, serveur: r.durationMin, v: r.version }));
  await front();
  await settle(500);
  const li = await a.$eval(`#session-list li[data-id="${id}"]`, (el) => ({ badge: el.querySelector('.badge').textContent, btn: el.querySelector('[data-action="detail"]').textContent }));
  check('Liste : badge « Conflit » et bouton « Résoudre le conflit »', li.badge === 'Conflit' && li.btn === 'Résoudre le conflit', JSON.stringify(li));
  const toastText = await a.$eval('#toast', (el) => el.textContent);
  check('Toast : conflit signalé', toastText.includes('modifiée ailleurs'), toastText);

  // Modifier une séance en conflit renvoie vers la résolution
  await a.click(`#session-list li[data-id="${id}"] button[data-action="edit"]`);
  await a.waitForSelector('#session-detail[open]');
  const panel = await a.evaluate(() => ({
    visible: !document.getElementById('conflict-panel').hidden,
    rows: [...document.querySelectorAll('#conflict-rows tr')].map((tr) => [tr.cells[1].textContent, tr.cells[2].textContent, tr.className]),
  }));
  const duree = panel.rows.find((row) => row[0].endsWith('min'));
  check('Bannière : comparaison des deux versions, différence mise en évidence', panel.visible && duree[0] === '22 min' && duree[1] === '11 min' && duree[2] === 'differs', JSON.stringify(duree));
  check('Modifier une séance en conflit ouvre la résolution', (await a.$eval('#form-titre', (el) => el.textContent)) === 'Nouvelle séance');

  await a.click('#conflict-mine');
  await waitFor(async () => (await local(id))?.syncState === 'synced');
  s = await local(id);
  r = await remote(id);
  check('« Garder la mienne » : ma version envoyée avec le bon If-Match (v3)', r.durationMin === 22 && r.version === 3 && s.version === 3 && !s.serverCopy, JSON.stringify({ serveur: r.durationMin, v: r.version }));
  check('« Garder la mienne » : bannière fermée', await a.$eval('#conflict-panel', (el) => el.hidden));
  await a.click('#detail-close');
  await settle(300);

  // Tour 2 : conflit → « Prendre la leur »
  await b.reload({ waitUntil: 'load' });
  await settle(500);
  await conflictRound(33, 44);
  await front();
  s = await local(id);
  check('Tour 2 : nouveau conflit détecté', s.syncState === 'conflict' && s.serverCopy?.durationMin === 33);
  await a.click(`#session-list li[data-id="${id}"] button[data-action="detail"]`);
  await a.waitForSelector('#conflict-panel:not([hidden])');
  await a.click('#conflict-theirs');
  await waitFor(async () => (await local(id))?.syncState === 'synced');
  s = await local(id);
  r = await remote(id);
  check('« Prendre la leur » : version du serveur reprise, rien renvoyé', s.durationMin === 33 && r.durationMin === 33 && r.version === 4 && s.version === 4 && (await outbox()) === 0,
    JSON.stringify({ local: s.durationMin, serveur: r.durationMin, v: r.version }));
  await a.click('#detail-close');
  await settle(300);

  // Pas de faux conflit : deux modifications successives dans le même onglet, hors ligne
  await setOffline(true);
  await (await edit(a, 55))();
  await (await edit(a, 66))();
  await setOffline(false);
  await a.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(async () => (await outbox()) === 0);
  await settle(300);
  s = await local(id);
  r = await remote(id);
  check('Même onglet, deux modifications : pas de faux conflit', s.syncState === 'synced' && r.durationMin === 66 && r.version === 6, JSON.stringify({ etat: s.syncState, serveur: r.durationMin, v: r.version }));

  check('Aucune erreur console', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Exécution du test', false, e.stack);
} finally {
  await browser.close();
  console.log(results.join('\n'));
}
