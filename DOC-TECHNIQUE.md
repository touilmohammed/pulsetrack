# PulseTrack — Document technique

**PWA de suivi sportif hors ligne** · TP M2 Informatique, Università di Corsica · octobre 2026

| | |
| --- | --- |
| Application | <https://pulsetrackisco.netlify.app> |
| Dépôt | <https://github.com/touilmohammed/pulsetrack> |
| Version décrite | `v1.0` (cache `pulsetrack-v6`) |
| Lancer en local | `npm install && npm start` → <http://localhost:3000> |
| Tests | `npm test` (144 vérifications automatisées, voir § 11) |

---

## 1. TL;DR

PulseTrack est un journal d'entraînement (course, vélo, marche, musculation) qui fonctionne **sans réseau** : on saisit, modifie et consulte ses séances en mode avion, et elles partent au serveur au retour de la connexion, **sans doublon ni écrasement silencieux**.

- **Vanilla JS, sans framework ni build** : le HTML initial contient la vitrine publique (lisible par Googlebot et les agents IA sans exécuter de JavaScript) et chaque ligne du Service Worker est écrite à la main.
- **Offline-first** : App Shell pré-caché par un Service Worker manuel (pas de Workbox), données dans IndexedDB (librairie `idb`, copiée dans le dépôt), outbox rejouée par Background Sync avec repli sur l'événement `online`.
- **Synchronisation fiable** : écriture locale et opération d'envoi dans la même transaction, identifiant d'opération (`Idempotency-Key`) pour qu'un rejeu ne soit jamais appliqué deux fois.
- **Conflits réconciliés** (bonus) : `If-Match` / 412, bannière « Garder la mienne / Prendre la leur », aucune donnée perdue.
- **Mise à jour proposée, jamais imposée** : bannière « Nouvelle version disponible » pour ne pas perdre un formulaire en cours.
- **Trois capacités de l'appareil** : géolocalisation (capacité principale), caméra / photo, partage — chacune après un geste, refus géré par un message.
- **Rappels d'entraînement par vrai push** (bonus) : Web Push + VAPID, jours et heure au choix, clic sur la notification → « Nouvelle séance ».
- **Mesures en production** : Lighthouse mobile 100 en Performance, Accessibilité, Bonnes pratiques et SEO ; JSON-LD sans erreur ; 144 tests automatisés au vert.

## 2. Contexte

**Besoin.** Des sportifs amateurs s'entraînent là où le réseau est mauvais — sentiers corses, forêt, salle en sous-sol. Ils doivent pouvoir noter leur séance à l'arrivée, sans réseau, et la retrouver plus tard : **zéro perte de séance** est l'objectif central.

**Utilisateurs.** Le pratiquant régulier (journal fiable hors ligne, installé sur l'écran d'accueil) et le visiteur public, humain ou robot, qui découvre l'app par sa page d'accueil.

**Contraintes du TP.** PWA déployée, installable, hors ligne, avec mise à jour maîtrisée, synchronisation, visibilité pour les robots et au moins une capacité de l'appareil. Les permissions sont demandées après un geste de l'utilisateur et un refus produit un message, pas une erreur.

**Hors périmètre (choix assumés).** Pas de comptes : une identité anonyme par appareil (UUID aléatoire) suffit. Pas de carte interactive ni de tuiles hors ligne (seules les coordonnées sont stockées), pas d'import GPX, pas de réseau social, pas de publication sur les stores.

**Critères de succès retenus** (détail des mesures au § 11) : manifest sans erreur, Lighthouse SEO 100 et Performance ≥ 90, shell et données en mode avion, 100 % des séances hors ligne arrivées au serveur sans doublon, JSON-LD sans erreur.

## 3. Architecture

La page ne parle jamais au réseau pour afficher ses données : **IndexedDB est la source de vérité locale**. Le Service Worker sert le shell depuis la Cache API et rejoue l'outbox ; l'API ne fait que recevoir et renvoyer.

```
┌──────────────────────────── Navigateur ────────────────────────────┐
│  index.html (vitrine + app)                                          │
│  app.js ── UI, formulaire, capacités, bannières, déclenchement sync  │
│     │                                                                │
│  data.js ── IndexedDB (idb) · outbox · syncPendingData · pull        │◄─┐ partagé
│     │                                                                │  │ (importScripts)
│  IndexedDB « pulsetrack-db » : sessions · outbox · photos · meta     │  │
│                                                                      │  │
│  sw.js ── install / activate / fetch (Cache API) / message / sync ───┼──┘
└──────────────┬───────────────────────────────────────┬──────────────┘
               │ fichiers statiques                     │ /api/* (même origine)
     ┌─────────▼──────────┐                 ┌───────────▼────────────────┐
     │ Netlify CDN (dist/) │                 │ Netlify Function api.mjs    │
     │ _headers            │                 │  → server/api.mjs           │
     └────────────────────┘                 │  → Netlify Blobs            │
                                             └────────────────────────────┘
```

### 3.1 Choix techniques

| Choix | Raison |
| --- | --- |
| HTML, CSS, JavaScript **sans framework** | HTML initial lisible par les robots, aucun build, JS initial minimal (≈ 16 Ko gzip au total : `app.js`, `data.js`, `idb.js`) |
| **Service Worker manuel**, pas de Workbox | Chaque stratégie de cache est explicite et justifiable (§ 4) |
| **`idb` 8.0.4 copiée** dans `vendor/idb.js` (build UMD) | API à promesses sur IndexedDB ; pas de CDN, donc disponible hors ligne et compatible avec une CSP `script-src 'self'` ; l'UMD expose la globale `idb`, chargeable par `<script>` **et** par `importScripts` dans le Service Worker |
| **`data.js` partagé** page / Service Worker | Une seule implémentation de la base et du rejeu de l'outbox, utilisée par la page (repli) et par le Service Worker (Background Sync) |
| **API en Netlify Function**, même origine | Pas de CORS à configurer, pas de second hébergeur qui s'endort ; stockage persistant Netlify Blobs (cohérence forte) |
| **`server/api.mjs` indépendant de l'hébergeur** | Reçoit une `Request`, renvoie une `Response`, stockage injecté : la même API tourne sur Netlify (Blobs) et en local (`server/server.mjs`, fichier JSON) |
| Netlify pour le statique | HTTPS, `_headers`, aperçu gratuit par branche ; `scripts/build.mjs` ne publie que les fichiers publics (liste blanche) |

### 3.2 Arborescence

```
index.html  offline.html  styles.css  manifest.json
app.js          UI, capacités, mises à jour, déclenchement de la synchronisation
data.js         IndexedDB, outbox, synchronisation (page + Service Worker)
sw.js           Service Worker
vendor/idb.js   librairie idb (copie locale, licence ISC)
icons/ images/  icônes 32/192/512/maskable/apple-touch, image Open Graph
robots.txt  sitemap.xml  llms.txt  sessions.md  _headers
server/api.mjs            API (validation, idempotence, If-Match, limitation de débit)
server/server.mjs         serveur local : PWA + API sur la même origine
server/store-file.mjs     stockage local (JSON)
server/push.mjs           rappels push : abonnements, calcul des rappels dus, envoi Web Push
netlify/functions/api.mjs l'API en production (Netlify Blobs)
netlify/functions/reminders.mjs  Scheduled Function horaire (rappels)
netlify/lib/              stockage Blobs et configuration VAPID partagés par les deux fonctions
scripts/build.mjs         copie des fichiers publics dans dist/
tests/                    tests automatisés (npm test)
```

## 4. Stratégies de cache

Fichier : [`sw.js`](sw.js). Un seul cache versionné, `CACHE_NAME = 'pulsetrack-v6'`.

| Ressource | Stratégie | Stockage | Pourquoi |
| --- | --- | --- | --- |
| Navigation (HTML) | **Stale While Revalidate** + `ignoreSearch` | Cache API | Affichage instantané depuis le cache, nouvelle version récupérée en arrière-plan |
| CSS, JS, icônes, manifest | **Cache First** | Cache API | Fichiers versionnés par `CACHE_NAME` : le réseau ne sert qu'en cas d'absence |
| Navigation échouée (ni cache ni réseau) | Repli **`offline.html`** | Cache API | Page de secours au lieu de l'erreur du navigateur |
| Lecture `/api/*` | **Réseau uniquement** dans le SW, **repli IndexedDB** dans la page | IndexedDB | Données fraîches si possible ; sinon la page affiche déjà la base locale |
| Écritures (`POST`, `PUT`, `DELETE`) | **Jamais en cache** → outbox | IndexedDB | Une écriture hors ligne est une opération à rejouer, pas une réponse à servir |
| Autres origines | Non interceptées | — | Aucune ressource externe n'est utilisée |

**App Shell pré-caché** à l'installation (14 entrées) : `/`, `/index.html`, `/offline.html`, `/sessions.md`, `/styles.css`, `/app.js`, `/vendor/idb.js`, `/data.js`, `/manifest.json` et les 5 icônes.

Points de détail, tous visibles dans `sw.js` :

- **`sw.js` n'est jamais pré-caché** : le navigateur doit toujours pouvoir comparer le fichier du serveur pour détecter une mise à jour. `_headers` lui impose `Cache-Control: no-cache`.
- **`cache.addAll` est atomique** : si un seul fichier manque, l'installation échoue et l'ancienne version reste en place.
- **Pré-cache en `cache: 'reload'`** : la nouvelle version télécharge des fichiers frais au lieu de recopier ceux du cache HTTP du navigateur.
- **`ignoreSearch: true`** : `/?session=<id>` (détail d'une séance) retrouve le shell hors ligne ; la copie est rangée sous la clé `url.pathname` pour ne pas multiplier les copies du HTML.
- **Réponses redirigées non mises en cache** : Safari refuse de les servir à une navigation.
- **`/api/*` ignoré par le `fetch`** : une réponse d'API en cache serait périmée et masquerait l'état réel du serveur ; la lecture « réseau d'abord, repli IndexedDB » est faite par `pullSessions()` dans `data.js`, qui sait fusionner sans écraser une modification en attente.

**Indicateur hors ligne.** `navigator.onLine` peut mentir (Wi-Fi sans Internet) : il ne sert qu'à l'affichage (bandeau « Mode hors ligne », toasts). La décision « réessayer plus tard » repose sur l'échec réel du `fetch` dans `syncPendingData()`.

## 5. Mise à jour

**Stratégie : la mise à jour est proposée à l'utilisateur, jamais imposée.** L'utilisateur peut être en train de saisir une séance ; recharger d'office la page perdrait son formulaire.

Mécanisme ([`sw.js`](sw.js), section « Service Worker et mises à jour » de [`app.js`](app.js)) :

1. À chaque déploiement qui touche le shell, `CACHE_NAME` est incrémenté (v1 → v6 sur ce projet).
2. Le navigateur détecte un `sw.js` différent ; le nouveau Service Worker s'installe et **attend** : pas de `skipWaiting()` automatique.
3. La page écoute `updatefound` puis `statechange` ; à l'état `installed` **avec un contrôleur existant** (donc une mise à jour, pas la première installation), elle affiche la bannière.
4. « Mettre à jour » envoie `postMessage({ type: 'SKIP_WAITING' })` ; le Service Worker appelle `skipWaiting()`, puis `activate` supprime les anciens caches `pulsetrack-*` et appelle `clients.claim()`.
5. La page recharge sur `controllerchange` — **seulement si l'utilisateur l'a demandé** (`reloadAccepted`). Sans cette garde, la toute première installation (`clients.claim()` déclenche aussi `controllerchange`) rechargerait la page sans raison.
6. « Plus tard » masque la bannière ; le Service Worker reste en attente et la bannière revient au prochain lancement (`registration.waiting`).

Une app installée reste ouverte longtemps sans naviguer : la page appelle `registration.update()` à chaque retour au premier plan (`visibilitychange`). La version active est affichée en pied de page (message `GET_VERSION` au Service Worker).

**Validation** : redéploiement v5 → v6 sur iPhone avec l'app ouverte et une note en cours de saisie : bannière affichée, note conservée, rechargement sur « Mettre à jour », pied de page en v6. Le test automatisé `tests/sprint3.e2e.mjs` rejoue ce scénario (14 vérifications).

## 6. Données et synchronisation

### 6.1 Modèle IndexedDB (`pulsetrack-db`, version 1)

Les quatre stores existent dès la version 1, pour ne pas avoir à migrer la base.

| Store | Clé | Index | Contenu |
| --- | --- | --- | --- |
| `sessions` | `id` (UUID client) | `date`, `syncState` | Séances de l'utilisateur |
| `outbox` | `id` (autoIncrement) | `timestamp` | Opérations en attente : `opId`, `type` (`create`, `update`, `delete`), `sessionId`, `payload`, `baseVersion` |
| `photos` | `id` | `sessionId` | Photos réduites, en Blob |
| `meta` | `key` | — | `deviceId`, drapeau `seedsImported` |

**Une séance** : `id`, `type` (`course`, `velo`, `marche`, `musculation`, `autre`), `date` (ISO 8601 UTC), `durationMin` (entier > 0), `distanceKm` (≥ 0, facultatif), `note` (≤ 500 caractères), `location` (`{lat, lng, accuracy}`, facultatif), `photoId`, `version` (attribuée par le serveur), `createdAt`, `updatedAt`, `syncState`.

`syncState` vaut `pending` (en attente d'envoi), `synced`, `conflict` (412 reçu) ou `error` (refusée définitivement par le serveur, voir 6.3). L'identifiant est généré côté client : rejouer une création ne peut pas créer une seconde séance. Champs locaux de détection des conflits : `localRev`, `serverRev`, et `serverCopy` pendant un conflit (§ 6.7).

**Séances d'exemple.** Les trois `<li data-seed>` du HTML (pour les robots) sont importés une seule fois dans IndexedDB, si la base est vide **et** que le drapeau `seedsImported` est absent : sans ce drapeau, supprimer toutes ses séances ferait réapparaître les exemples. Leurs identifiants fixes (`seed-1`…) rendent l'import idempotent entre onglets. Ils sont marqués `seed: true` et ne partent jamais au serveur tant qu'ils ne sont pas modifiés.

### 6.2 Écriture locale d'abord

`saveSession()` et `deleteSession()` ([`data.js`](data.js)) écrivent **la séance et son opération d'outbox dans la même transaction IndexedDB** : aucune modification ne peut exister sans l'opération qui l'enverra, même si l'app est fermée juste après. La séance apparaît immédiatement avec le badge « En attente ».

### 6.3 Rejeu de l'outbox — `syncPendingData()`

Les opérations sont rejouées **dans l'ordre**, une par une :

| Réponse | Traitement |
| --- | --- |
| 2xx | L'opération quitte l'outbox ; la séance prend la `version` du serveur et redevient `synced` s'il ne reste aucune autre opération pour elle |
| `fetch` en échec (réseau absent) | Arrêt, l'opération **reste** dans l'outbox ; nouvel essai au prochain signal |
| 5xx, 408, 429 | Serveur indisponible ou saturé : arrêt, l'opération reste |
| 412 | Conflit : la copie du serveur est gardée à côté de la séance locale, état `conflict` ; rien n'est écrasé (§ 6.7) |
| Autre 4xx | Erreur définitive : réessayer bloquerait la file. L'opération est retirée, la séance **reste sur l'appareil** avec l'état `error` (badge « Refusée » et message du serveur), l'utilisateur est prévenu par un toast |

Une opération n'est **jamais retirée avant la réponse du serveur**. Un verrou `navigator.locks.request('pulsetrack-sync', …)` garantit qu'un seul rejeu tourne à la fois entre les onglets et le Service Worker.

**Idempotence.** Chaque opération porte un `opId` (UUID) envoyé en `Idempotency-Key`. Le serveur mémorise la réponse de chaque opération réussie : si la réponse s'est perdue et que l'opération est rejouée, il renvoie la réponse mémorisée (`Idempotent-Replayed: true`) au lieu de l'appliquer une seconde fois.

### 6.4 Déclenchement

| Chemin | Navigateurs | Détail |
| --- | --- | --- |
| **Background Sync** (principal) | Chromium | Après chaque écriture : `registration.sync.register('sync-pending')`. Le navigateur déclenche l'événement `sync` dans `sw.js` dès que le réseau revient, **même page fermée**. Si l'outbox n'a pas pu être vidée, `waitUntil` est rejeté pour que le navigateur réessaie. Le résultat est envoyé aux pages ouvertes (`SYNC_RESULT`). |
| **Repli** (obligatoire) | Firefox, Safari (et Chromium) | La page rejoue l'outbox au démarrage, sur l'événement `online`, au retour au premier plan et sur le bouton « Synchroniser maintenant ». |

L'utilisateur sait toujours ce qui n'est pas encore envoyé (US4) : badge par séance, compteur « N modifications en attente d'envoi », toast « N modifications envoyées au serveur » à la fin du rejeu.

### 6.5 Lecture : réseau d'abord, repli IndexedDB

Après un rejeu réussi, `pullSessions()` lit `GET /api/sessions`. Une séance du serveur remplace la copie locale seulement si celle-ci est `synced` et plus ancienne (`version` inférieure) ; **une séance en attente d'envoi n'est jamais écrasée**. En cas d'échec réseau, rien ne change : la page affiche déjà IndexedDB.

### 6.6 API serveur

[`server/api.mjs`](server/api.mjs). Chaque séance est rattachée à l'appareil par l'en-tête `X-Device-Id` ; clés de stockage `sessions/<deviceId>/<id>` et `ops/<deviceId>/<opId>`.

| Route | Rôle | Réponses |
| --- | --- | --- |
| `GET /api/sessions` | Séances de l'appareil | 200 |
| `POST /api/sessions` | Créer (`Idempotency-Key`) | 201 ; 200 si la séance existe déjà ; rejeu : réponse mémorisée |
| `PUT /api/sessions/:id` | Modifier (`If-Match: "<version>"`) | 200 ; 201 si la séance n'existait pas encore ; **412 + copie du serveur** si la version ne correspond pas |
| `DELETE /api/sessions/:id` | Supprimer | 204, même si déjà supprimée |
| `GET /api/push/key` | Clé publique VAPID | 200 ; 503 si les rappels ne sont pas configurés |
| `POST /api/push/subscribe` | Enregistrer l'abonnement et les préférences (jours, heure, fuseau) | 201 ; 200 si déjà abonné (préférences mises à jour) ; 422 si service de push inconnu |
| `DELETE /api/push/subscribe` | Retirer l'abonnement | 204 |
| `POST /api/push/test` | Envoyer un rappel immédiat | 200 ; 404 sans abonnement |

Toutes les écritures sont **validées côté serveur** avec les mêmes règles que le client (type, date, durée, distance, note ≤ 500, coordonnées) : 422 sinon. Corps limité à 16 Ko (413).

### 6.7 Conflits (bonus)

**Principe.** Chaque séance porte la `version` du serveur. Une modification part en `PUT` avec `If-Match: "<version sur laquelle elle repose>"`. Si le serveur a une version plus récente, il répond **412 avec sa copie** et n'écrit rien. La séance passe à l'état `conflict`, la copie du serveur est gardée à côté de la version locale (`serverCopy`) : **aucune des deux n'est perdue**, l'utilisateur choisit.

**Quelle version mettre dans `If-Match` ?** C'est le point délicat, parce que deux onglets du même navigateur partagent la même base IndexedDB :

- envoyer « la version de la séance au moment de l'envoi » ne détecterait jamais le conflit entre deux onglets (le second écraserait le premier sans que personne ne le sache) ;
- envoyer « la version vue à l'ouverture du formulaire » créerait un **faux conflit** pour deux modifications successives dans le même onglet hors ligne (la seconde repose sur la première, pas sur la version du serveur).

PulseTrack tient donc un numéro de **révision locale** : `localRev` (incrémenté à chaque enregistrement) et `serverRev` (la révision que le serveur a confirmée). Le formulaire retient la révision et la version qu'il a chargées ; chaque opération les porte (`parentRev`, `baseVersion`). À l'envoi, `ifMatchFor()` ([`data.js`](data.js)) choisit :

| L'opération repose sur… | `If-Match` | Cas |
| --- | --- | --- |
| la révision confirmée par le serveur (`parentRev === serverRev`) | version actuelle | modifications successives dans le même onglet : pas de faux conflit |
| une révision plus ancienne | version vue à l'ouverture du formulaire → 412 si le serveur a avancé | un autre onglet a modifié la séance entre-temps : conflit détecté |

**Interface.** Badge « Conflit » et bouton « Résoudre le conflit » dans la liste ; toast d'avertissement, diffusé à tous les onglets ouverts (`BroadcastChannel`), et qu'un message informatif comme « Connexion rétablie » ne peut pas masquer. Le détail affiche une bannière qui compare les deux versions champ par champ (les différences en gras) et propose deux choix ([`resolveConflict()`](data.js)) :

- **« Garder la mienne »** : la version locale est renvoyée, cette fois avec `If-Match` = version du serveur ; elle le remplace en connaissance de cause.
- **« Prendre la leur »** : la copie du serveur remplace la version locale ; les envois encore en attente pour cette séance sont abandonnés.

La photo, qui ne vit que sur l'appareil, est conservée dans les deux cas. Une séance en conflit ne peut pas être modifiée avant d'être résolue (« Modifier » ouvre la bannière).

**Incident : Netlify ne transmet pas `If-Match` à la Function.** Tous les tests passaient en local, mais sur l'aperçu Netlify aucun conflit n'était détecté. Vérification par `curl` sur le déploiement : `PUT` avec `If-Match: "99"` (version périmée) → **200** ; le même code en local → 412. L'en-tête standard est retiré par le CDN avant la Function. Correctif : le client envoie aussi un double non standard **`X-If-Match`**, que le serveur lit si `If-Match` est absent (`If-Match` reste lu en premier, pour tout hébergeur qui le transmet). Après correctif, sur le déploiement : `X-If-Match: "99"` → 412, et le test T9 complet passe contre Netlify.

**Choix assumé : la suppression gagne.** `DELETE` n'envoie pas `If-Match` : supprimer une séance modifiée ailleurs la supprime.

**Validation (T9).** `tests/conflicts.e2e.mjs` ouvre deux onglets hors ligne qui modifient la même séance (durée 11 dans l'un, 22 dans l'autre), puis rétablit le réseau : un seul 412, serveur à 11 (v2), local à 22 avec la copie 11, bannière affichée ; « Garder la mienne » → serveur à 22 (v3) ; second tour avec « Prendre la leur » → local repris à la valeur du serveur, rien renvoyé ; enfin deux modifications dans le même onglet → aucun conflit (13 vérifications).

## 7. Permissions et capacités de l'appareil

Règles communes, vérifiées par `tests/sprint6.e2e.mjs` :

- **Aucune permission au chargement** : chaque API n'est appelée qu'après un clic (le test compte 0 appel à la géolocalisation au chargement).
- **Détection de fonctionnalité** avant d'afficher un bouton (`'geolocation' in navigator`, `'share' in navigator`, `navigator.clipboard`).
- **Erreurs traduites** en messages lisibles, jamais affichées brutes.

| Capacité | Déclenchée quand | Pourquoi à ce moment | Si refus ou indisponible |
| --- | --- | --- | --- |
| **Géolocalisation** — *capacité principale* (`navigator.geolocation.getCurrentPosition`, haute précision, délai 15 s) | Clic sur « Ajouter ma position » dans le formulaire | L'utilisateur est sur le lieu de sa séance et comprend l'usage | Refus : « Position refusée : la séance sera enregistrée sans lieu. Vous pouvez l'autoriser dans les réglages du navigateur. » GPS indisponible ou délai dépassé : message dédié. Le bouton reste disponible. |
| **Caméra / photo** (`<input type="file" accept="image/*" capture="environment">`) | Clic sur « Prendre une photo » | Le geste explicite justifie l'accès à la caméra | « Choisir une image » (même input sans `capture`) reste disponible ; le système gère lui-même le refus d'accès à la caméra. Fichier non image ou illisible : message. |
| **Partage** (`navigator.share`, photo en pièce jointe si `navigator.canShare` l'accepte) | Clic sur « Partager » dans le détail d'une séance | Action volontaire, rien n'est envoyé sans choix de l'utilisateur | Annulé (`AbortError`) : rien. Refusé ou absent : copie du texte et du lien dans le presse-papiers + toast. |

**Données produites.**

- **Coordonnées** arrondies à 5 décimales (≈ 1 m) avec la précision en mètres ; elles partent au serveur avec la séance, et n'apparaissent **jamais** dans le HTML public (le test le vérifie).
- **Photo** réduite par canvas (1280 px max, JPEG qualité 0,8), stockée en **Blob dans IndexedDB**, dans la même transaction que la séance ; elle **ne part jamais au serveur** (`toPayload()` ne l'inclut pas, testé).
- **Lien partagé** : celui de l'app, pas `/?session=<id>` : cette URL ne fonctionne que sur l'appareil qui détient la séance.

**Détail d'une séance.** URL privée `/?session=<id>` : le bouton Retour la ferme, un lien direct l'ouvre, y compris hors ligne (`ignoreSearch`). Le canonical pointe toujours vers `/` et `robots.txt` exclut `/*?session=`.

**Note Safari.** `navigator.share` exige un geste utilisateur « direct » : les données à partager (texte, fichier photo) sont donc préparées à l'ouverture du détail, pour que le clic appelle `navigator.share` sans attente intermédiaire.

## 8. Notifications

**Rappels d'entraînement par vrai push (bonus)** : Web Push standard avec clés VAPID, sans compte Firebase. Une notification arrive même app fermée.

| Aspect | Choix |
| --- | --- |
| **Type** | Push réel : le serveur chiffre le message (aes128gcm) et le signe avec la clé privée VAPID ; le service de push du navigateur (Google, Apple, Mozilla, Microsoft) le délivre au Service Worker |
| **Moment de la demande** | Section « Réglages », bouton « Activer les rappels », **après** une phrase qui explique l'usage ; `Notification.requestPermission()` est le premier appel du clic (Safari exige un geste direct). Rien n'est demandé au chargement (testé) |
| **Contenu** | Titre « PulseTrack », texte « C'est l'heure de ta séance ! (mercredi, 18 h) » avec le jour et l'heure choisis, icône 192 px, **tag unique** `pulsetrack-reminder` (un nouveau rappel remplace l'ancien au lieu de s'empiler) |
| **Au clic** | `notificationclick` ramène l'app ouverte au premier plan sur le formulaire « Nouvelle séance » **sans effacer une saisie en cours** (message `OPEN_NEW_SESSION`), ou ouvre `/#session-form` |
| **Planification** | L'utilisateur choisit les jours et l'heure (6 h à 22 h). Une **Netlify Scheduled Function** (`netlify/functions/reminders.mjs`, `@hourly`) envoie les rappels dus, calculés dans le **fuseau horaire de l'utilisateur** ; `lastSent` empêche deux envois le même jour |
| **Stockage** | L'abonnement (`PushSubscription`) et les préférences sont envoyés au serveur (`push/<deviceId>/<id>`). « Désactiver » retire l'abonnement du serveur **puis** le résilie dans le navigateur. Un abonnement expiré (404 / 410 du service de push) est supprimé automatiquement |
| **Si refus** | « Notifications refusées : les rappels ne pourront pas s'afficher. Vous pouvez les autoriser dans les réglages du navigateur ; le reste de l'app fonctionne normalement. » Les boutons de test et de désactivation restent masqués |
| **Hors ligne** | Les boutons sont désactivés et un message explique que les rappels se règlent avec une connexion |
| **iPhone** | Le push n'existe que pour une app **installée** sur l'écran d'accueil (iOS 16.4+) ; dans Safari, la section l'explique au lieu d'afficher une erreur |
| **Test** | « Envoyer un rappel de test » envoie immédiatement une vraie notification (T16 sans attendre l'heure choisie) |

**Envoi** ([`server/push.mjs`](server/push.mjs)). La librairie `web-push` ne sert qu'à **préparer** la requête (`generateRequestDetails` : chiffrement et en-tête `Authorization: vapid …`) ; l'envoi passe par `fetch`. Le même code tourne sur Netlify et en local, et il est testable avec un faux service de push (§ 11.3).

**Clés VAPID.** La clé publique est servie par `GET /api/push/key` (le navigateur en a besoin pour s'abonner, ce n'est pas un secret). La clé privée n'existe que dans les variables d'environnement Netlify (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) ; en local, des clés de développement sont générées dans `server/data/` (ignoré par Git). Sans clés, l'API répond 503 et l'app affiche « Les rappels ne sont pas encore disponibles sur le serveur ».

## 9. Visibilité SEO et agents IA

Un robot qui n'exécute pas JavaScript voit tout le contenu public dans le HTML initial.

- **`<head>`** : `<title>`, `meta description`, **canonical fixe** (`https://pulsetrackisco.netlify.app/`), Open Graph (image 1200 × 630 en **URL absolue**), carte Twitter, lien `alternate` vers la jumelle Markdown, **JSON-LD `WebApplication`** (catégorie `HealthApplication`, gratuit, liste des fonctionnalités).
- **Corps** : un `<h1>`, une description, le formulaire et **trois `<li data-seed>`** de séances d'exemple. Aucun autre `<li>` dans la page (les fonctionnalités sont décrites en paragraphe).
- **Séances privées** : jamais dans le HTML ni dans le sitemap ; rendues uniquement par JavaScript, via `textContent`.

| Fichier | Rôle |
| --- | --- |
| [`robots.txt`](robots.txt) | Une décision **et sa raison** par famille de robots. Autorisés : moteurs de recherche (objectif SEO) ; robots de recherche et de réponse des assistants (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot…, objectif GEO, ils citent la source) ; robots d'entraînement des grands assistants (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended : vitrine publique sans donnée personnelle, être connu des assistants sert la découvrabilité). Refusés : CCBot et Bytespider (collecte massive sans attribution). Exclus pour tous : `/api/` et `/*?session=`. Chaque groupe répète les exclusions, car un robot qui trouve un groupe à son nom ignore `*`. |
| [`sitemap.xml`](sitemap.xml) | La vitrine seule, avec `lastmod` exact (mis à jour avec `CACHE_NAME`) |
| [`llms.txt`](llms.txt) | Résumé de l'app et liens pour les agents (format llmstxt.org) |
| [`sessions.md`](sessions.md) | **Jumelle Markdown** de la vitrine (description, séances d'exemple, fonctionnement), pré-cachée |
| [`_headers`](_headers) | `sessions.md` servi en `text/markdown` avec **`X-Robots-Tag: noindex`** (contenu dupliqué) et un `Link` canonical vers `/` |

`robots.txt` et `sitemap.xml` ne sont pas pré-cachés : ils ne servent qu'aux robots, en ligne.

Résultats des quatre commandes de vérification au § 11.

## 10. Sécurité et vie privée

### 10.1 Mesures

| Mesure | Où |
| --- | --- |
| **Aucun `innerHTML` pour du contenu saisi** : tout passe par `textContent` / `createElement` (une note `<img onerror=…>` reste du texte, testé) | `app.js` |
| **CSP stricte** : `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'…` — possible parce qu'aucun script ni style externe ou inline n'est utilisé (`idb` est copiée localement ; le JSON-LD n'est pas exécuté) | `_headers` |
| HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` (géolocalisation et caméra pour l'origine seulement, micro, paiement et USB refusés) | `_headers` |
| **Aucun secret côté client** : la clé privée VAPID n'existe que dans les variables d'environnement Netlify ; seule la clé publique est servie | `netlify/lib/netlify-store.mjs` |
| **Anti-SSRF** : le serveur n'envoie de requête qu'aux services de push connus (`fcm.googleapis.com`, `web.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`, en HTTPS) ; sans cette liste, un faux « abonnement » ferait appeler une URL arbitraire par la fonction | `server/push.mjs` |
| **Validation serveur** de chaque champ, taille du corps limitée | `server/api.mjs` |
| **Limitation de débit** : 120 écritures par minute et par appareil → 429 + `Retry-After` (le client réessaie automatiquement) | `server/api.mjs` |
| **Même origine** pour la PWA et l'API : aucune configuration CORS à ouvrir | `netlify/functions/api.mjs` |
| **Publication en liste blanche** : `server/`, `netlify/`, `node_modules/`, `package.json`, `_headers` ne sont jamais servis (404 vérifié en production) | `scripts/build.mjs` |
| Pas d'analytics, pas de cookie : aucune bannière de consentement nécessaire | — |

### 10.2 Données

| Donnée | Où elle vit | Part au serveur ? |
| --- | --- | --- |
| Séance (type, date, durée, distance, note) | IndexedDB | Oui, via l'outbox |
| Position | IndexedDB, dans la séance | Oui, uniquement si l'utilisateur l'a ajoutée |
| Photo | IndexedDB (Blob) | **Non** : reste sur l'appareil |
| Identifiant d'appareil (UUID aléatoire) | IndexedDB (`meta`) | Oui, en-tête `X-Device-Id` |
| Abonnement push et préférences de rappel | Serveur ; préférences aussi dans IndexedDB (`meta`) | Oui, seulement si l'utilisateur active les rappels ; supprimé s'il les désactive |

L'identifiant d'appareil n'est pas un secret d'authentification : quiconque le connaîtrait pourrait lire les séances de l'appareil. C'est acceptable pour un TP sans comptes (non-objectif explicite) et documenté au § 12.

## 11. Mesures

Mesures relevées le 11 octobre 2026 sur la production (`v0.6`, cache `pulsetrack-v6`), sauf mention contraire.

### 11.1 Lighthouse 12.8.2 (mobile, émulation par défaut, deux passages)

| Catégorie | Score |
| --- | --- |
| Performance | **100** / 100 |
| Accessibilité | **100** / 100 |
| Bonnes pratiques | **100** / 100 |
| SEO | **100** / 100 |

| Indicateur | Passage 1 | Passage 2 | Cible |
| --- | --- | --- | --- |
| First Contentful Paint | 1,0 s | 0,9 s | — |
| Largest Contentful Paint | 1,2 s | 1,0 s | < 2,5 s |
| Total Blocking Time | 0 ms | 0 ms | (INP < 200 ms) |
| Cumulative Layout Shift | 0,019 | 0,019 | < 0,1 |

**Incident rencontré.** Une première mesure donnait Bonnes pratiques à 93 en production (100 sur les aperçus et en local) : Netlify injecte sur les projets gratuits un badge « Powered by Netlify » (`/.netlify/scripts/hud`) qui crée une iframe avec du code inline ; notre CSP le bloquait, d'où des erreurs dans la console. Le badge a été désactivé dans les réglages du projet (sans redéploiement) ; les mesures ci-dessus sont postérieures.

INP n'est pas mesurable en laboratoire ; le Total Blocking Time (0 ms) en est l'indicateur de substitution. Lighthouse 12 n'a plus de catégorie « PWA » : l'installabilité est vérifiée par DevTools → Application → Manifest et par l'API `Page.getInstallabilityErrors` (aucune erreur, `tests/sprint1.e2e.mjs`).

**Poids** (gzip) : HTML 4,0 Ko · `app.js` 9,8 Ko · `data.js` 4,4 Ko · `styles.css` 2,5 Ko · `vendor/idb.js` 1,6 Ko · `sw.js` 2,0 Ko.

### 11.2 Visibilité (production)

| Commande | Résultat |
| --- | --- |
| `curl -s -A "GPTBot" https://pulsetrackisco.netlify.app/ \| grep -c "<li[ >]"` | `3` |
| `curl -s -A "ClaudeBot" https://pulsetrackisco.netlify.app/sessions.md` | `# PulseTrack — journal sportif hors ligne` … |
| `curl -sI https://pulsetrackisco.netlify.app/sessions.md` | `Content-Type: text/markdown; charset=utf-8` · `X-Robots-Tag: noindex` |
| `robots.txt`, `sitemap.xml`, `llms.txt` | 200 |
| validator.schema.org | `WebApplication` : **0 erreur, 0 avertissement** |

### 11.3 Tests automatisés

`npm test` lance [`tests/run-all.mjs`](tests/run-all.mjs) : tests unitaires de l'API, puis tests de bout en bout dans un vrai navigateur (Edge ou Chrome sans interface, piloté par `puppeteer-core`) contre le serveur local. Le réseau est coupé à la fois pour la page **et** pour le Service Worker (l'émulation « hors ligne » d'une page ne coupe pas celui du Service Worker). `npm test -- <url>` rejoue les tests applicables contre un déploiement.

| Suite | Vérifications | Ce qui est prouvé |
| --- | --- | --- |
| API (unitaires) | 21 | Validation, création, rejeu idempotent, `If-Match` et `X-If-Match` / 412, upsert, suppression, isolation par appareil, limitation de débit |
| Installable et hors ligne | 10 | SW actif, cache versionné sans `sw.js`, manifest et installabilité sans erreur, shell / `?session=` / `offline.html` hors ligne |
| Séances locales | 21 | CRUD, validation, import unique des exemples, XSS, filtre, hors ligne, non-réimport |
| Mise à jour | 14 | Pas de rechargement à la 1re installation, bannière sans perte de saisie, « Plus tard », SKIP_WAITING, anciens caches supprimés, bandeau hors ligne |
| Synchronisation | 23 | Outbox hors ligne, rejeu sans doublon, serveur coupé alors que `navigator.onLine` est vrai, 4xx définitive, lecture réseau d'abord, **Background Sync seul** (page hors ligne, événement `sync` déclenché dans le SW) |
| Capacités | 24 | Aucune permission au chargement, refus et acceptation de la position, réduction photo 3000 → 1280 px, photo jamais envoyée, partage natif / annulé / repli presse-papiers, détail hors ligne |
| Conflits (T9) | 13 | Deux onglets hors ligne → un seul 412, rien d'écrasé, bannière comparative, « Garder la mienne » (v3), « Prendre la leur », pas de faux conflit dans un même onglet |
| Rappels push, serveur | 17 | Liste blanche anti-SSRF, 503 sans clés, abonnement et réabonnement, **vraie requête Web Push** reçue par un faux service local puis **déchiffrée** (VAPID, aes128gcm, TTL), rappel dû au bon jour et à la bonne heure dans le fuseau de l'utilisateur, pas de doublon, abonnement expiré (410) supprimé, désabonnement |
| Rappels push, bout en bout (T16) | 14 | Aucune permission au chargement, refus géré, abonnement avec la clé VAPID, rappel de test envoyé par le serveur puis remis au Service Worker (`ServiceWorker.deliverPushMessage`), notification affichée (titre, texte, icône, tag), clic → « Nouvelle séance » sans perte de saisie, hors ligne, désactivation |
| **Total** | **144** | **144 réussies, 0 en échec** |

En mode sans interface, le navigateur n'a pas de service de push : le test de bout en bout simule l'abonnement du navigateur (endpoint local, vraies clés de chiffrement). Tout le reste de la chaîne est réel : envoi par le serveur, chiffrement, déchiffrement, événements `push` et `notificationclick` du Service Worker.

### 11.4 Tests manuels sur téléphone (iPhone, Safari)

| Test | Résultat |
| --- | --- |
| T1 — URL ouverte en HTTPS | ✓ (capture `docs/captures/t1-iphone-safari.png`) |
| T3 — Installation sur l'écran d'accueil, lancement en standalone | ✓ |
| T4 / T5 — Mode avion : shell, séances, création | ✓ |
| T6 — Bannière de mise à jour (v5 → v6), saisie conservée | ✓ |
| T7 / T8 — Séance créée en avion, envoyée au retour du réseau (Safari : repli `online`) | ✓ |
| T15 — Position, photo, partage : accepter puis refuser | ✓ |

## 12. Limites connues et écarts

### 12.1 Limites

| Limite | Impact | Parade |
| --- | --- | --- |
| **Background Sync absent** sous Firefox et Safari | Pas de synchronisation page fermée | Repli au démarrage, sur `online`, au retour au premier plan et par bouton (testé sur iPhone) |
| **Safari efface le stockage** d'un site non installé après 7 jours sans visite | Perte des séances **non encore envoyées** et des photos | Les séances synchronisées sont relues depuis le serveur ; installer l'app sur l'écran d'accueil lève la limite. `navigator.storage.persist()` n'est pas demandé. |
| Photos **uniquement sur l'appareil** | Pas de photo sur un autre appareil ; perdue si le stockage est effacé | Choix de la v1 (vie privée, quota) |
| **Pas de suppression propagée** (pas de « tombstone ») | Une séance supprimée ailleurs resterait affichée localement | Sans impact aujourd'hui : un `deviceId` n'existe que sur un appareil |
| `deviceId` non secret | Lecture possible des séances par quelqu'un qui connaîtrait l'UUID | Pas de comptes (non-objectif) ; UUID aléatoire non devinable |
| Limitation de débit **par instance** de la fonction | Pas une protection contre une attaque distribuée | Garde-fou contre une boucle d'envoi ou un abus simple |
| `GET /api/sessions` lit chaque séance séparément dans Netlify Blobs | Lent avec des milliers de séances | Suffisant à l'échelle du TP |
| La suppression ne porte pas `If-Match` | Supprimer une séance modifiée dans un autre onglet la supprime | Choix assumé : la suppression gagne (§ 6.7) |
| Push sur iOS réservé aux apps installées sur l'écran d'accueil (iOS 16.4+) | Pas de rappel dans Safari | La section Réglages l'explique et indique comment installer |
| Rappels à l'heure pile seulement, envoyés par une fonction horaire | Précision de l'ordre de la minute à l'heure près | Suffisant pour un rappel de séance ; la Scheduled Function ne tourne qu'en production |
| `pushsubscriptionchange` non géré | Si le navigateur renouvelle l'abonnement, les rappels s'arrêtent | L'ancien abonnement expire (410) et est supprimé ; réactiver les rappels suffit |
| Crédits Netlify (gratuit : 300 / mois, 15 par déploiement de production) | Nombre de déploiements limité | Tests sur les aperçus de branche (gratuits) ; build ignoré si seuls la doc ou le README changent (`netlify.toml`) |

### 12.2 Écarts au PRD

| PRD | Réalisé | Raison |
| --- | --- | --- |
| Serveur d'API Node séparé, CORS autorisant `If-Match` | Netlify Function sur la **même origine** | Pas de CORS, pas de second hébergeur qui s'endort ni de disque effacé ; même code qu'un serveur Node (`server/server.mjs` en local) |
| `syncState` : `synced`, `pending`, `conflict` | + `error` | Représenter une séance refusée définitivement (4xx) sans bloquer la file |
| Type `vélo` | Valeur `velo` (affichage « Vélo ») | Valeur sans accent, plus sûre dans les URL et l'API |
| Lien partagé | Lien de l'app, pas de la séance | `/?session=<id>` n'a de sens que sur l'appareil qui détient la séance |
| `If-Match` seul | `If-Match` + double `X-If-Match` | Netlify retire `If-Match` avant la Function (§ 6.7) |
| `npm start` avec `serve` | Serveur Node maison | Sert la PWA **et** l'API sur la même origine, applique `_headers` comme Netlify |

### 12.3 Suite possible

Comptes et authentification, synchronisation des photos, export GPX, graphiques de progression, synchronisation périodique en arrière-plan.
