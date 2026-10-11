// Stockage Netlify Blobs et configuration push, partagés par les fonctions api et reminders.
// (Hors de netlify/functions/ : tout fichier de ce dossier serait déployé comme une fonction.)
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { createSender } from '../../server/push.mjs';

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

// Clés VAPID : variables d'environnement Netlify (la clé privée n'apparaît jamais dans le dépôt
// ni côté client). Sans elles, les rappels sont désactivés (503) et le reste de l'app fonctionne.
export function pushConfig() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: VAPID_PUBLIC_KEY,
    sendNotification: createSender(webpush, {
      subject: VAPID_SUBJECT || 'https://pulsetrackisco.netlify.app',
      publicKey: VAPID_PUBLIC_KEY,
      privateKey: VAPID_PRIVATE_KEY,
    }),
  };
}
