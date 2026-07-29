## Cursor Cloud specific instructions

### Services overview

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| Backend (FastAPI) | `cd backend && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000` | 8000 | Requires Redis (`redis-server --daemonize yes`). API docs at `/docs`. |
| Frontend (SvelteKit) | `cd frontend && npm run dev -- --host 0.0.0.0 --port 5173` | 5173 | Vite proxies `/api` → `localhost:8000`. |
| Redis | `redis-server --daemonize yes` | 6379 | Required by backend for rate limiting & caching. |

No Docker Compose is needed for local/cloud-agent development. Redis is the only external dependency.

### Environment / secrets

- Backend loads `.env` from the **repo root** (`/workspace/.env`), not `backend/.env`.
- Required vars (see `.env.example`): `SECRET_KEY`, `ACCESS_TOKEN_EXPIRE_MINUTES`, `DATABASE_URL`, `REDIS_URL`.
- Optional: `CORS_ORIGINS` (defaults to `*`), SMTP vars (email verification — not needed for core flows), `SENTRY_DSN`.
- Frontend needs no env vars for local/cloud-agent development (Vite proxy handles API routing).

### Lint / test / build / run

Standard commands are in the root `Makefile` and package scripts. Non-obvious notes:

- **Backend lint**: `cd backend && ruff check app/` (config in `backend/pyproject.toml`).
- **Backend tests**: `cd backend && python -m pytest tests/ -v`. Some Redis-dependent tests fail if Redis is not running; core API/DB tests pass without it.
- **Frontend check**: `cd frontend && npm run check` (svelte-check). Pre-existing type warnings may exist in older components; treat new errors as the signal.
- **Frontend lint**: `cd frontend && npm run lint` (prettier + eslint).
- **Frontend unit tests**: `cd frontend && npm run test:unit`.
- **Frontend build**: `cd frontend && npm run build`.
- **E2E**: `cd frontend && npm run test:e2e` (Playwright). Needs both backend + frontend running, or use the e2e project's own setup.
- Do **not** run `npm audit fix` / dependency major upgrades unless explicitly asked — lockfile is the source of truth.

### Known cloud-agent gotchas

- **SvelteKit portal destroy (IMPORTANT)**: A Svelte 5 + portal pattern can crash the browser tab with `Uncaught Error: This should never happen`. Root cause is destroying a portaled Dialog/Sheet while its trigger (or other reactive UI tied to the same state) is still updating. **Do not** put “close then navigate” in `onSuccess` for flows that open a Dialog — prefer navigate-only and let route change tear down the dialog. See `MemberForm` save/`onSuccess` and similar create/edit sheets.
- **Mobile / tunnel QA**: For phone testing, use Cloudflare Quick Tunnel (`cloudflared tunnel --url http://localhost:5173`). Share the `https://*.trycloudflare.com` URL. Auth cookies use `Path=/`, so they work behind the tunnel. If login looks OK but APIs 401, check Vite proxy targets and that the API host matches what the phone can reach.
- **BillForm / large Svelte SFCs**: History includes brace-mismatch build failures after partial edits. After editing `BillForm.svelte` (or other large SFCs), run `npm run check` / `npm run build` before assuming the app is healthy. Current tree should have balanced braces; do not “fix” by large unrelated rewrites.
- **Redis**: Must be started before the backend or rate-limiting middleware errors on first request. `redis-server --daemonize yes` is enough.
- **Feature matrix / seed data**: Clearing DB wipes demo users. Re-seed with `cd backend && python seed_feature_matrix.py` when you need the full account/session matrix again.
- **Python version**: Backend targets 3.11+ (`requires-python = ">=3.11"`). System Python 3.12 works.
- **Node version**: Frontend uses Node 20+ (Vite 7). Node 22 works.

### Hello-world smoke path

1. Start Redis → backend → frontend.
2. Open `http://localhost:5173`, register a user (or use an existing seeded account).
3. Create a session → add a bill → open settlement — that exercises the core split-bill loop.
