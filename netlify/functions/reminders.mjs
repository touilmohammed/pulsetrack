// Netlify Scheduled Function : envoie, toutes les heures, les rappels dus (jour et heure locaux
// de chaque utilisateur). Ne s'exécute que sur le déploiement de production.
import { runReminders } from '../../server/push.mjs';
import { store, pushConfig } from '../lib/netlify-store.mjs';

export default async () => {
  const push = pushConfig();
  if (!push) {
    console.log('Rappels non configurés (clés VAPID absentes).');
    return;
  }
  const summary = await runReminders(store, push.sendNotification);
  console.log('Rappels', JSON.stringify(summary));
};

export const config = {
  schedule: '@hourly',
};
