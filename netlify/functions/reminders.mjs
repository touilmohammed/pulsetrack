// Netlify Scheduled Function : envoie, toutes les heures, les rappels dus (jour et heure locaux
// de chaque utilisateur). Ne s'exécute que sur le déploiement de production.
import { runReminders } from '../../server/push.mjs';
import { store, pushConfig } from '../lib/netlify-store.mjs';

export default async () => {
  const push = pushConfig();
  if (!push) {
    console.log('Rappels non configurés (ni clés VAPID ni compte de service FCM).');
    return;
  }
  const summary = await runReminders(store, { web: push.sendNotification, fcm: push.fcm });
  console.log('Rappels', JSON.stringify(summary));
};

export const config = {
  schedule: '@hourly',
};
