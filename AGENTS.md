## Cursor Cloud specific instructions

### Services

| Service | Command | Port |
|---------|---------|------|
| Backend | `cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --host 0.0.0.0 --port 8449` | 8449 |
| Frontend | `cd frontend && npm run dev -- --host 0.0.0.0 --port 8448` | 8448 |

No Redis. No Docker required for local/cloud-agent development. Vite proxies `/api` → `127.0.0.1:8449`.

### Environment

- Backend reads **`backend/.env`** (see `backend/.env.example`). Root `.env` is only for optional Docker/tunnel tokens.
- Leave `DEV_BYPASS_EMAILS` empty unless you intentionally need local login without SMTP. Prefer `demo@example.com` for synthetic bypass, never real inboxes.
- `SBC_SKIP_SEED=true` is recommended so restarts do not inject demo ledgers.

### Lint / test / run

See root `README.md` and `CONTRIBUTING.md`. Non-obvious notes:

- Frontend `npm run check` may report pre-existing warnings; treat new errors as regressions.
- E2E needs backend + frontend (or Playwright project setup). Prefer a disposable SQLite file — never point destructive helpers at a personal DB.
- After editing large SFCs (`BillForm.svelte`, `s/[code]/+page.svelte`), run `npm run check` before assuming the app is healthy.

### Product notes

- Canonical ledger URLs: `/s/{code}`. Legacy `/sessions/{id}` still exists.
- UI is Chinese-only today.
- Architecture overview: `docs/ARCHITECTURE.md`. Open-source polish backlog: `docs/OPEN_SOURCE_READINESS.md`.
