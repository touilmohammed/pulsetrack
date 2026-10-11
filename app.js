// PulseTrack — logique de la page (vanilla JS, aucune dépendance).

// --- Service Worker ---------------------------------------------------------
// Enregistré après le chargement pour ne pas concurrencer le rendu initial.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Enregistrement du Service Worker impossible :', error);
    });
  });
}

// --- Installation -----------------------------------------------------------
const installBtn = document.getElementById('install-btn');
const iosHint = document.getElementById('ios-install-hint');
let deferredPrompt = null;

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Chromium : on garde l'événement pour déclencher l'invite au clic sur notre bouton.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  if (isStandalone()) return;
  deferredPrompt = event;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  installBtn.hidden = true;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  // L'invite n'est utilisable qu'une fois ; Chromium renverra beforeinstallprompt si besoin.
  deferredPrompt = null;
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  installBtn.hidden = true;
  iosHint.hidden = true;
});

// iOS n'émet pas beforeinstallprompt : l'installation passe par le menu Partager.
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIos && !isStandalone()) {
  iosHint.hidden = false;
}
