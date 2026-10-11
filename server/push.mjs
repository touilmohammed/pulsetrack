// Rappels d'entraînement par notifications push (Web Push + VAPID).
// Indépendant de l'hébergeur : l'envoi réel (librairie web-push) est injecté par l'appelant.
//
// Clé de stockage : push/<deviceId>/<id> → { id, deviceId, subscription, reminder, lastSent, createdAt }
// reminder : { days: [0-6] (0 = dimanche), hour: 6-22, timeZone: 'Europe/Paris' }

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

// Le serveur ne fait de requêtes qu'aux services de push des navigateurs : sans cette liste, n'importe qui
// pourrait faire appeler une URL arbitraire par la fonction (SSRF) en déclarant un faux « abonnement ».
const PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge (Android), Opera
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari (macOS, iOS 16.4+ installé)
  '.notify.windows.com', // Edge (Windows)
];

export function isAllowedEndpoint(endpoint, extraHosts = []) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const hosts = [...PUSH_HOSTS, ...extraHosts];
  const local = extraHosts.length > 0 && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !local) return false;
  return hosts.some((h) => (h.startsWith('.') ? url.hostname.endsWith(h) : url.hostname === h));
}

const B64URL = /^[A-Za-z0-9_-]{16,200}$/;

export function validateSubscription(body, { extraHosts = [] } = {}) {
  const errors = [];
  const sub = body?.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000 || !isAllowedEndpoint(sub.endpoint, extraHosts)) {
    errors.push('abonnement invalide (service de push inconnu)');
  }
  if (!B64URL.test(sub?.keys?.p256dh ?? '') || !B64URL.test(sub?.keys?.auth ?? '')) errors.push('clés d\'abonnement invalides');

  const r = body?.reminder ?? {};
  const days = Array.isArray(r.days) ? [...new Set(r.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  if (!days.length) errors.push('choisissez au moins un jour');
  if (!Number.isInteger(r.hour) || r.hour < 0 || r.hour > 23) errors.push('heure invalide');
  let timeZone = 'Europe/Paris';
  try {
    if (r.timeZone) timeZone = new Intl.DateTimeFormat('fr-FR', { timeZone: r.timeZone }).resolvedOptions().timeZone;
  } catch {
    errors.push('fuseau horaire invalide');
  }
  return {
    errors,
    value: errors.length ? null : {
      subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      reminder: { days, hour: r.hour, timeZone },
    },
  };
}

// Identifiant stable d'un abonnement : empreinte SHA-256 de son endpoint.
export async function subscriptionId(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Jour, heure et date locale de l'utilisateur à l'instant donné, dans son fuseau.
export function localParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { weekday, hour: Number(parts.hour), day: `${parts.year}-${parts.month}-${parts.day}` };
}

export function reminderPayload(reminder, date) {
  const { weekday } = localParts(date, reminder.timeZone);
  return {
    title: 'PulseTrack',
    body: `C'est l'heure de ta séance ! (${DAY_NAMES[weekday]}, ${reminder.hour} h)`,
    tag: 'pulsetrack-reminder',
    url: '/#session-form',
  };
}

export const testPayload = () => ({
  title: 'PulseTrack',
  body: 'Rappel de test : les notifications fonctionnent. Touchez pour noter une séance.',
  tag: 'pulsetrack-reminder',
  url: '/#session-form',
});

// Envoi Web Push : la librairie web-push prépare la requête (chiffrement aes128gcm du contenu,
// en-tête Authorization signé avec la clé VAPID), puis fetch l'envoie au service de push.
export function createSender(webpush, { subject, publicKey, privateKey }) {
  return async (subscription, payload, options = {}) => {
    const { endpoint, method, headers, body } = webpush.generateRequestDetails(subscription, payload, {
      ...options,
      vapidDetails: { subject, publicKey, privateKey },
    });
    const response = await fetch(endpoint, { method, headers, body });
    if (!response.ok) {
      const error = new Error(`Service de push : ${response.status}`);
      error.statusCode = response.status;
      error.body = await response.text().catch(() => '');
      throw error;
    }
    return { statusCode: response.status };
  };
}

// Envoi d'une notification ; un abonnement expiré (404, 410) est supprimé.
export async function deliver(store, record, payload, sendNotification) {
  try {
    await sendNotification(record.subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'normal' });
    return 'sent';
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await store.delete(`push/${record.deviceId}/${record.id}`);
      return 'expired';
    }
    console.error('Échec d\'envoi push', error.statusCode ?? '', error.body ?? error.message);
    return 'failed';
  }
}

// Appelée toutes les heures (Netlify Scheduled Function, ou minuterie du serveur local).
// Un rappel est dû si le jour et l'heure locaux correspondent ; lastSent empêche un double envoi le même jour.
export async function runReminders(store, sendNotification, now = new Date()) {
  const records = await store.list('push/');
  const summary = { checked: records.length, sent: 0, expired: 0, failed: 0 };
  for (const record of records) {
    const { reminder } = record;
    const local = localParts(now, reminder.timeZone);
    if (!reminder.days.includes(local.weekday) || local.hour !== reminder.hour || record.lastSent === local.day) continue;
    const result = await deliver(store, record, reminderPayload(reminder, now), sendNotification);
    summary[result]++;
    if (result === 'sent') await store.set(`push/${record.deviceId}/${record.id}`, { ...record, lastSent: local.day });
  }
  return summary;
}
