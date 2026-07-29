# AGENTS.md

## Cursor Cloud specific instructions

Split Bill Calculator — a multi-currency expense-splitting web app.

- **Backend**: FastAPI + SQLAlchemy + SQLite, in `backend/`, serves on port **8449**.
- **Frontend**: SvelteKit 2 + Svelte 5 + Vite, in `frontend/`, serves on port **8448**.
- The frontend dev server proxies `/api/*` → backend `:8449` (stripping the `/api` prefix); see `frontend/vite.config.ts`.

### Environment already provisioned in the VM snapshot
- Backend virtualenv at `backend/.venv` (system pkg `python3.12-venv` is installed).
- `backend/.env` (gitignored) — created for dev. Key values: `DEV_BYPASS_EMAILS`, `SBC_SKIP_SEED=false`, `CORS_ALLOW_ORIGINS`.
- SQLite dev DB at `backend/data/sbc.db` (gitignored), schema applied via Alembic.
- VM timezone is set to **Asia/Shanghai (UTC+8)** and `~/.bashrc` exports `TZ=Asia/Shanghai`. The app formats times in local time and assumes UTC+8; this is also required for the frontend `format.test.ts` unit tests to pass.

### Running the services
- Backend (from `backend/`): `.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8449 --env-file .env --reload`
  - `--env-file .env` is important: `app/api/auth.py` reads `DEV_BYPASS_EMAILS` via `os.getenv(...)` at import time, so it must be in the process environment.
- Frontend (from `frontend/`): `npm run dev -- --host 0.0.0.0 --port 8448`
  - On first start Vite runs a one-time dependency pre-optimization then reloads (`optimized dependencies changed. reloading`). Wait a few seconds for it to settle before driving the UI; dynamic `import()` of route pages can transiently 500 / "Failed to fetch dynamically imported module" during that reload.

### Database schema (Alembic)
- Migrations are NOT run by the startup/update script. If the DB is missing or a migration was added, run from `backend/`: `.venv/bin/alembic upgrade head`.

### Dev auth + seed data
- Login is passwordless: request a code, then submit any 6-digit code. Emails listed in `DEV_BYPASS_EMAILS` (currently `xinhua1001@outlook.com`, `demo@example.com`) skip SMTP entirely and accept any code — use these for browser/QA flows (no real inbox needed).
- With `SBC_SKIP_SEED=false`, startup idempotently seeds `xinhua1001@outlook.com` + a Thailand test session (40 bills, THB+CNY) + an empty personal session (`backend/scripts/seed_dev_data.py`).

### Lint / test / build
- Backend lint: `.venv/bin/ruff check .` (from `backend/`).
- Backend tests: `.venv/bin/pytest` (from `backend/`).
- Frontend type-check/lint: `npm run check` (from `frontend/`).
- Frontend unit tests: `npm run test:unit`; e2e (Playwright): `npm run test:e2e`.
- Frontend build: `npm run build`.

### Known pre-existing issues (NOT environment problems — do not chase as setup bugs)
- Backend `pytest` (full suite) shows ~78 failures. Root cause is repo test code: several test files (`test_sessions.py`, `test_sessions_flow.py`, `test_auth*.py`, etc.) define the truncate fixture twice — a second plain `def _truncate_all()/_truncate_auth_tables()` shadows the `@pytest.fixture(autouse=True)` one, so between-test truncation never runs and rows accumulate (UNIQUE-constraint / isolation failures). Individual tests pass when run alone. A few `test_unit_settle.py` cases also assert rounding that `_compute_balances` doesn't implement. ~405 tests pass.
- `frontend/src/lib/components/BillForm.svelte` has a syntax error in its `<style>`/comment region (~lines 313–319: stray CSS/`}` inside a JS comment). This breaks the bill create/edit pages (SvelteKit 500 on `/s/[code]/bills/new`). The rest of the app (auth, session/ledger CRUD, settlement views) works.
- `npm run check` reports ~97 pre-existing type/a11y errors; `ruff check` reports ~420 pre-existing findings. Both are non-blocking for running the app.
