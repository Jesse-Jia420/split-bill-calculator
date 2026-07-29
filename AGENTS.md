# AGENTS.md

## Cursor Cloud specific instructions

Split Bill Calculator — multi-currency expense-splitting (FastAPI `:8449` + SvelteKit `:8448`). Frontend Vite proxies `/api/*` → backend. Standard run/lint/test commands live in `backend/` / `frontend/` package scripts and the setup-environment docs.

### Modal / bottom-sheet close (portal gotcha)

Sheets (`CurrencyAddModal`, `AddSettlementSheet`, invite QR, etc.) use `use:portal` to escape `backdrop-filter` containing blocks. **`frontend/src/lib/actions/portal.ts` must `removeChild` on destroy** — do not move the host back to its original parent. With parent `{#if open}` + Svelte 5 `$state`, moving the node back orphans the sheet under `<section>`: dismiss callbacks run and state flips to `false`, but the modal stays visible.

Close wiring: pass `dismiss={() => (open = false)}` (plain prop name). Keep `on:close` + `createEventDispatcher` as a backup if present.

### Dev auth

Passwordless login; emails in `DEV_BYPASS_EMAILS` accept any 6-digit code. Seeded Thailand session is useful for multi-currency + settle UI checks.

### Mobile / phone QA (Cloud Agent)

`127.0.0.1:8448` on a **phone** is the phone itself — it will **not** reach the Cloud VM. Services in the VM listen on `0.0.0.0:8448` / `0.0.0.0:8449` (tmux `sbc-frontend`, `sbc-backend`).

**Phone testing (recommended):** run a public tunnel, then open the HTTPS URL on the phone:

```bash
bash scripts/mobile-dev-tunnel.sh
# → copy https://xxxx.trycloudflare.com/sessions
```

`frontend/vite.config.ts` allows `.trycloudflare.com` and `.loca.lt` hosts. API calls go through the Vite proxy (same origin), so CORS changes are usually unnecessary.

**Desktop in Cursor:** use **Ports / Desktop pane** port forwarding for `8448`, then open `http://127.0.0.1:8448` on the **same machine** that runs Cursor — not on the phone.

**Local Mac dev (not Cloud VM):** phone and Mac on same Wi‑Fi → `http://<Mac-LAN-IP>:8448` with `npm run dev -- --host 0.0.0.0`.

### Feature-matrix test data

When `SBC_SKIP_SEED=false`, startup seeds tagged ledgers whose **账本名称 / 账单名称** annotate the feature under test (e.g. `[单币有账·锁副币]只能CNY`). Catalog: `docs/TEST_DATA_MATRIX.md`. Re-run: `cd backend && SBC_SKIP_SEED=false .venv/bin/python -m scripts.seed_dev_data`.
