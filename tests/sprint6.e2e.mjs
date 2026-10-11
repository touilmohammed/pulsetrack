// Sprint 6 : capacités (géolocalisation, photo, partage), refus gérés, détail /?session=<id>.
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2];
const browser = await puppeteer.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

try {
  const context = browser.defaultBrowserContext();
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_INTERNET_DISCONNECTED')) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  // Instrumentation : compter les appels aux API à permission, et simuler partage / presse-papiers.
  await page.evaluateOnNewDocument(() => {
    window.__calls = { geo: 0, share: [], clipboard: [] };
    const realGet = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (...a) => { window.__calls.geo++; return realGet(...a); };
    navigator.share = async (data) => {
      window.__calls.share.push({ title: data.title, text: data.text, url: data.url, files: (data.files || []).length });
      if (window.__shareMode === 'abort') throw new DOMException('annulé', 'AbortError');
      if (window.__shareMode === 'fail') throw new DOMException('refusé', 'NotAllowedError');
    };
    navigator.canShare = () => true;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__calls.clipboard.push(t); } } });
  });

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'load' });
  await settle();
  check('Aucune permission demandée au chargement', (await page.evaluate(() => window.__calls.geo)) === 0);
  check('Boutons affichés après détection', !(await page.$eval('#geo-btn', (el) => el.hidden)) && !(await page.$eval('#detail-share', (el) => el.hidden)));

  // Géolocalisation refusée
  await cdp.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: BASE });
  await page.click('#geo-btn');
  await page.waitForSelector('#capture-error:not([hidden])', { timeout: 5000 });
  const denied = await page.$eval('#capture-error', (el) => el.textContent);
  check('Position refusée : message clair, pas d\'erreur brute', denied.startsWith('Position refusée') && !/PERMISSION|code/i.test(denied), denied);
  check('Position refusée : bouton toujours disponible', !(await page.$eval('#geo-btn', (el) => el.disabled || el.hidden)));

  // Géolocalisation acceptée
  await cdp.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'granted', origin: BASE });
  await page.setGeolocation({ latitude: 42.3061234567, longitude: 9.1500987654, accuracy: 12.4 });
  await page.click('#geo-btn');
  await page.waitForFunction(() => document.getElementById('geo-status').textContent.includes('Position ajoutée'), { timeout: 5000 });
  const geoText = await page.$eval('#geo-status', (el) => el.textContent);
  check('Position acceptée : coordonnées arrondies à 5 décimales', geoText.includes('42.30612, 9.1501') && geoText.includes('± 12 m'), geoText);
  check('Position acceptée : message d\'erreur effacé', await page.$eval('#capture-error', (el) => el.hidden));

  // Photo : une grande image (3000 x 2000) est réduite à 1280 px en JPEG
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
    const g = c.getContext('2d'); g.fillStyle = '#0f766e'; g.fillRect(0, 0, 3000, 2000); g.fillStyle = '#fff'; g.fillRect(1000, 600, 1000, 800);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'grande.png', { type: 'image/png' }));
    const input = document.getElementById('photo-pick'); input.files = dt.files; input.dispatchEvent(new Event('change'));
  });
  await page.waitForSelector('#photo-preview:not([hidden])', { timeout: 5000 });
  check('Photo : aperçu affiché', true);

  // Fichier non image
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['bonjour'], 'note.txt', { type: 'text/plain' }));
    const input = document.getElementById('photo-pick'); input.files = dt.files; input.dispatchEvent(new Event('change'));
  });
  await settle(200);
  check('Fichier non image : message, photo précédente conservée', (await page.$eval('#capture-error', (el) => el.textContent)).includes('pas une image') && !(await page.$eval('#photo-preview', (el) => el.hidden)));

  // Enregistrement
  await page.type('#durationMin', '50');
  await page.type('#note', 'Avec position et photo');
  await page.click('#submit-btn');
  await settle(800);
  const saved = await page.evaluate(async () => {
    const db = await idb.openDB('pulsetrack-db');
    const s = (await db.getAll('sessions')).find((x) => x.note === 'Avec position et photo');
    const p = await db.get('photos', s.photoId);
    const op = (await db.getAll('outbox')).find((o) => o.sessionId === s.id);
    return { location: s.location, photo: p && { w: p.width, h: p.height, type: p.blob.type, size: p.blob.size, sessionId: p.sessionId === s.id }, id: s.id, opPayloadKeys: op ? Object.keys(op.payload) : null };
  });
  check('Photo réduite à 1280 px, JPEG, liée à la séance', saved.photo?.w === 1280 && saved.photo?.h === 853 && saved.photo.type === 'image/jpeg' && saved.photo.sessionId, JSON.stringify(saved.photo));
  check('Position stockée dans la séance', saved.location?.lat === 42.30612 && saved.location?.lng === 9.1501 && saved.location?.accuracy === 12);
  check('Formulaire réinitialisé (position et photo retirées)', (await page.$eval('#geo-status', (el) => el.textContent)) === '' && (await page.$eval('#photo-preview', (el) => el.hidden)));
  const meta = await page.$eval(`#session-list li[data-id="${saved.id}"] .session-meta`, (el) => el.textContent);
  check('Liste : mention position et photo', meta.includes('avec position') && meta.includes('avec photo'), meta);

  // Photo jamais envoyée au serveur : attendre la synchro puis lire l'API
  await page.waitForFunction(async () => (await (await idb.openDB('pulsetrack-db')).count('outbox')) === 0, { timeout: 10000 });
  const deviceId = await page.evaluate(async () => (await (await idb.openDB('pulsetrack-db')).get('meta', 'deviceId')).value);
  const remote = (await (await fetch(BASE + '/api/sessions', { headers: { 'X-Device-Id': deviceId } })).json()).sessions.find((s) => s.id === saved.id);
  check('Serveur : position reçue, aucune photo', remote?.location?.lat === 42.30612 && !('photoId' in remote) && !JSON.stringify(remote).includes('blob'));

  // Détail + URL privée
  await page.click(`#session-list li[data-id="${saved.id}"] button[data-action="detail"]`);
  await page.waitForSelector('#session-detail[open]');
  const detail = await page.evaluate(() => ({
    url: location.search, title: document.getElementById('detail-title').textContent,
    photo: !document.getElementById('detail-photo').hidden && document.getElementById('detail-photo').naturalWidth,
    loc: document.getElementById('detail-location').textContent, osm: document.querySelector('#detail-location a')?.href,
  }));
  check('Détail : URL /?session=<id>', detail.url === `?session=${saved.id}`);
  check('Détail : photo, position et lien carte', detail.photo === 1280 && detail.loc.includes('42.30612') && detail.osm.includes('mlat=42.30612'), JSON.stringify(detail));

  // Partage natif (avec la photo en fichier)
  await page.click('#detail-share');
  await settle(200);
  const share = await page.evaluate(() => window.__calls.share.at(-1));
  check('Partage natif : texte, lien et photo', share?.text.includes('50 min') && share.text.includes('Avec position et photo') && share.url === BASE + '/' && share.files === 1, JSON.stringify(share));
  // Partage annulé : silencieux
  await page.evaluate(() => { window.__shareMode = 'abort'; });
  await page.click('#detail-share');
  await settle(200);
  check('Partage annulé : aucune copie, aucun message', (await page.evaluate(() => window.__calls.clipboard.length)) === 0);
  // Partage refusé : repli presse-papiers
  await page.evaluate(() => { window.__shareMode = 'fail'; });
  await page.click('#detail-share');
  await settle(200);
  const clip = await page.evaluate(() => window.__calls.clipboard.at(-1));
  check('Partage refusé : repli presse-papiers + toast', clip?.includes('Avec position et photo') && clip.includes(BASE + '/') && (await page.$eval('#toast', (el) => el.textContent)).includes('presse-papiers'));

  // Fermeture : retour à /
  await page.click('#detail-close');
  await settle(400);
  check('Fermeture : dialog fermé, URL revenue à /', !(await page.$('#session-detail[open]')) && (await page.evaluate(() => location.search)) === '');

  // Lien direct /?session=<id>, hors ligne
  await page.setOfflineMode(true);
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).createCDPSession();
  await sw.send('Network.enable');
  await sw.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.goto(`${BASE}/?session=${saved.id}`, { waitUntil: 'load' });
  await page.waitForSelector('#session-detail[open]', { timeout: 5000 });
  check('Hors ligne : lien /?session=<id> ouvre le détail avec la photo', await page.$eval('#detail-photo', (el) => !el.hidden && el.naturalWidth === 1280));
  await sw.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.setOfflineMode(false);

  // Édition : photo et position préchargées, puis retrait de la photo
  await page.click('#detail-close');
  await settle(300);
  await page.click(`#session-list li[data-id="${saved.id}"] button[data-action="edit"]`);
  await page.waitForSelector('#photo-preview:not([hidden])', { timeout: 5000 });
  check('Édition : position et photo préchargées', (await page.$eval('#geo-status', (el) => el.textContent)).includes('42.30612'));
  await page.click('#photo-remove');
  await page.click('#submit-btn');
  await settle(600);
  const after = await page.evaluate(async (id) => {
    const db = await idb.openDB('pulsetrack-db');
    return { photoId: (await db.get('sessions', id)).photoId, photos: await db.count('photos') };
  }, saved.id);
  check('Retrait de la photo : référence et Blob supprimés', after.photoId === null && after.photos === 0, JSON.stringify(after));

  // Public : aucune coordonnée dans le HTML initial
  const html = await (await fetch(BASE + '/')).text();
  check('HTML public : aucune coordonnée, toujours 3 <li>', !html.includes('42.30612') && (html.match(/<li[ >]/g) || []).length === 3);

  check('Aucune erreur console', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Exécution du test', false, e.stack);
} finally {
  await browser.close();
  console.log(results.join('\n'));
}
