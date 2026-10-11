// Service Worker PulseTrack — écrit à la main (pas de Workbox).
// À incrémenter à chaque déploiement qui modifie un fichier du shell.
const CACHE_NAME = 'pulsetrack-v1';

// App Shell pré-caché à l'installation. sw.js n'y figure jamais :
// le navigateur doit toujours pouvoir récupérer sa nouvelle version sur le réseau.
const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/styles.css',
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
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  // Pas de skipWaiting() automatique : la mise à jour sera proposée à l'utilisateur (sprint 3).
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
