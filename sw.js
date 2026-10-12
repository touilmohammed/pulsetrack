// Service Worker PulseTrack — écrit à la main (pas de Workbox).
// À incrémenter à chaque déploiement qui modifie un fichier du shell.
const CACHE_NAME = 'pulsetrack-v10';

// Base IndexedDB et rejeu de l'outbox, partagés avec la page (Background Sync).
importScripts('/vendor/idb.js', '/data.js');

// App Shell pré-caché à l'installation. sw.js n'y figure jamais :
// le navigateur doit toujours pouvoir récupérer sa nouvelle version sur le réseau.
const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  // Jumelle Markdown : lisible hors ligne. robots.txt et sitemap.xml ne servent qu'aux robots, en ligne.
  '/sessions.md',
  '/styles.css',
  '/app.js',
  '/vendor/idb.js',
  '/data.js',
  '/manifest.json',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // addAll est atomique : si un seul fichier échoue, l'installation échoue
  // et l'ancien Service Worker reste en place.
  // cache: 'reload' contourne le cache HTTP : la nouvelle version pré-cache des fichiers frais.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
  );
  // Pas de skipWaiting() automatique : la nouvelle version attend que l'utilisateur
  // accepte la mise à jour (message SKIP_WAITING), pour ne pas perdre un formulaire en cours.
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_NAME });
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('pulsetrack-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Écritures : jamais mises en cache, elles passent par l'outbox de data.js.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Autres origines : le navigateur gère seul.
  if (url.origin !== self.location.origin) return;
  // API : réseau uniquement. En cas d'échec, la page garde les données d'IndexedDB.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }
  event.respondWith(cacheFirst(request));
});

// HTML : réponse immédiate depuis le cache, revalidation en arrière-plan.
// La revalidation porte sur tout le shell et non sur la seule page : on demande au navigateur de
// vérifier sw.js. Ranger la nouvelle page dans le cache de l'ancienne version la servirait avec les
// anciens app.js et styles.css (incident de la v1.2) ; la nouvelle version pré-cache au contraire
// page et fichiers ensemble, puis la bannière propose de l'activer.
// Sans cache et sans réseau : page de secours offline.html.
async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE_NAME);
  // ignoreSearch : /?session=<id> ou /?source=pwa retrouvent le shell hors ligne.
  const cached = await cache.match(event.request, { ignoreSearch: true });

  if (cached) {
    event.waitUntil(self.registration.update().catch(() => {}));
    return cached;
  }
  // Page hors du shell : réseau, sans mise en cache (elle ne serait pas de la même version).
  try {
    return await fetch(event.request);
  } catch {
    return (await cache.match('/offline.html')) || Response.error();
  }
}

// Statique (CSS, JS, icônes) : versionné par CACHE_NAME, le réseau ne sert qu'en cas d'absence.
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

// --- Background Sync (Chromium) ---------------------------------------------
// Déclenché par le navigateur dès que le réseau revient, même page fermée.
// Si des opérations restent bloquées par le réseau, l'échec de waitUntil demande un nouvel essai.
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-pending') event.waitUntil(replayOutbox());
});

async function replayOutbox() {
  const result = await PulseData.syncPendingData();
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => client.postMessage({ type: 'SYNC_RESULT', result }));
  if (result.retry) throw new Error('Outbox non vidée : nouvel essai');
}

// --- Notifications push (rappels d'entraînement) -----------------------------
// Le serveur envoie { title, body, tag, url }. Le tag unique remplace un rappel encore affiché
// au lieu d'en empiler un second.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'PulseTrack', {
    body: data.body || "C'est l'heure de ta séance !",
    icon: '/icons/icon-192.png',
    tag: data.tag || 'pulsetrack-reminder',
    renotify: true,
    lang: 'fr',
    data: { url: data.url || '/#session-form' },
  }));
});

// Clic : on ramène l'app déjà ouverte sur « Nouvelle séance » (sans effacer une saisie en cours),
// sinon on l'ouvre directement sur le formulaire.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/#session-form', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (client) {
      try {
        await client.focus();
      } catch {
        // Focus refusé par le navigateur : le message suffit à afficher le formulaire.
      }
      client.postMessage({ type: 'OPEN_NEW_SESSION' });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
