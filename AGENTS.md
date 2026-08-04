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
- To inject UAT fixtures for a specific inbox: set `SEED_USER_EMAIL=...` and `SBC_SKIP_SEED=false`, then `python -m scripts.seed_dev_data` (or restart backend). Also add that email to `DEV_BYPASS_EMAILS` for OTP-free login.

### Lint / test / run

See root `README.md` and `CONTRIBUTING.md`. Non-obvious notes:

- Frontend `npm run check` may report pre-existing warnings; treat new errors as regressions.
- E2E needs backend + frontend (or Playwright project setup). Prefer a disposable SQLite file — never point destructive helpers at a personal DB.
- After editing large SFCs (`BillForm.svelte`, `s/[code]/+page.svelte`), run `npm run check` before assuming the app is healthy.

### Product notes

- Product name: **轻均 FairLite** (UI / titles / share text). Repo package ids may still say `split-bill-calculator`.
- Canonical ledger URLs: `/s/{code}`. Legacy `/sessions/{id}` still exists.
- UI is Chinese-only today.
- Architecture overview: `docs/ARCHITECTURE.md`. Open-source polish backlog: `docs/OPEN_SOURCE_READINESS.md`.
- **Anon device secret ≠ invite link.** `nickname_secret` (localStorage `sbc.actingAs.*`) proves a seat on one device; invite `session_code` / `invite_token` stay stable. Login bind/claim clears `nickname_secret` (FE should drop LS keys). One logged-in user may occupy only one nickname per ledger (`already_a_member` 409).
- **Expired anon ledgers** (7-day inactivity, no logged-in member): BE sets `archived=True` and returns **410** on member-gated routes (including bill/settle via `get_session_member_or_secret`). Archived sessions are omitted from `GET /sessions`.
- **Login OTP + tab backgrounding:** Global `+layout.svelte` hard-reloads after a long `visibilitychange` hide (to avoid stale UI). On `/auth/login` and `/sessions/{id}/login` that reload is skipped so users can leave for mail and still enter the code. Verify-step email is also persisted in `sessionStorage` via `$lib/utils/loginDraft` (15 min TTL) as a remount fallback.
