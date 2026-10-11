// Netlify Function (même origine que la PWA : aucune configuration CORS nécessaire).
// Stockage : Netlify Blobs (netlify/lib/netlify-store.mjs).
import { createApi } from '../../server/api.mjs';
import { store, pushConfig } from '../lib/netlify-store.mjs';

// Créée une seule fois par instance, pour que le compteur de limitation de débit survive entre les requêtes.
const api = createApi(store, { push: pushConfig() });

export default (request) => api(request);

export const config = {
  path: '/api/*',
};
