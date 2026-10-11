// Service Worker PulseTrack — écrit à la main (pas de Workbox).
// À incrémenter à chaque déploiement qui modifie un fichier du shell.
const CACHE_NAME = 'pulsetrack-v3';

// App Shell pré-caché à l'installation. sw.js n'y figure jamais :
// le navigateur doit toujours pouvoir récupérer sa nouvelle version sur le réseau.
const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/styles.css',
  '/app.js',
  '/vendor/idb.js',
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
  // Les écritures ne sont jamais mises en cache (outbox au sprint 4).
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Autres origines (API, CDN) : le navigateur gère seul.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(event, url));
    return;
  }
  event.respondWith(cacheFirst(request));
});

// HTML : réponse immédiate depuis le cache, mise à jour en arrière-plan.
// Sans cache et sans réseau : page de secours offline.html.
async function staleWhileRevalidate(event, url) {
  const cache = await caches.open(CACHE_NAME);
  // ignoreSearch : /?session=<id> ou /?source=pwa retrouvent le shell hors ligne.
  const cached = await cache.match(event.request, { ignoreSearch: true });

  const network = fetch(event.request).then((response) => {
    // Une réponse redirigée servie à une navigation est refusée par Safari : on ne la garde pas.
    if (response.ok && !response.redirected) {
      // Clé sans query string, pour ne pas multiplier les copies du shell.
      cache.put(url.pathname, response.clone());
    }
    return response;
  });

  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  try {
    return await network;
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
