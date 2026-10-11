# PulseTrack

PWA de suivi sportif offline-first : enregistrez vos séances (course, vélo, marche, musculation) sans réseau, elles se synchronisent au retour de la connexion.

TP M2 Informatique — Università di Corsica.

- **Production :** <https://pulsetrackisco.netlify.app>
- **Document technique :** [DOC-TECHNIQUE.md](DOC-TECHNIQUE.md)
- **Sources :** <https://github.com/touilmohammed/pulsetrack>

## Fonctionnalités

- Journal de séances utilisable en **mode avion** (App Shell en cache, données dans IndexedDB)
- **Installable** sur l'écran d'accueil (Android, iOS, ordinateur)
- **Synchronisation** automatique au retour du réseau, sans doublon (outbox, Background Sync + repli `online`)
- **Conflits** détectés (`If-Match` / 412) et résolus par l'utilisateur : « Garder la mienne » ou « Prendre la leur »
- **Mise à jour** proposée par une bannière, jamais imposée pendant une saisie
- **Position, photo et partage** d'une séance, permissions demandées après un geste
- **Rappels d'entraînement** par notifications push (Web Push + VAPID), jours et heure au choix
- Vitrine lisible par les robots et les agents IA (JSON-LD, `robots.txt`, `sitemap.xml`, `llms.txt`, jumelle Markdown)

## Lancer en local

Prérequis : Node.js 22.12 ou plus.

```bash
npm install
npm start
```

L'app et l'API sont servies sur <http://localhost:3000>, sur la même origine comme en production, avec les en-têtes de `_headers`. Les données de l'API sont écrites dans `server/data/db.json` (ignoré par Git). Variables utiles : `PORT`, `DATA_FILE`. Des clés VAPID de développement sont générées au premier lancement dans `server/data/vapid.json`.

En production, les rappels push demandent trois variables d'environnement Netlify : `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (générées par `npx web-push generate-vapid-keys`) et `VAPID_SUBJECT` (`https://pulsetrackisco.netlify.app`).

## Tests

```bash
npm test                                   # tests unitaires de l'API + tests de bout en bout en local
npm test -- https://pulsetrackisco.netlify.app   # tests applicables contre un déploiement
```

Les tests de bout en bout pilotent un vrai navigateur sans interface (`puppeteer-core`) : Edge par défaut sous Windows, sinon indiquer `BROWSER_PATH=/chemin/vers/chrome`. Détail des 159 vérifications : [DOC-TECHNIQUE.md § 11](DOC-TECHNIQUE.md#11-mesures).

## Architecture

| Élément | Rôle |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Vitrine publique et interface (vanilla JS, sans framework) |
| `data.js` | IndexedDB (librairie `vendor/idb.js`), outbox et synchronisation, partagé par la page et le Service Worker |
| `sw.js` | Service Worker écrit à la main : App Shell, stratégies de cache, mise à jour, Background Sync |
| `server/api.mjs` | API `/api/sessions` (validation, idempotence par `Idempotency-Key`, `If-Match` / 412, limitation de débit) |
| `netlify/functions/api.mjs` | L'API en production (Netlify Function + Netlify Blobs) |
| `netlify/functions/reminders.mjs` | Rappels push : Scheduled Function horaire |
| `server/server.mjs` | Serveur de développement : PWA + API, stockage dans un fichier JSON |
| `tests/` | Tests automatisés (`npm test`) |

## Déploiement

Chaque push sur `main` déclenche un déploiement Netlify ; chaque branche dispose d'un aperçu (gratuit). Le « build » (`scripts/build.mjs`) copie uniquement les fichiers publics dans `dist/` ; l'API est déployée comme Netlify Function sur `/api/*`. Un commit qui ne touche que la documentation ne redéploie pas le site (`ignore` dans `netlify.toml`).

Avant chaque déploiement qui touche un fichier du shell : incrémenter `CACHE_NAME` dans `sw.js` et `lastmod` dans `sitemap.xml`.

## Avancement

| Sprint | Contenu | Tag |
| --- | --- | --- |
| 0 | Socle et déploiement HTTPS | v0.0 |
| 1 | Installable, App Shell hors ligne | v0.1 |
| 2 | Séances locales dans IndexedDB | v0.2 |
| 3 | Mise à jour proposée, bandeau hors ligne | v0.3 |
| 4 | API, outbox et synchronisation | v0.4 |
| 5 | Visibilité SEO et agents IA, en-têtes de sécurité | v0.5 |
| 6 | Capacités : position, photo, partage | v0.6 |
| 7 | Document technique, tests automatisés | v1.0 |
| 8 | Bonus : conflits `If-Match`, bannière de résolution | v1.1 |
| 9 | Bonus : rappels par notifications push | v1.2 |
| 10 | Finalisation : mesures en production, tests sur téléphone | v1.3 |
