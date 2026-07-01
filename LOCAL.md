# Hébergement local — Tableau de Location

## Démarrage

À la racine du dépôt :

```bash
npm run serve:tableau
```

Le terminal affiche :
- `http://localhost:5000` — sur ce PC
- `http://192.168.x.x:5000` — pour les collègues **sur le même réseau Wi-Fi / bureau**

## Identifiants

Configurés dans `tableau-location/.env` :

| Champ | Valeur actuelle |
|-------|-----------------|
| Utilisateur | `equipe` |
| Mot de passe | *(voir `.env`)* |

Pour changer le mot de passe, modifiez `TABLEAU_PASSWORD` dans `.env` puis redémarrez le serveur.

## Accès depuis l'extérieur du bureau

Si un collègue n'est **pas** sur le même réseau, utilisez un tunnel (PC allumé requis) :

```bash
npm run serve:tableau
# autre terminal :
npm run tunnel:tableau
```

Cloudflare affiche une URL temporaire `*.trycloudflare.com`.

## Données

La base SQLite est dans `tableau-location/data.db` — sauvegardez ce fichier régulièrement.

## Garder l'app toujours active

Laissez le terminal ouvert, ou configurez le PC pour ne pas s'endormir pendant les heures d'ouverture.

Pour un démarrage automatique au boot Windows, on peut ajouter une tâche planifiée — demandez si besoin.
