# Tableau de Location — Boulet Dépôt

Application web interactive de gestion des locations d'équipement.
Multi-utilisateurs avec synchronisation temps réel.

## Prérequis
- Node.js 22 ou plus récent (https://nodejs.org) — utilise SQLite intégré (`node:sqlite`)

## Installation locale
```bash
npm install
npm start
```
Puis ouvrir http://localhost:5000

## Structure
- `server.js` — Backend Express + SQLite (`node:sqlite`) + SSE (temps réel)
- `public/` — Frontend (HTML, CSS, JS)
- `data.db` — Base de données SQLite (créée automatiquement)
- `package.json` — Dépendances Node

## Fonctionnalités
- Tableau calendrier hebdomadaire avec post-its de location
- Ajout/édition/archivage d'équipements
- Détection de conflits de réservation
- Historique complet avec équipements archivés restaurables
- Verrouillage optimiste (multi-utilisateurs)
- Synchro temps réel via Server-Sent Events

## Déploiement

### Option 1 — Railway.app (recommandé, plus simple)
1. Créer compte sur https://railway.app (gratuit)
2. New Project → Deploy from GitHub (uploader ce dossier sur un repo GitHub)
3. Railway détecte automatiquement Node.js et lance `npm start`
4. Variables d'environnement : aucune requise
5. Générer un domaine public dans Settings → Networking → Generate Domain
6. Ton URL publique : `https://ton-app.up.railway.app`

**Important** : Pour que SQLite persiste entre redéploiements sur Railway, ajouter un
volume dans Settings → Volumes, monté sur `/data`, puis modifier `server.js` ligne
avec `const DB_PATH` pour pointer vers `/data/data.db`.

### Option 2 — Render.com
1. Créer compte sur https://render.com (gratuit)
2. New → Web Service → Connect Repo (upload sur GitHub d'abord)
3. Build Command : `npm install`
4. Start Command : `npm start`
5. Ajouter un Disk (Free tier : 1 GB) monté sur `/data`
6. Modifier `server.js` pour utiliser `/data/data.db`

### Option 3 — VPS classique (Digital Ocean, OVH, etc.)
```bash
git clone <ton-repo>
cd tableau-location
npm install --production
NODE_ENV=production PORT=80 node server.js
```
Utiliser PM2 ou systemd pour garder le processus en vie.

## Modification du fichier DB
Si tu veux stocker `data.db` ailleurs, modifie cette ligne dans `server.js` :
```js
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
```
Puis lance avec `DB_PATH=/chemin/vers/data.db node server.js`

## Sécurité
L'app n'a PAS d'authentification intégrée. Si tu veux limiter l'accès :
- Mettre l'app derrière un reverse proxy (nginx) avec Basic Auth
- OU utiliser Cloudflare Access
- OU ajouter un middleware d'auth dans server.js (dis-moi si tu veux, je te le fais)
