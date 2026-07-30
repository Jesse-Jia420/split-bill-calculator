# SplitIt

Mobile-first shared expense (AA) web app. Create a ledger, invite friends (including anonymous join), record multi-currency bills, and settle who owes whom.

**Language:** the UI is currently Chinese-only. English i18n is not included yet.

## Features

- Multi-person ledgers with invite links and anonymous nickname slots
- Bill CRUD with shared / exclusive (personal) consumption
- Multi-currency amounts with owner-managed exchange rates
- Settlement balances and recorded repayments
- Amount fields accept safe arithmetic expressions (e.g. `350/5`)
- Optional SMTP email verification (dev bypass via env, off by default)

## Stack

| Layer | Tech |
|-------|------|
| Frontend | SvelteKit 2 + Svelte 5 + TypeScript + Vite |
| Backend | FastAPI + SQLAlchemy 2 + Pydantic v2 + SQLite |
| Migrations | Alembic |
| Tests | pytest, Vitest, Playwright |

## Quick start

```bash
git clone <your-fork-or-clone-url>
cd split-bill-calculator

# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # edit SECRET_KEY and SMTP if needed
mkdir -p data
uvicorn app.main:app --reload --host 0.0.0.0 --port 8449

# Frontend (another terminal)
cd frontend
npm install
npm run dev -- --host 0.0.0.0 --port 8448
```

Open `http://localhost:8448`. Vite proxies `/api` to the backend on port `8449`.

### Optional demo seed

By default startup does **not** inject demo data when `SBC_SKIP_SEED=true` (recommended). To seed local fixtures:

```bash
cd backend
SBC_SKIP_SEED=false .venv/bin/python -m scripts.seed_dev_data
```

Demo login (only when listed in `DEV_BYPASS_EMAILS`): `demo@example.com` + any 6-digit code. Never enable bypass emails in production.

See `docs/TEST_DATA_MATRIX.md` for the seeded ledger matrix.

## Common commands

```bash
# Backend
cd backend && ruff check app/
cd backend && python -m pytest tests/ -q

# Frontend
cd frontend && npm run check
cd frontend && npm run test:unit
cd frontend && npm run build
```

## Project layout

```
backend/          FastAPI app, models, Alembic, seeds, tests
frontend/         SvelteKit app, unit + e2e tests
docs/             Architecture and contributor notes
docker-compose.yml  Optional self-host sketch (see comments inside)
```

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Configuration

Copy `backend/.env.example` → `backend/.env`. Important variables:

| Variable | Purpose |
|----------|---------|
| `SECRET_KEY` | App secret — generate a long random value for any shared deploy |
| `CORS_ALLOW_ORIGINS` | JSON array of allowed origins |
| `SMTP_*` | Email verification (optional in local/dev) |
| `DEV_BYPASS_EMAILS` | CSV of emails that skip SMTP (dev/test only) |
| `SBC_SKIP_SEED` | `true` skips startup demo seed (recommended default) |
| `COOKIE_SECURE` | Set `true` behind HTTPS |

Root `.env.example` is only for optional Docker / tunnel tokens.

## License

MIT — see [`LICENSE`](LICENSE).

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).
