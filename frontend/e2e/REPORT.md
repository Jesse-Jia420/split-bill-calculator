# T16 E2E Test Report

**Date**: 2026-07-01T08:43:33.490Z
**Backend commit**: `4b97fb6a`
**Test runner**: Playwright (Chromium headless)
**Frontend**: Vite dev server on http://localhost:8448
**Backend**: FastAPI on http://localhost:8449 (proxied via /api)

## Environment

- Node: v18.19.1
- Project root: `/config/workspace/split-bill-calculator`
- Screenshots: `frontend/e2e/screenshots/`

## What this test covers

1. Owner (Alice) logs in via seeded cookie → renders /sessions without redirect
2. Creates a session named "E2E Test Trip"
3. Two more users (Bob, Carol) join via the invite link — separate browser contexts to verify cross-user isolation
4. Owner creates 3 bills (lunch/cab/hotel) — covering normal AA + partial-share participants
5. Owner opens the Settle page, screenshots both Overview and Personal-View tabs (v0.1.2 / T18)
6. Bob views the same session in his own browser — asserts cross-user view consistency
7. Bob (non-creator) deletes a bill — v0.1.2 (T17) allows any-member deletion
8. Settle endpoint balances sum to ~0 (algorithm correctness)
## Screenshots

### Step 1: Owner lands on /sessions (empty)

![Owner lands on /sessions (empty)](./screenshots/01-owner-sessions-empty.png)

> User `alice.e2e@jessejia.local` is logged in via seeded cookie. The page renders without redirecting to /auth/login.


### Step 4: Owner fills in 'New session' form

![Owner fills in 'New session' form](./screenshots/02-owner-new-session-form.png)

> Types "E2E Test Trip" into the name field. The form's <code>id="name"</code> input is the binding target for the SvelteKit form.


### Step 7: Owner is in the new (empty) session

![Owner is in the new (empty) session](./screenshots/03-owner-session-detail-empty.png)

> URL = <code>http://localhost:8448/sessions/1</code>. Session detail page shows the empty-state ("no bills yet") and an owner-only invite button.


### Step 10: Bob opens the invite link (logged in)

![Bob opens the invite link (logged in)](./screenshots/04-bob-invite-accept.png)

> Bob navigates to <code>/invites/tD54WqqOs1B7…</code> and sees the session preview. He fills in his display name.


### Step 13: Owner fills Bill #1: lunch 300, paid by Alice, all 3 share

![Owner fills Bill #1: lunch 300, paid by Alice, all 3 share](./screenshots/05-owner-bill-1-form.png)

> The form's amount/payer/desc/occurredAt fields are bound to <code>BillForm.svelte</code>. Participants list checks all three members.


### Step 16: Session detail with 3 bills

![Session detail with 3 bills](./screenshots/06-owner-session-3-bills.png)

> lunch (300 by Alice, all share), cab (150 by Bob, all share), hotel night (600 by Carol, Bob+Carol). Total = 1050.


### Step 19: Settle page — overview tab (transfers list)

![Settle page — overview tab (transfers list)](./screenshots/07-owner-settle-overview.png)

> Per-member net + transfer path. Expected: Alice paid 300 + consumed 100+50=150 = +150; Bob paid 150 + consumed 100+50+300=450 = -300; Carol paid 600 + consumed 100+50+300=450 = +150. Sum = 0.


### Step 22: Settle page — personal-view tab (per-member breakdown)

![Settle page — personal-view tab (per-member breakdown)](./screenshots/08-owner-settle-personal.png)

> v0.1.2 (T18): per-member breakdown — paid_bills, consumed_bills, totals.


### Step 25: Bob views the session in his own browser

![Bob views the session in his own browser](./screenshots/09-bob-session-view.png)

> Bob's cookie (<code>bob.e2e@jessejia.local</code>) is logged in. He can read all 3 bills and the settle page — but cannot rotate the invite or rename others (asserted separately in the permission-matrix tests).


### Step 28: Bob's settle view matches Alice's

![Bob's settle view matches Alice's](./screenshots/10-bob-settle.png)

> Cross-user view consistency: both see the same transfers (greedy pairing is deterministic given the same bills).


### Step 31: Bob (non-creator) deletes a bill — v0.1.2 (T17)

![Bob (non-creator) deletes a bill — v0.1.2 (T17)](./screenshots/11-bob-after-delete.png)

> v0.1.2 changed the rule: any session member can delete (creator-only removed in T17). The bill list shrinks from 3 → 2 rows.

