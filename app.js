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
