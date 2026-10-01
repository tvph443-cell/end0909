# AGENTS.md

Terminal-style chat (pt-BR UI) with name+password claim login and an admin panel.

## Architecture
- `public/` — static frontend, no build step (`netlify.toml` publishes it directly).
  - `index.html` + `app.js`: three views toggled via `hidden` — construction, login, chat.
  - `admin.html` + `admin.js`: admin panel (served at `/admin` via redirect).
  - `api.js`: shared `api()` fetch wrapper (Bearer token from localStorage), `el()` DOM helper, date formatters.
  - `style.css`: all styling; CSS variables at the top (dark bg, `--green` accent, `--amber` for warnings/system).
- `netlify/functions/` — API (one function per area, routes in `config.path`):
  - `auth.mts`: `/api/login`, `/api/logout`, `/api/me`.
  - `chat.mts`: public `/api/config`; authed `/api/messages` (GET `?after=<id>` for polling, POST to send).
  - `admin.mts`: `/api/admin/*` — settings, stats, users, messages. Requires `users.is_admin`.
- `netlify/lib/core.ts` — shared helpers (hashing, sessions, `currentUser`, settings with defaults). Kept outside
  `netlify/functions/` so it is not deployed as a function.
- `db/schema.ts` — Drizzle schema (users, sessions, messages, settings). Migrations in `netlify/database/migrations/`.

## Non-obvious decisions
- Login = claim: unknown name is created with the given password; known name requires that password. Names are
  unique case-insensitively via `name_key`.
- The first claim of the name `admin` gets `is_admin = true`. Admins can promote others in the panel.
- Construction mode (`settings.construction`, default `"true"` in `DEFAULT_SETTINGS`) hides the chat for non-admins,
  both in the UI and in the API (503). Admins still see the chat.
- Messages with `kind = "system"` and `user_id = null` are admin announcements.
- Real-time is short polling (2s, slower when the tab is hidden). "Online" = `last_seen_at` within 60s.
- Deleting a user cascades to their sessions and messages and frees the name.

## Conventions
- UI copy in Portuguese (pt-BR), lowercase terminal tone.
- To add an editable text/setting: add a key to `DEFAULT_SETTINGS`, expose it in `/api/config` if public, and add a
  field in `admin.html`/`admin.js`. No migration needed (key/value table).
- Schema changes: edit `db/schema.ts`, then `npx drizzle-kit generate --name <verb_description>`. Never edit applied migrations.
