# PulseTrack

PWA de suivi sportif offline-first : enregistrez vos séances (course, vélo, marche, musculation) sans réseau, elles se synchronisent au retour de la connexion.

TP M2 Informatique — Università di Corsica.

- **Production :** <https://pulsetrackisco.netlify.app>
- **Document technique :** [DOC-TECHNIQUE.md](DOC-TECHNIQUE.md) _(à venir, sprint 7)_
- **Sources :** <https://github.com/touilmohammed/pulsetrack>

## Lancer en local

Prérequis : Node.js 22.12 ou plus.

```bash
npm install
npm start
```

L'app et l'API sont servies sur <http://localhost:3000>, sur la même origine comme en production. En local, les données de l'API sont écrites dans `server/data/db.json` (ignoré par Git). Variables utiles : `PORT`, `DATA_FILE`.

## Architecture

| Élément | Rôle |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Vitrine publique et interface (vanilla JS, sans framework) |
| `data.js` | IndexedDB (librairie `vendor/idb.js`), outbox et synchronisation, partagé par la page et le Service Worker |
| `sw.js` | Service Worker écrit à la main : App Shell, stratégies de cache, mise à jour, Background Sync |
| `server/api.mjs` | API `/api/sessions` (idempotence par `Idempotency-Key`, `If-Match` / 412) |
| `netlify/functions/api.mjs` | L'API en production (Netlify Function + Netlify Blobs) |
| `server/server.mjs` | Serveur de développement : PWA + API, stockage dans un fichier JSON |

## Déploiement

Chaque push sur `main` déclenche un déploiement Netlify ; chaque branche dispose d'un aperçu. Le « build » (`scripts/build.mjs`) copie uniquement les fichiers publics dans `dist/` ; l'API est déployée comme Netlify Function sur `/api/*`.

Avant chaque déploiement qui touche un fichier du shell : incrémenter `CACHE_NAME` dans `sw.js`.

## Avancement

| Sprint | Contenu | Tag |
| --- | --- | --- |
| 0 | Socle et déploiement HTTPS | v0.0 |
| 1 | Installable, App Shell hors ligne | v0.1 |
| 2 | Séances locales dans IndexedDB | v0.2 |
| 3 | Mise à jour proposée, bandeau hors ligne | v0.3 |
| 4 | API, outbox et synchronisation | v0.4 |
