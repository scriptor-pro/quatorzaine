# quatorzaine

aujourd'hui et les 13 jours suivants : organisation et productivité

## PocketBase sync setup

L'application fonctionne en localStorage sans serveur.
Pour activer la synchronisation multi-appareils avec PocketBase:

1. Lancer un serveur PocketBase et activer l'auth email/password sur la collection `users`.
2. Creer une collection `planner_snapshots` avec ces champs:
   - `owner`: relation vers `users` (1 record)
   - `schedule`: `json` (ou `text` si besoin)
3. Regles d'acces minimales sur `planner_snapshots`:
   - `listRule`: `owner = @request.auth.id`
   - `viewRule`: `owner = @request.auth.id`
   - `createRule`: `owner = @request.auth.id`
   - `updateRule`: `owner = @request.auth.id`
   - `deleteRule`: `owner = @request.auth.id`
4. Dans l'UI, saisir URL PocketBase + email + mot de passe, puis cliquer sur `Connexion`.

Le bouton `Telecharger cloud` remplace les donnees locales par la version cloud.
Le bouton `Envoyer local vers cloud` ecrase le snapshot cloud avec les donnees locales.
