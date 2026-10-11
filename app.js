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

// --- Base locale (IndexedDB) ------------------------------------------------
// IndexedDB est la source de vérité hors ligne. Les quatre stores sont créés dès la v1
// pour ne pas avoir à migrer la base aux sprints suivants.
const DB_NAME = 'pulsetrack-db';
const DB_VERSION = 1;

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

const dbPromise = window.idb
  ? idb.openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('date', 'date');
        sessions.createIndex('syncState', 'syncState');
        // Opérations en attente d'envoi (sprint 4) : opId, type, payload, baseVersion.
        const outbox = db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
        outbox.createIndex('timestamp', 'timestamp');
        // Photos réduites en Blob (sprint 6).
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('sessionId', 'sessionId');
        // deviceId, préférences, drapeaux internes.
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    },
    // Un autre onglet ouvre une version plus récente de la base : on lui laisse la place.
    blocking(currentVersion, blockedVersion, event) {
      event.target.close();
    },
  })
  : Promise.reject(new Error('Librairie idb indisponible'));

// Navigateurs anciens (iOS < 15.4) : crypto.randomUUID absent.
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function getMeta(key) {
  const entry = await (await dbPromise).get('meta', key);
  return entry ? entry.value : undefined;
}

async function setMeta(key, value) {
  await (await dbPromise).put('meta', { key, value });
}

// Identité anonyme de l'appareil : rattache les séances côté serveur (sprint 4).
async function getDeviceId() {
  let deviceId = await getMeta('deviceId');
  if (!deviceId) {
    deviceId = uuid();
    await setMeta('deviceId', deviceId);
  }
  return deviceId;
}

// Plus récentes d'abord. Les dates sont stockées en ISO UTC : l'ordre lexical est l'ordre chronologique.
async function listSessions() {
  const sessions = await (await dbPromise).getAllFromIndex('sessions', 'date');
  return sessions.reverse();
}

async function getSession(id) {
  return (await dbPromise).get('sessions', id);
}

async function saveSession(fields, id) {
  const db = await dbPromise;
  const now = new Date().toISOString();
  const existing = id ? await db.get('sessions', id) : null;
  const session = existing
    ? { ...existing, ...fields, seed: false, updatedAt: now, syncState: 'pending' }
    : {
      id: uuid(),
      ...fields,
      location: null,
      photoId: null,
      version: null, // attribuée par le serveur, utilisée par If-Match (sprint 8)
      seed: false,
      createdAt: now,
      updatedAt: now,
      syncState: 'pending', // rien n'est encore envoyé : la synchronisation arrive au sprint 4
    };
  await db.put('sessions', session);
  return session;
}

async function deleteSession(id) {
  const db = await dbPromise;
  const tx = db.transaction(['sessions', 'photos'], 'readwrite');
  const photoKeys = await tx.objectStore('photos').index('sessionId').getAllKeys(id);
  await Promise.all([
    tx.objectStore('sessions').delete(id),
    ...photoKeys.map((key) => tx.objectStore('photos').delete(key)),
  ]);
  await tx.done;
}

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
  const db = await dbPromise;
  const tx = db.transaction(['sessions', 'meta'], 'readwrite');
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

// Tout contenu saisi passe par textContent : aucune injection HTML possible.
function renderItem(session) {
  const li = document.createElement('li');
  li.dataset.id = session.id;

  const type = document.createElement('span');
  type.className = 'session-type';
  type.textContent = SESSION_TYPES[session.type] || session.type;

  const meta = document.createElement('span');
  meta.className = 'session-meta';
  const time = document.createElement('time');
  time.dateTime = session.date;
  time.textContent = dateFormat.format(new Date(session.date));
  const parts = [`${session.durationMin} min`];
  if (session.distanceKm != null) parts.push(`${kmFormat.format(session.distanceKm)} km`);
  meta.append(time, ` · ${parts.join(' · ')}`);

  li.append(type, meta);

  if (session.note) {
    const note = document.createElement('span');
    note.className = 'session-note';
    note.textContent = session.note;
    li.append(note);
  }

  const actions = document.createElement('div');
  actions.className = 'session-actions';
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
  actions.append(edit, del);
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
    await saveSession(value, sessionIdInput.value || null);
  } catch (error) {
    console.error(error);
    showError(["Impossible d'enregistrer sur cet appareil (stockage plein ou indisponible)."]);
    return;
  }
  resetForm();
  formStatus.textContent = editing ? 'Séance modifiée.' : 'Séance enregistrée sur cet appareil.';
  await refresh();
  notifyChange();
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

  if (button.dataset.action === 'edit') {
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
  }
});

// --- Démarrage --------------------------------------------------------------
resetForm();

(async () => {
  try {
    await getDeviceId();
    await importSeedsOnce();
    await refresh();
  } catch (error) {
    // Sans IndexedDB (navigation privée stricte, stockage bloqué) : les exemples du HTML restent affichés.
    console.error(error);
    formStatus.textContent = "Stockage local indisponible : les séances ne pourront pas être enregistrées sur cet appareil.";
    submitBtn.disabled = true;
  }
})();
