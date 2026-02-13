# quatorzaine

aujourd'hui et les 13 jours suivants : organisation et productivité

## Structure actuelle

- `index.html`: page d'authentification (URL serveur, connexion, creation de compte).
- `quatorzaine.html`: planner 14 jours (taches + rendez-vous) synchronise avec PocketBase.

## PocketBase sync setup

L'application peut fonctionner localement, mais la sync multi-appareils utilise PocketBase.

1. Lancer PocketBase et activer l'auth email/password sur la collection `users`.
2. Creer une collection `planner_snapshots` avec:
   - `owner`: relation vers `users` (single)
   - `schedule`: `json` (ou `text`)
3. Regles d'acces minimales sur `planner_snapshots`:
   - `listRule`: `owner = @request.auth.id`
   - `viewRule`: `owner = @request.auth.id`
   - `createRule`: `owner = @request.auth.id`
   - `updateRule`: `owner = @request.auth.id`
   - `deleteRule`: `owner = @request.auth.id`
4. Ouvrir `index.html`, saisir l'URL PocketBase, puis:
   - `Connexion` pour un compte existant
   - `Creer un compte` pour inscription + ouverture du planner

Dans le planner (`quatorzaine.html`):

- `Telecharger cloud` remplace les donnees locales par la version cloud.
- `Envoyer local vers cloud` ecrase le snapshot cloud avec les donnees locales.

## Notes de cout (Fly.io)

- `fly.toml` est configure pour reduire les couts d'inactivite:
  - `auto_stop_machines = "stop"`
  - `min_machines_running = 0`
  - VM `shared-cpu-1x`, `256MB`
- Effet attendu: cout mensuel plus bas, avec possible "cold start" au premier acces apres inactivite.
