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

**Cursor port forward (common):** On Mac, `lsof -nP -iTCP:8448 -sTCP:LISTEN` may show `Cursor … TCP 127.0.0.1:8448` — not `node`/`vite` on `*:8448`. That means only **Mac localhost** works; `http://192.168.10.194:8448` and phone LAN access will **fail** even on the Mac. This is expected.

| Goal | What to do |
|------|------------|
| Phone test, keep Cloud Agent dev | `bash scripts/mobile-dev-tunnel.sh` → open `https://xxxx.trycloudflare.com` on phone |
| Phone on same Wi‑Fi via LAN IP | Run `uvicorn` + `npm run dev` **natively on the Mac** (not via Cursor forward); confirm `lsof` shows `node` on `*:8448` |

**Phone testing (Cloud VM tunnel):**

```bash
bash scripts/mobile-dev-tunnel.sh
# → copy https://xxxx.trycloudflare.com/sessions
```

`frontend/vite.config.ts` allows `.trycloudflare.com` and `.loca.lt` hosts. API calls go through the Vite proxy (same origin), so CORS changes are usually unnecessary.

**Desktop in Cursor:** use **Ports / Desktop pane** port forwarding for `8448`, then open `http://127.0.0.1:8448` on the **same Mac** — LAN IP will not work while only Cursor holds `127.0.0.1:8448`.

**Local Mac dev (not Cloud VM):** phone and Mac on same Wi‑Fi → `http://<Mac-LAN-IP>:8448`.

1. Frontend must listen on all interfaces: `cd frontend && npm run dev` (vite.config already sets `host: 0.0.0.0`).
2. Backend on same Mac: `cd backend && .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8449`.
3. `allowedHosts` defaults to `true` in dev so `192.168.x.x` works. Optional: `SBC_LAN_HOST=192.168.10.194 npm run dev` for HMR over LAN.
4. If still refused: confirm Mac IP (`ipconfig getifaddr en0`), disable guest-network AP isolation, allow **node** in macOS Firewall.

### Feature-matrix test data

When `SBC_SKIP_SEED=false`, startup seeds tagged ledgers whose **账本名称 / 账单名称** annotate the feature under test (e.g. `[单币有账·锁副币]只能CNY`). Catalog: `docs/TEST_DATA_MATRIX.md`. Re-run: `cd backend && SBC_SKIP_SEED=false .venv/bin/python -m scripts.seed_dev_data`.
