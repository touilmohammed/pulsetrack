// Stockage Netlify Blobs et configuration push, partagés par les fonctions api et reminders.
// (Hors de netlify/functions/ : tout fichier de ce dossier serait déployé comme une fonction.)
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { createSender } from '../../server/push.mjs';
import { createFcmSender, fcmCredentialsFromEnv } from '../../server/fcm.mjs';

// Le store est ouvert à chaque appel, dans le contexte de la requête ; cohérence forte pour que
// If-Match lise toujours la dernière version.
const blobs = () => getStore({ name: 'pulsetrack', consistency: 'strong' });

export const store = {
  get: (key) => blobs().get(key, { type: 'json' }),
  set: (key, value) => blobs().setJSON(key, value),
  delete: (key) => blobs().delete(key),
  async list(prefix) {
    const b = blobs();
    const { blobs: entries } = await b.list({ prefix });
    const values = await Promise.all(entries.map((entry) => b.get(entry.key, { type: 'json' })));
    return values.filter(Boolean);
  },
};

// Clés VAPID (PWA) et compte de service FCM (app Android) : variables d'environnement Netlify.
// Les clés privées n'apparaissent jamais dans le dépôt ni côté client. Sans elles, les rappels
// concernés sont désactivés (503) et le reste de l'app fonctionne.
export function pushConfig() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  const web = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
  const fcmCredentials = fcmCredentialsFromEnv();
  if (!web && !fcmCredentials) return null;
  return {
    publicKey: web ? VAPID_PUBLIC_KEY : undefined,
    sendNotification: web
      ? createSender(webpush, {
        subject: VAPID_SUBJECT || 'https://pulsetrackisco.netlify.app',
        publicKey: VAPID_PUBLIC_KEY,
        privateKey: VAPID_PRIVATE_KEY,
      })
      : undefined,
    fcm: fcmCredentials ? createFcmSender(fcmCredentials) : undefined,
  };
}
