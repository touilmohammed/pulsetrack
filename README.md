# PulseTrack

PWA de suivi sportif offline-first : enregistrez vos séances (course, vélo, marche, musculation) sans réseau, elles se synchronisent au retour de la connexion.

TP M2 Informatique — Università di Corsica.

- **Production :** _à compléter après le premier déploiement Netlify_
- **Document technique :** [DOC-TECHNIQUE.md](DOC-TECHNIQUE.md) _(à venir, sprint 7)_

## Lancer en local

Prérequis : Node.js 18 ou plus.

```bash
npm start
```

L'app est servie sur <http://localhost:3000>. `serve.json` désactive `cleanUrls` pour que `/offline.html` ne soit pas redirigé vers `/offline`.

## Déploiement

Chaque push sur `main` déclenche un déploiement Netlify (site statique, pas de build, voir `netlify.toml`). Chaque branche dispose d'un aperçu.

## Avancement

| Sprint | Contenu | Tag |
| --- | --- | --- |
| 0 | Socle et déploiement HTTPS | v0.0 |
