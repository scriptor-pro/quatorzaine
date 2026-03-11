# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Server
```bash
# Serve static frontend locally (choose one)
python3 -m http.server 8000
npx serve .

# Open in browser
open http://localhost:8000/index.html
```

### Docker (PocketBase backend)
```bash
# Build PocketBase container
docker build -t quatorzaine-pocketbase .

# Run PocketBase locally
docker run --rm -p 8080:8080 quatorzaine-pocketbase
```

### Manual Verification
No automated tests or linting are configured. Manual verification flow:
1. Start static server and open `index.html`
2. Save a PocketBase URL via the server form
3. Create an account or login with existing account
4. Confirm redirect to `quatorzaine.html`
5. Test core functionality: add/edit/delete tasks and appointments
6. Test cloud sync: `Télécharger cloud` and `Envoyer local vers cloud`
7. Verify browser console has no runtime errors

## Architecture

### Frontend Structure
- **Static web app** with no build step - serves files directly
- **Two main pages**:
  - `index.html` + `auth.js` + `auth.css`: Authentication flow
  - `quatorzaine.html` + `script.js` + `style.css`: 14-day planner interface
- **Data persistence**: localStorage with optional PocketBase cloud sync
- **External dependencies**: Loaded from CDN (fonts, icons)

### Data Flow
- Frontend state stored in module-level variables (`schedule`, `pocketbase`)
- Local persistence via localStorage using stable key constants
- Cloud sync through PocketBase collections: `planner_snapshots`, `external_events`
- External calendar integration via separate Cloudflare Worker (see `calendar-worker/`)

### Key Files
- `auth.js`: Authentication logic, account creation, server URL management
- `script.js`: Main planner functionality, task/appointment management, cloud sync
- `rendezvous.js`: Appointment scheduling module
- `stats.js`: Usage statistics and analytics

## PocketBase Integration

### Required Collections
```
planner_snapshots:
- owner (relation to users, single)  
- schedule (json)

external_events:
- owner (relation to users, single)
- provider, external_event_id, title, starts_at, ends_at, etc.
```

### Access Rules
```javascript
// planner_snapshots rules
listRule: "owner = @request.auth.id"
viewRule: "owner = @request.auth.id"  
createRule: "owner = @request.auth.id"
updateRule: "owner = @request.auth.id"
deleteRule: "owner = @request.auth.id"
```

### Constants
- `PB_URL_KEY`: localStorage key for server URL
- `PB_COLLECTION`: "planner_snapshots" 
- `PB_EXTERNAL_EVENTS_COLLECTION`: "external_events"

## Code Conventions

### JavaScript Style
- Modern browser JS (const/let, async/await, optional chaining)
- No ES modules - plain scripts with `defer` attribute
- 2-space indentation, double quotes, required semicolons
- Naming: `UPPER_SNAKE_CASE` constants, `camelCase` functions/variables, `domElementEl` for DOM refs

### Error Handling
- Wrap async PocketBase calls in try/catch
- Display user-facing errors via status UI, not alerts
- Graceful fallback behavior when parsing fails
- Validate inputs early, don't throw on expected problems

### DOM Patterns  
- Use `document.createElement` for complex dynamic UI
- Attach event listeners close to element creation
- Re-render from source state after mutations: `saveSchedule(); render();`
- Preserve accessibility attributes and semantic HTML

### CSS Style
- CSS custom properties in `:root` for design tokens
- kebab-case class names (`auth-shell`, `appointment-form`)
- Responsive breakpoints around 720/860px
- Maintain visible focus states and minimum touch targets (44px)

## External Calendar Integration

Optional read-only calendar sync via separate Cloudflare Worker:
- OAuth flow for Google Calendar and Microsoft Outlook
- Worker handles token management and syncing to PocketBase
- Events appear read-only with source badges
- See `calendar-worker/README.md` for setup details

## Development Guidelines

- Keep changes minimal and aligned with vanilla JS architecture
- Don't introduce build systems unless explicitly requested  
- Maintain French UX copy unless language change is explicitly required
- Follow existing patterns for new features
- Document any new tooling commands in this file