// Netlify Function (même origine que la PWA : aucune configuration CORS nécessaire).
// Stockage persistant : Netlify Blobs, en cohérence forte pour que If-Match lise toujours la dernière version.
import { getStore } from '@netlify/blobs';
import { createApi } from '../../server/api.mjs';

// Le store est ouvert à chaque appel (dans le contexte de la requête) ; l'API, elle, est créée une
// seule fois par instance pour que son compteur de limitation de débit survive entre les requêtes.
const blobs = () => getStore({ name: 'pulsetrack', consistency: 'strong' });
const store = {
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
const api = createApi(store);

export default (request) => api(request);

export const config = {
  path: '/api/*',
};
