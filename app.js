// PulseTrack — logique de la page (vanilla JS, aucune dépendance hormis vendor/idb.js).

// --- Toasts -----------------------------------------------------------------
const toast = document.getElementById('toast');
let toastTimer = null;

function showToast(message, duration = 3500) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

// --- Réseau -----------------------------------------------------------------
// navigator.onLine peut mentir (Wi-Fi sans Internet) : il sert à l'affichage,
// les échecs réels de fetch seront traités par la synchronisation (sprint 4).
const offlineBanner = document.getElementById('offline-banner');

function updateNetworkStatus(announce) {
  const offline = !navigator.onLine;
  offlineBanner.hidden = !offline;
  if (announce) showToast(offline ? 'Connexion perdue : mode hors ligne.' : 'Connexion rétablie.');
}

window.addEventListener('online', () => updateNetworkStatus(true));
window.addEventListener('offline', () => updateNetworkStatus(true));
updateNetworkStatus(false);

// --- Service Worker et mises à jour -----------------------------------------
// Stratégie : la nouvelle version est proposée, jamais imposée. L'utilisateur peut être
// en train de saisir une séance ; un rechargement d'office perdrait son formulaire.
const updateBanner = document.getElementById('update-banner');
const appVersion = document.getElementById('app-version');
let waitingWorker = null;
let reloadAccepted = false;

function showUpdateBanner(worker) {
  waitingWorker = worker;
  updateBanner.hidden = false;
}

document.getElementById('update-apply').addEventListener('click', () => {
  if (!waitingWorker) return;
  reloadAccepted = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
});

document.getElementById('update-later').addEventListener('click', () => {
  // La bannière reviendra au prochain lancement : le Service Worker reste en attente.
  updateBanner.hidden = true;
});

function displayVersion(worker) {
  if (!worker) return;
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = (event) => {
    appVersion.textContent = `Version : ${event.data.version}`;
    appVersion.hidden = false;
  };
  worker.postMessage({ type: 'GET_VERSION' }, [port2]);
}

if ('serviceWorker' in navigator) {
  // Le nouveau Service Worker a pris le contrôle : on recharge pour charger le nouveau shell.
  // Seulement si l'utilisateur l'a demandé : la toute première installation (clients.claim)
  // déclenche aussi controllerchange, et ne doit pas recharger la page.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    displayVersion(navigator.serviceWorker.controller);
    if (reloadAccepted) window.location.reload();
  });

  // Enregistré après le chargement pour ne pas concurrencer le rendu initial.
  window.addEventListener('load', async () => {
    let registration;
    try {
      registration = await navigator.serviceWorker.register('/sw.js');
    } catch (error) {
      console.warn('Enregistrement du Service Worker impossible :', error);
      return;
    }
    displayVersion(navigator.serviceWorker.controller);

    // Une version attendait déjà (proposée puis « Plus tard », ou téléchargée en arrière-plan).
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdateBanner(registration.waiting);
    }

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        // « installed » avec un contrôleur existant = mise à jour (et non première installation).
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(worker);
        }
      });
    });

    // Une app installée reste ouverte longtemps sans navigation : on vérifie au retour au premier plan.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        registration.update().catch(() => {});
      }
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

// --- Données locales ------------------------------------------------------
// IndexedDB, outbox et synchronisation vivent dans data.js, partagé avec le Service Worker.
const {
  db, getDeviceId, listSessions, getSession, saveSession, deleteSession,
  getPhoto, countPending, syncPendingData, pullSessions,
} = PulseData;

const SESSION_TYPES = {
  course: 'Course',
  velo: 'Vélo',
  marche: 'Marche',
  musculation: 'Musculation',
  autre: 'Autre',
};
const NOTE_MAX = 500;
const DURATION_MAX = 24 * 60;
const DISTANCE_MAX = 1000;

// --- Séances d'exemple ------------------------------------------------------
// Les <li data-seed> du HTML initial servent aux robots ; on les lit avant le premier rendu.
const seedSessions = [...document.querySelectorAll('#session-list li[data-seed]')].map((li) => ({
  id: li.dataset.seed,
  type: li.dataset.type,
  date: new Date(li.dataset.date).toISOString(),
  durationMin: Number(li.dataset.duration),
  distanceKm: li.dataset.distance ? Number(li.dataset.distance) : null,
  note: li.querySelector('.session-note')?.textContent.trim() ?? '',
  location: null,
  photoId: null,
  version: null,
  seed: true, // exemple local : jamais envoyé au serveur tant qu'il n'est pas modifié
  createdAt: new Date(li.dataset.date).toISOString(),
  updatedAt: new Date(li.dataset.date).toISOString(),
  syncState: 'synced',
}));

// Import unique : base vide ET jamais importé. Le drapeau évite de réimporter les exemples
// si l'utilisateur les supprime tous. Les ids fixes (seed-1…) rendent l'import idempotent entre onglets.
async function importSeedsOnce() {
  const tx = (await db()).transaction(['sessions', 'meta'], 'readwrite');
  const sessions = tx.objectStore('sessions');
  const meta = tx.objectStore('meta');
  const [count, imported] = await Promise.all([sessions.count(), meta.get('seedsImported')]);
  if (!imported) {
    if (count === 0) await Promise.all(seedSessions.map((s) => sessions.put(s)));
    await meta.put({ key: 'seedsImported', value: true });
  }
  await tx.done;
}

// --- Validation -------------------------------------------------------------
function validateSession(raw) {
  const errors = [];
  const type = String(raw.type || '');
  if (!(type in SESSION_TYPES)) errors.push('Choisissez un type de séance.');

  const date = new Date(raw.date);
  if (!raw.date || Number.isNaN(date.getTime())) errors.push('Indiquez une date valide.');

  const durationMin = Number(raw.durationMin);
  if (!raw.durationMin || !Number.isInteger(durationMin) || durationMin <= 0 || durationMin > DURATION_MAX) {
    errors.push('La durée doit être un nombre entier de minutes, supérieur à 0.');
  }

  let distanceKm = null;
  if (raw.distanceKm !== '' && raw.distanceKm != null) {
    distanceKm = Number(raw.distanceKm);
    if (!Number.isFinite(distanceKm) || distanceKm < 0 || distanceKm > DISTANCE_MAX) {
      errors.push('La distance doit être un nombre positif (en km).');
    } else {
      distanceKm = Math.round(distanceKm * 100) / 100;
    }
  }

  const note = String(raw.note || '').trim();
  if (note.length > NOTE_MAX) errors.push(`La note ne doit pas dépasser ${NOTE_MAX} caractères.`);

  return {
    errors,
    value: errors.length ? null : { type, date: date.toISOString(), durationMin, distanceKm, note },
  };
}

// --- Affichage --------------------------------------------------------------
const form = document.getElementById('session-form');
const formTitle = document.getElementById('form-titre');
const formError = document.getElementById('form-error');
const formStatus = document.getElementById('form-status');
const submitBtn = document.getElementById('submit-btn');
const cancelEditBtn = document.getElementById('cancel-edit');
const sessionIdInput = document.getElementById('session-id');
const noteInput = document.getElementById('note');
const noteCount = document.getElementById('note-count');
const list = document.getElementById('session-list');
const emptyState = document.getElementById('empty-state');
const typeFilter = document.getElementById('type-filter');

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const kmFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
let currentSessions = [];

// Valeur attendue par <input type="datetime-local"> : heure locale, sans fuseau.
function toLocalInputValue(date) {
  const d = new Date(date);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function describe(session) {
  return `${SESSION_TYPES[session.type] || session.type} du ${dateFormat.format(new Date(session.date))}`;
}

// État de synchronisation visible sur chaque séance (US4 : savoir ce qui n'est pas encore envoyé).
const BADGES = {
  pending: ['En attente', 'badge-pending'],
  synced: ['Synchronisée', 'badge-synced'],
  conflict: ['Conflit', 'badge-conflict'],
  error: ['Refusée', 'badge-error'],
};

function renderBadge(session) {
  const [label, className] = session.seed && session.version == null
    ? ['Exemple', 'badge-seed']
    : BADGES[session.syncState] || BADGES.pending;
  const badge = document.createElement('span');
  badge.className = `badge ${className}`;
  badge.textContent = label;
  return badge;
}

// Tout contenu saisi passe par textContent : aucune injection HTML possible.
function renderItem(session) {
  const li = document.createElement('li');
  li.dataset.id = session.id;

  const head = document.createElement('span');
  head.className = 'session-head';
  const type = document.createElement('span');
  type.className = 'session-type';
  type.textContent = SESSION_TYPES[session.type] || session.type;
  head.append(type, renderBadge(session));

  const meta = document.createElement('span');
  meta.className = 'session-meta';
  const time = document.createElement('time');
  time.dateTime = session.date;
  time.textContent = dateFormat.format(new Date(session.date));
  const parts = [`${session.durationMin} min`];
  if (session.distanceKm != null) parts.push(`${kmFormat.format(session.distanceKm)} km`);
  if (session.location) parts.push('avec position');
  if (session.photoId) parts.push('avec photo');
  meta.append(time, ` · ${parts.join(' · ')}`);

  li.append(head, meta);

  if (session.syncState === 'error' && session.syncError) {
    const error = document.createElement('span');
    error.className = 'session-error';
    error.textContent = `Refusée par le serveur : ${session.syncError}`;
    li.append(error);
  }

  if (session.note) {
    const note = document.createElement('span');
    note.className = 'session-note';
    note.textContent = session.note;
    li.append(note);
  }

  const actions = document.createElement('div');
  actions.className = 'session-actions';
  const detail = document.createElement('button');
  detail.type = 'button';
  detail.className = 'btn btn-secondary';
  detail.dataset.action = 'detail';
  detail.textContent = 'Détails';
  detail.setAttribute('aria-label', `Voir la séance ${describe(session)}`);
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn-secondary';
  edit.dataset.action = 'edit';
  edit.textContent = 'Modifier';
  edit.setAttribute('aria-label', `Modifier la séance ${describe(session)}`);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-danger';
  del.dataset.action = 'delete';
  del.textContent = 'Supprimer';
  del.setAttribute('aria-label', `Supprimer la séance ${describe(session)}`);
  actions.append(detail, edit, del);
  li.append(actions);

  return li;
}

function render() {
  const filter = typeFilter.value;
  const visible = filter ? currentSessions.filter((s) => s.type === filter) : currentSessions;
  list.replaceChildren(...visible.map(renderItem));
  emptyState.hidden = visible.length > 0;
  emptyState.textContent = filter ? 'Aucune séance de ce type.' : "Aucune séance pour l'instant.";
}

async function refresh() {
  currentSessions = await listSessions();
  render();
  await updateSyncStatus();
}

// Les autres onglets ouverts rafraîchissent leur liste après chaque écriture.
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('pulsetrack') : null;
function notifyChange() {
  channel?.postMessage({ type: 'sessions-changed' });
}
channel?.addEventListener('message', (event) => {
  if (event.data?.type === 'sessions-changed') refresh();
});

// --- Formulaire -------------------------------------------------------------
function updateNoteCount() {
  noteCount.textContent = `${noteInput.value.length} / ${NOTE_MAX}`;
}

function showError(messages) {
  formError.replaceChildren(...messages.flatMap((m, i) => (i ? [document.createElement('br'), m] : [m])));
  formError.hidden = messages.length === 0;
}

function resetForm() {
  form.reset();
  sessionIdInput.value = '';
  form.elements.date.value = toLocalInputValue(new Date());
  formTitle.textContent = 'Nouvelle séance';
  submitBtn.textContent = 'Enregistrer la séance';
  cancelEditBtn.hidden = true;
  showError([]);
  updateNoteCount();
  resetCapture();
}

function startEdit(session) {
  form.elements.type.value = session.type;
  form.elements.date.value = toLocalInputValue(session.date);
  form.elements.durationMin.value = session.durationMin;
  form.elements.distanceKm.value = session.distanceKm ?? '';
  noteInput.value = session.note || '';
  sessionIdInput.value = session.id;
  formTitle.textContent = 'Modifier la séance';
  submitBtn.textContent = 'Enregistrer les modifications';
  cancelEditBtn.hidden = false;
  formStatus.textContent = '';
  showError([]);
  updateNoteCount();
  loadCapture(session);
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  form.elements.type.focus({ preventScroll: true });
}

// Validation faite en JS pour des messages homogènes ; les attributs HTML restent pour le clavier mobile.
form.noValidate = true;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = Object.fromEntries(new FormData(form));
  const { errors, value } = validateSession(raw);
  if (errors.length) {
    showError(errors);
    return;
  }
  const editing = Boolean(sessionIdInput.value);
  try {
    await saveSession({ ...value, location: formLocation }, sessionIdInput.value || null, { photo: formPhoto });
  } catch (error) {
    console.error(error);
    showError(["Impossible d'enregistrer sur cet appareil (stockage plein ou indisponible)."]);
    return;
  }
  resetForm();
  formStatus.textContent = editing ? 'Séance modifiée.' : 'Séance enregistrée sur cet appareil.';
  await refresh();
  notifyChange();
  requestSync();
});

cancelEditBtn.addEventListener('click', () => {
  resetForm();
  formStatus.textContent = '';
});

noteInput.addEventListener('input', updateNoteCount);
typeFilter.addEventListener('change', render);

list.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.closest('li').dataset.id;
  const session = await getSession(id);
  if (!session) return;

  if (button.dataset.action === 'detail') {
    openDetail(session.id);
  } else if (button.dataset.action === 'edit') {
    startEdit(session);
  } else if (button.dataset.action === 'delete') {
    if (!window.confirm(`Supprimer la séance ${describe(session)} ?`)) return;
    try {
      await deleteSession(id);
    } catch (error) {
      console.error(error);
      formStatus.textContent = 'Suppression impossible sur cet appareil.';
      return;
    }
    if (sessionIdInput.value === id) resetForm();
    formStatus.textContent = 'Séance supprimée.';
    await refresh();
    notifyChange();
    requestSync();
  }
});

// --- Capacités : règles communes ---------------------------------------------
// Aucune permission n'est demandée au chargement : chaque API n'est appelée qu'après un clic,
// et chaque bouton n'est affiché que si le navigateur offre la fonctionnalité.
// Les erreurs sont traduites en messages lisibles, jamais affichées brutes.
const captureError = document.getElementById('capture-error');

function showCaptureError(message) {
  captureError.textContent = message;
  captureError.hidden = !message;
}

// --- Capacité : géolocalisation -----------------------------------------------
const geoBtn = document.getElementById('geo-btn');
const geoStatus = document.getElementById('geo-status');
let formLocation = null;

const round5 = (n) => Math.round(n * 1e5) / 1e5;
const GEO_ERRORS = {
  1: 'Position refusée : la séance sera enregistrée sans lieu. Vous pouvez l\'autoriser dans les réglages du navigateur.',
  2: 'Position indisponible pour le moment (GPS désactivé ou sans signal). La séance peut être enregistrée sans lieu.',
  3: 'Position introuvable à temps (signal GPS faible). Réessayez à découvert.',
};

if ('geolocation' in navigator) geoBtn.hidden = false;

function renderLocation() {
  if (!formLocation) {
    geoStatus.replaceChildren();
    geoBtn.textContent = 'Ajouter ma position';
    return;
  }
  const { lat, lng, accuracy } = formLocation;
  const text = document.createElement('span');
  text.textContent = `Position ajoutée : ${lat}, ${lng}${accuracy != null ? ` (± ${accuracy} m)` : ''}`;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-secondary btn-small';
  remove.textContent = 'Retirer la position';
  remove.addEventListener('click', () => {
    formLocation = null;
    renderLocation();
  });
  geoStatus.replaceChildren(text, remove);
  geoBtn.textContent = 'Mettre à jour ma position';
}

geoBtn.addEventListener('click', () => {
  showCaptureError('');
  geoBtn.disabled = true;
  geoBtn.textContent = 'Recherche de la position…';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      // 5 décimales ≈ 1 m : assez pour une séance, inutile d'en stocker davantage.
      formLocation = { lat: round5(latitude), lng: round5(longitude), accuracy: Math.round(accuracy) };
      geoBtn.disabled = false;
      renderLocation();
    },
    (error) => {
      geoBtn.disabled = false;
      renderLocation();
      showCaptureError(GEO_ERRORS[error.code] || 'Position impossible à obtenir. La séance peut être enregistrée sans lieu.');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
});

// --- Capacité : caméra / photo ------------------------------------------------
// <input type="file" capture> ouvre l'appareil photo (mobile) ; l'autre bouton ouvre la galerie ou
// le sélecteur de fichiers. Si l'accès à la caméra est refusé, le système le signale lui-même et
// « Choisir une image » reste disponible. La photo est réduite avant d'être stockée.
const PHOTO_MAX = 1280;
const PHOTO_QUALITY = 0.8;
const cameraInput = document.getElementById('photo-camera');
const pickInput = document.getElementById('photo-pick');
const photoPreview = document.getElementById('photo-preview');
const photoPreviewImg = document.getElementById('photo-preview-img');
let formPhoto; // undefined = inchangée, null = retirée, { blob, width, height } = nouvelle
let previewUrl = null;

function showPreview(blob) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = blob ? URL.createObjectURL(blob) : null;
  photoPreviewImg.src = previewUrl || '';
  photoPreview.hidden = !blob;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
    img.src = url;
  });
}

// Réduction par canvas : 1280 px max, JPEG qualité 0,8 (une photo de téléphone passe de ~4 Mo à ~200 Ko).
async function resizeImage(file) {
  const source = 'createImageBitmap' in window ? await createImageBitmap(file) : await loadImageElement(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, PHOTO_MAX / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Conversion impossible'))), 'image/jpeg', PHOTO_QUALITY);
  });
  return { blob, width: canvas.width, height: canvas.height };
}

async function handlePhotoInput(event) {
  const file = event.target.files?.[0];
  event.target.value = ''; // permet de choisir deux fois la même image
  if (!file) return; // sélection annulée : rien à signaler
  showCaptureError('');
  if (!file.type.startsWith('image/')) {
    showCaptureError('Ce fichier n\'est pas une image.');
    return;
  }
  try {
    formPhoto = await resizeImage(file);
    showPreview(formPhoto.blob);
  } catch (error) {
    console.error(error);
    showCaptureError('Impossible de lire cette image. Essayez une photo au format JPEG ou PNG.');
  }
}

document.getElementById('photo-camera-btn').addEventListener('click', () => cameraInput.click());
document.getElementById('photo-pick-btn').addEventListener('click', () => pickInput.click());
cameraInput.addEventListener('change', handlePhotoInput);
pickInput.addEventListener('change', handlePhotoInput);
document.getElementById('photo-remove').addEventListener('click', () => {
  formPhoto = null;
  showPreview(null);
});

function resetCapture() {
  formLocation = null;
  formPhoto = undefined;
  renderLocation();
  showPreview(null);
  showCaptureError('');
}

async function loadCapture(session) {
  resetCapture();
  formLocation = session.location ?? null;
  renderLocation();
  const photo = await getPhoto(session.photoId);
  if (photo && sessionIdInput.value === session.id) showPreview(photo.blob);
}

// --- Détail d'une séance et capacité : partage ----------------------------------
// URL privée /?session=<id> : le Service Worker la sert hors ligne (ignoreSearch), le canonical
// pointe toujours vers / et robots.txt l'exclut.
const detailDialog = document.getElementById('session-detail');
const detailTitle = document.getElementById('detail-title');
const detailMeta = document.getElementById('detail-meta');
const detailNote = document.getElementById('detail-note');
const detailPhoto = document.getElementById('detail-photo');
const detailLocation = document.getElementById('detail-location');
const detailShare = document.getElementById('detail-share');
let detailPhotoUrl = null;
let shareData = null;

// Partage natif, ou copie dans le presse-papiers ; sans l'un ni l'autre, le bouton n'existe pas.
const canShare = 'share' in navigator;
const canCopy = Boolean(navigator.clipboard?.writeText);
detailShare.hidden = !canShare && !canCopy;

function sessionSummary(session) {
  const parts = [`${session.durationMin} min`];
  if (session.distanceKm != null) parts.push(`${kmFormat.format(session.distanceKm)} km`);
  const lines = [`${SESSION_TYPES[session.type] || session.type} — ${dateFormat.format(new Date(session.date))}`, parts.join(' · ')];
  if (session.note) lines.push(session.note);
  return lines.join('\n');
}

async function openDetail(id, { push = true } = {}) {
  const session = await getSession(id);
  if (!session) {
    showToast('Séance introuvable sur cet appareil.');
    history.replaceState(null, '', '/');
    return;
  }
  detailTitle.textContent = SESSION_TYPES[session.type] || session.type;
  const parts = [dateFormat.format(new Date(session.date)), `${session.durationMin} min`];
  if (session.distanceKm != null) parts.push(`${kmFormat.format(session.distanceKm)} km`);
  detailMeta.textContent = parts.join(' · ');
  detailNote.textContent = session.note || '';
  detailNote.hidden = !session.note;

  if (detailPhotoUrl) URL.revokeObjectURL(detailPhotoUrl);
  const photo = await getPhoto(session.photoId);
  detailPhotoUrl = photo ? URL.createObjectURL(photo.blob) : null;
  detailPhoto.src = detailPhotoUrl || '';
  detailPhoto.hidden = !photo;

  detailLocation.replaceChildren();
  detailLocation.hidden = !session.location;
  if (session.location) {
    const { lat, lng, accuracy } = session.location;
    const link = document.createElement('a');
    link.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'voir sur la carte';
    detailLocation.append(`Position : ${lat}, ${lng}${accuracy != null ? ` (± ${accuracy} m)` : ''} — `, link);
  }

  // Préparé à l'ouverture : navigator.share doit être appelé directement dans le clic,
  // sans attente intermédiaire (sinon Safari refuse, faute de geste utilisateur).
  const text = sessionSummary(session);
  shareData = { title: `Séance ${SESSION_TYPES[session.type] || ''} — PulseTrack`.trim(), text, url: `${location.origin}/` };
  if (photo && navigator.canShare) {
    const file = new File([photo.blob], 'seance-pulsetrack.jpg', { type: photo.blob.type || 'image/jpeg' });
    if (navigator.canShare({ files: [file] })) shareData.files = [file];
  }

  if (push && new URLSearchParams(location.search).get('session') !== id) {
    history.pushState({ session: id }, '', `/?session=${encodeURIComponent(id)}`);
  }
  if (!detailDialog.open) detailDialog.showModal();
}

async function copyShareText() {
  try {
    await navigator.clipboard.writeText(`${shareData.text}\n${shareData.url}`);
    showToast('Séance copiée dans le presse-papiers.');
  } catch {
    showToast('Copie impossible sur ce navigateur.');
  }
}

detailShare.addEventListener('click', async () => {
  if (!shareData) return;
  if (canShare) {
    try {
      await navigator.share(shareData);
      return;
    } catch (error) {
      if (error.name === 'AbortError') return; // partage annulé par l'utilisateur : rien à signaler
      // Partage refusé (fichier non accepté, contexte non autorisé) : repli sur la copie.
    }
  }
  if (canCopy) await copyShareText();
});

document.getElementById('detail-close').addEventListener('click', () => detailDialog.close());

detailDialog.addEventListener('close', () => {
  if (detailPhotoUrl) URL.revokeObjectURL(detailPhotoUrl);
  detailPhotoUrl = null;
  shareData = null;
  if (new URLSearchParams(location.search).has('session')) {
    // Ouvert depuis la liste : on revient à l'entrée précédente ; ouvert par lien direct : on nettoie l'URL.
    if (history.state?.session) history.back();
    else history.replaceState(null, '', '/');
  }
});

function openDetailFromUrl() {
  const id = new URLSearchParams(location.search).get('session');
  if (id) openDetail(id, { push: false });
  else if (detailDialog.open) detailDialog.close();
}
window.addEventListener('popstate', openDetailFromUrl);

// --- Synchronisation --------------------------------------------------------
// Chemin principal : Background Sync (Chromium) — le Service Worker rejoue l'outbox même si la page
// est fermée. Repli (Firefox, Safari) : la page rejoue l'outbox au démarrage, sur l'événement online
// et au retour au premier plan. Le verrou de data.js empêche deux rejeux simultanés.
const syncStatus = document.getElementById('sync-status');
const syncNowBtn = document.getElementById('sync-now');
let syncing = false;

async function updateSyncStatus() {
  const pending = await countPending();
  syncNowBtn.hidden = pending === 0;
  syncNowBtn.disabled = syncing;
  if (pending === 0) {
    syncStatus.textContent = '';
  } else {
    const what = pending > 1 ? `${pending} modifications en attente d'envoi` : "1 modification en attente d'envoi";
    syncStatus.textContent = navigator.onLine ? `${what}.` : `${what} : elles partiront au retour du réseau.`;
  }
}

function plural(n, word) {
  return `${n} ${word}${n > 1 ? 's' : ''}`;
}

async function handleSyncResult(result) {
  await refresh();
  notifyChange();
  if (result.sent) showToast(`${plural(result.sent, 'modification')} envoyée${result.sent > 1 ? 's' : ''} au serveur.`);
  if (result.rejected.length) {
    showToast(`${plural(result.rejected.length, 'séance')} refusée${result.rejected.length > 1 ? 's' : ''} par le serveur : ${result.rejected[0].message}`, 6000);
  }
  if (result.conflicts) showToast(`${plural(result.conflicts, 'conflit')} à résoudre.`, 6000);
}

async function runSync({ manual = false } = {}) {
  if (syncing) return;
  syncing = true;
  syncNowBtn.disabled = true;
  try {
    const result = await syncPendingData();
    await handleSyncResult(result);
    // Lecture réseau d'abord ; en cas d'échec, IndexedDB reste affichée telle quelle.
    if (!result.retry && (await pullSessions()).updated) await refresh();
    if (manual && result.retry) showToast("Serveur injoignable : nouvel essai au retour du réseau.");
  } catch (error) {
    console.error(error);
  } finally {
    syncing = false;
    await updateSyncStatus();
  }
}

async function requestSync() {
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  if (registration?.active && 'sync' in registration) {
    try {
      // Le navigateur déclenche l'événement sync dès que le réseau est disponible.
      await registration.sync.register('sync-pending');
      return;
    } catch {
      // Background Sync refusé (permission, mode navigation privée) : repli sur la page.
    }
  }
  if (navigator.onLine) runSync();
}

syncNowBtn.addEventListener('click', () => runSync({ manual: true }));
window.addEventListener('online', () => runSync());
window.addEventListener('offline', updateSyncStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && navigator.onLine) runSync();
});

// Résultat d'un rejeu fait par le Service Worker (Background Sync).
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'SYNC_RESULT') handleSyncResult(event.data.result);
});

// --- Démarrage --------------------------------------------------------------
resetForm();

(async () => {
  try {
    await getDeviceId();
    await importSeedsOnce();
    await refresh();
    openDetailFromUrl();
    if (navigator.onLine) runSync();
  } catch (error) {
    // Sans IndexedDB (navigation privée stricte, stockage bloqué) : les exemples du HTML restent affichés.
    console.error(error);
    formStatus.textContent = "Stockage local indisponible : les séances ne pourront pas être enregistrées sur cet appareil.";
    submitBtn.disabled = true;
  }
})();
