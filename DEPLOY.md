# Déploiement — Tableau de Location

Guide pour publier l'app avec mot de passe et URL permanente pour l'équipe.

## Identifiants (à partager avec les collègues)

Configurer dans `.env` (local) ou variables Railway (production) :

| Variable | Description | Exemple |
|----------|-------------|---------|
| `TABLEAU_USER` | Nom d'utilisateur partagé | `equipe` |
| `TABLEAU_PASSWORD` | Mot de passe partagé | *(choisir un mot de passe fort)* |
| `TABLEAU_SESSION_SECRET` | Optionnel — secret de session | *(auto si absent)* |
| `DB_PATH` | Chemin SQLite | `/data/data.db` sur Railway |

---

## Option A — Railway (URL permanente, recommandé)

### 1. Connexion Railway

```bash
npx @railway/cli login
```

Une fenêtre de navigateur s'ouvre — connectez-vous (compte gratuit sur [railway.app](https://railway.app)).

### 2. Déployer

```bash
cd tableau-location
npx @railway/cli init
npx @railway/cli up
```

### 3. Variables d'environnement

Dans le tableau de bord Railway → **Variables** :

```
TABLEAU_USER=equipe
TABLEAU_PASSWORD=votre-mot-de-passe-secret
NODE_ENV=production
DB_PATH=/data/data.db
```

### 4. Volume persistant (données conservées)

Railway → **Volumes** → **Add Volume** → Mount path : `/data`

### 5. Domaine public

Railway → **Settings** → **Networking** → **Generate Domain**

Partagez l'URL avec l'équipe + les identifiants.

---

## Option B — Tunnel temporaire (test rapide)

```bash
cd tableau-location
npm start
# autre terminal :
npm run tunnel:tableau
```

Le tunnel affiche une URL `*.trycloudflare.com`. Votre PC doit rester allumé.

---

## Sécurité

- Sans `TABLEAU_PASSWORD`, l'app est **ouverte** (déconseillé).
- La session dure 7 jours (cookie HttpOnly).
- Changez le mot de passe si un collègue quitte l'équipe.
