# AGENTS.md

## Cursor Cloud specific instructions

Split Bill Calculator — multi-currency expense-splitting (FastAPI `:8449` + SvelteKit `:8448`). Frontend Vite proxies `/api/*` → backend. Standard run/lint/test commands live in `backend/` / `frontend/` package scripts and the setup-environment docs.

### Modal / bottom-sheet close (portal gotcha)

Sheets (`CurrencyAddModal`, `AddSettlementSheet`, invite QR, etc.) use `use:portal` to escape `backdrop-filter` containing blocks. **`frontend/src/lib/actions/portal.ts` must `removeChild` on destroy** — do not move the host back to its original parent. With parent `{#if open}` + Svelte 5 `$state`, moving the node back orphans the sheet under `<section>`: dismiss callbacks run and state flips to `false`, but the modal stays visible.

Close wiring: pass `dismiss={() => (open = false)}` (plain prop name). Keep `on:close` + `createEventDispatcher` as a backup if present.

### Dev auth

Passwordless login; emails in `DEV_BYPASS_EMAILS` accept any 6-digit code. Seeded Thailand session is useful for multi-currency + settle UI checks.

### Feature-matrix test data

When `SBC_SKIP_SEED=false`, startup seeds tagged ledgers whose **账本名称 / 账单名称** annotate the feature under test (e.g. `[单币有账·锁副币]只能CNY`). Catalog: `docs/TEST_DATA_MATRIX.md`. Re-run: `cd backend && SBC_SKIP_SEED=false .venv/bin/python -m scripts.seed_dev_data`.
