# Architecture

轻均 FairLite is a two-app monorepo: a FastAPI API and a SvelteKit SPA.

## Runtime

```
Browser (SvelteKit :8448)
    │  /api/*  (Vite proxy in dev)
    ▼
FastAPI (:8449)
    │
    ▼
SQLite (backend/data/sbc.db)
```

No Redis or external queue is required for the core product.

## Auth model

| Mode | How |
|------|-----|
| Logged-in | Email verification code → opaque session cookie |
| Anonymous member | `X-Nickname-Secret` header + `localStorage` binding |
| Invite | Unguessable invite token / session code paths |

Dev-only: emails listed in `DEV_BYPASS_EMAILS` accept any 6-digit code. Keep that list empty outside local/test.

## Domain concepts

- **Session (账本):** ledger with currencies, members, bills, settlements
- **Member:** nickname slot; may be anonymous or bound to a user
- **Bill:** amount + payer + participants (shared and/or exclusive)
- **Exchange rate:** owner-managed snapshot used for settlement in primary currency
- **Settlement record:** recorded repayment that reduces suggested transfers

## Public vs authenticated APIs

Public preview endpoints (`/sessions/{id}/preview`, `/sessions/by-code/{code}/preview`) return only join UI fields. Emails are **masked server-side**. Full invite tokens are **not** returned on unauthenticated preview.

Authenticated session detail may return invite material to the **owner** only.

## Frontend routes (canonical)

| Path | Purpose |
|------|---------|
| `/` | Landing |
| `/auth/login` | Email login |
| `/sessions` | My ledgers |
| `/s/{code}` | Ledger home |
| `/s/{code}/join` | Join / claim nickname |
| `/s/{code}/bills/new` | Create bill |
| `/s/{code}/settle` | Settlement |

Legacy `/sessions/{id}/…` routes still exist for compatibility.

## Design

Mobile-first “liquid glass” UI with local CSS tokens (no third-party component library). Primary viewport target is phone width.
