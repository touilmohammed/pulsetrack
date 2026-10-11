// Netlify Function (même origine que la PWA : aucune configuration CORS nécessaire).
// Stockage persistant : Netlify Blobs, en cohérence forte pour que If-Match lise toujours la dernière version.
import { getStore } from '@netlify/blobs';
import { createApi } from '../../server/api.mjs';

function blobsStore() {
  const blobs = getStore({ name: 'pulsetrack', consistency: 'strong' });
  return {
    get: (key) => blobs.get(key, { type: 'json' }),
    set: (key, value) => blobs.setJSON(key, value),
    delete: (key) => blobs.delete(key),
    async list(prefix) {
      const { blobs: entries } = await blobs.list({ prefix });
      const values = await Promise.all(entries.map((entry) => blobs.get(entry.key, { type: 'json' })));
      return values.filter(Boolean);
    },
  };
}

export default async (request) => createApi(blobsStore())(request);

export const config = {
  path: '/api/*',
};
