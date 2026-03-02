# Calendar OAuth Worker (Google + Outlook)

Ce worker Cloudflare sert de couche backend OAuth/synchronisation en lecture seule.

## Ce qu'il fait

- OAuth Google Calendar (`calendar.readonly`)
- OAuth Microsoft Graph (`Calendars.Read`)
- Rafraichissement des tokens
- Synchronisation dans PocketBase:
  - collection `calendar_connections`
  - collection `external_events`
- Sync automatique toutes les 30 minutes via cron

## 1) Prerequis PocketBase

Creer les collections:

### `calendar_connections`

- `owner` (relation vers users, single)
- `provider` (text)
- `external_account_id` (text)
- `access_token` (text)
- `refresh_token` (text)
- `token_expires_at` (date)
- `scopes` (text)
- `status` (text)
- `last_sync_at` (date)
- `last_error` (text)

### `external_events`

- `owner` (relation vers users, single)
- `provider` (text)
- `external_event_id` (text)
- `calendar_id` (text)
- `title` (text)
- `starts_at` (date)
- `ends_at` (date)
- `is_all_day` (bool)
- `location` (text)
- `status` (text)
- `source_updated_at` (date)
- `raw_payload` (json/text)

Index unique conseille sur `external_events`:

- `(owner, provider, external_event_id)`

### Regles d'acces PocketBase recommandees (important)

Pour limiter l'exposition des tokens OAuth:

- `calendar_connections`
  - `listRule`: `null`
  - `viewRule`: `null`
  - `createRule`: `null`
  - `updateRule`: `null`
  - `deleteRule`: `null`
  - (ecriture/lecture reservees au worker via admin API)
- `external_events`
  - `listRule`: `owner = @request.auth.id`
  - `viewRule`: `owner = @request.auth.id`
  - `createRule`: `null`
  - `updateRule`: `null`
  - `deleteRule`: `null`

Checklist avant mise en prod:

- Verifier que `calendar_connections` est inaccessible au client PocketBase.
- Verifier que `external_events` n'autorise que la lecture owner-side.
- Verifier que l'auth PocketBase est active et que les clients sont bien authentifies.

## 2) Prerequis Google / Microsoft

### Google

- Activer Google Calendar API
- OAuth consent screen
- Scope: `https://www.googleapis.com/auth/calendar.readonly`
- Redirect URI: `https://<worker-domain>/oauth/google/callback`

### Microsoft

- App registration Entra
- Scope delegue: `Calendars.Read`
- Redirect URI: `https://<worker-domain>/oauth/microsoft/callback`
- Si tenant pro verrouille: admin consent necessaire

## 3) Configurer les secrets worker

```bash
wrangler secret put PB_URL
wrangler secret put PB_ADMIN_EMAIL
wrangler secret put PB_ADMIN_PASSWORD
wrangler secret put WORKER_STATE_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put MICROSOFT_CLIENT_ID
wrangler secret put MICROSOFT_CLIENT_SECRET
```

Variables (non secrets):

- `APP_BASE_URL` (URL de retour frontend)
- `APP_ORIGIN` (CORS frontend)
- `PB_CONNECTIONS_COLLECTION` (default `calendar_connections`)
- `PB_EXTERNAL_EVENTS_COLLECTION` (default `external_events`)

## 4) Deploiement

```bash
cd calendar-worker
wrangler deploy
```

## 5) Integration frontend

Dans le planner:

- bouton `Connecter Google`
- bouton `Connecter Outlook`
- bouton `Sync agendas`

Le frontend demande l'URL du worker a la premiere utilisation et la stocke localement.

### Demarrage OAuth recommande (plus sur)

- Le frontend appelle `POST /oauth/google/start` ou `POST /oauth/microsoft/start`
- Header: `Authorization: Bearer <pb_user_token>`
- Body JSON: `{ "returnTo": "https://.../quatorzaine.html" }`
- Reponse JSON: `{ "redirectUrl": "https://accounts..." }`
- Puis redirection navigateur vers `redirectUrl`

## Intervention utilisateur necessaire

- Creation des apps OAuth Google et Microsoft
- Configuration des redirect URIs exactes
- Renseignement des secrets dans Cloudflare Worker
- Creation des collections PocketBase ci-dessus
- Saisie de l'URL du worker dans l'app lors du premier clic
