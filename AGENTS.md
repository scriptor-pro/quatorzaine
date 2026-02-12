# AGENTS.md

Guidance for coding agents working in this repository.

## Project snapshot

- Type: static web app (no build step) + optional PocketBase backend.
- Frontend pages: `index.html` (auth) and `quatorzaine.html` (14-day planner).
- Frontend logic: `auth.js` and `script.js` (vanilla browser JavaScript).
- Styling: `auth.css` and `style.css`.
- Backend infra helpers: `Dockerfile` and `fly.toml` for PocketBase deployment.

## Source of truth files

- Product/setup notes: `README.md`.
- Auth flow: `auth.js`, `index.html`, `auth.css`.
- Planner flow: `script.js`, `quatorzaine.html`, `style.css`.
- PocketBase containerization: `Dockerfile`, `fly.toml`.

## Cursor and Copilot rules

- No `.cursorrules` file found.
- No files found under `.cursor/rules/`.
- No `.github/copilot-instructions.md` found.
- Therefore there are no repository-specific Cursor/Copilot rule files to inherit.

## Build, lint, and test commands

This repo currently has no `package.json`, no Makefile tasks, and no configured lint/test framework.

### Install

- No dependency install step is required for the frontend.
- External JS/CSS dependencies are loaded from CDN in HTML files.

### Build

- Frontend build: not applicable (static files served directly).
- PocketBase image build:
  - `docker build -t quatorzaine-pocketbase .`

### Run locally

- Serve static frontend (choose one):
  - `python3 -m http.server 8000`
  - `npx serve .` (if Node tooling is available locally)
- Open `http://localhost:8000/index.html`.
- For backend, run PocketBase separately and paste its URL in the UI.

### Run PocketBase locally with Docker

- `docker run --rm -p 8080:8080 quatorzaine-pocketbase`
- App expects PocketBase auth enabled and a `planner_snapshots` collection (see `README.md`).

### Lint / format

- No linter or formatter is configured in-repo.
- If you need a check pass before PR/commit, do manual verification:
  - open auth page
  - open planner page
  - verify browser console has no runtime errors
  - verify cloud pull/push buttons behavior after login

### Tests

- No automated tests are configured.
- `single test` command: not available (no test runner present).
- If a test suite is added later, update this file with exact commands and single-test syntax.

## Expected manual verification flow

- Start static server and open `index.html`.
- Save a PocketBase URL via the server form.
- Create an account (or login with existing account).
- Confirm redirect to `quatorzaine.html`.
- Add task, mark task done, move task, delete done task.
- Add appointment with time and duration, then delete it.
- Use `Telecharger cloud` and `Envoyer local vers cloud`.
- Logout and optionally clear local data.

## JavaScript style guidelines

Derived from `auth.js` and `script.js`.

- Language level: modern browser JS (`const`/`let`, async/await, optional chaining).
- Module style: plain scripts attached in HTML with `defer`; no ES module imports.
- Imports: none in current architecture. Prefer CDN script tags for browser libs if needed.
- Indentation: 2 spaces.
- Semicolons: required and consistently used.
- Quotes: double quotes for strings.
- Trailing commas: used in multiline arrays/objects/calls.
- Naming:
  - constants: `UPPER_SNAKE_CASE` (for storage keys, collection names, fixed values)
  - functions/variables: `camelCase`
  - DOM refs: suffix `El` (example: `loginFormEl`)
  - boolean helpers: `is*` / `has*` naming where meaningful
- Prefer small single-purpose functions.
- Prefer early returns for invalid inputs and guard clauses.
- Prefer pure helpers for parsing/normalization before DOM updates.

## Data and state conventions

- Frontend state is in module-level variables (example: `schedule`, `pocketbase`).
- Persist planner state with `localStorage` using stable key constants.
- Keep persisted payloads JSON-serializable.
- Normalize loaded data before rendering (see `normalizeSchedule`).
- Use generated IDs for client-side list items (`makeId`).

## Error handling conventions

- Wrap async PocketBase calls in `try/catch`.
- Display user-facing errors via status UI, not `alert` for normal failures.
- Keep errors actionable and human-readable.
- For unknown errors, safely fallback to generic message extraction.
- Use graceful fallback behavior when parsing fails (return empty/default state).
- Do not throw on expected user input problems; validate and return early.

## DOM and event handling conventions

- Build dynamic UI using `document.createElement` for complex nodes.
- Use `innerHTML` only for small controlled templates.
- Attach listeners close to element creation for readability.
- Re-render from source state after each mutation (`saveSchedule(); render();`).
- Keep accessibility attributes in place (`aria-label`, `role`, `aria-live`).
- Preserve `defer` script loading in HTML.

## CSS style guidelines

Derived from `auth.css` and `style.css`.

- Use CSS custom properties in `:root` for color/system tokens.
- Prefer kebab-case class names (`auth-shell`, `appointment-form`).
- Keep spacing, border-radius, and color values consistent via tokens.
- Keep layouts responsive with media queries (existing breakpoints around 720/860px).
- Maintain visible focus states via `:focus-visible`.
- Preserve minimum touch target sizing (`min-height: 44px` on controls).

## HTML conventions

- Keep semantic structure (`main`, `section`, `article`, headings).
- Keep form labels explicitly associated with inputs.
- Preserve French UX copy unless task explicitly requires language change.
- Continue loading third-party dependencies from pinned CDN versions.

## PocketBase integration conventions

- Reuse `PB_URL_KEY` for stored server URL.
- Verify `pocketbase.authStore.isValid` before protected actions.
- Keep collection name constantized (`PB_COLLECTION`).
- For snapshot writes, serialize schedule with `JSON.stringify`.
- Maintain owner-based filtering in backend queries.

## Agent change policy for this repo

- Do not introduce a build system unless explicitly requested.
- Do not add heavy frameworks for small UI changes.
- Keep changes minimal and aligned with current vanilla JS architecture.
- When adding tooling (lint/tests), document exact commands in this file.
- If you add Cursor/Copilot rules later, add a new section summarizing them here.
