/**
 * TEST-012 — Settle algorithm conservation (sum of nets ≈ 0)
 *
 * Covers: Coverage-Gaps.md gap #12 (PRD §3.5 / SPEC §7)
 *
 * What this verifies
 * ------------------
 * For every settle scenario the BE returns, the sum of all member
 * balances' `net` values must round to 0.00 (within cent precision).
 *
 * This is the conservation law: the total paid by all members must
 * equal the total consumed by all members, so paid_sum - consumed_sum
 * = 0, hence net_sum = 0. If the algorithm or Decimal rounding is
 * buggy, this catches it (float drift, missing bills, currency
 * conversion errors, exclusive amount miscount, etc.).
 *
 * 4 scenarios:
 *   A: 3 members, 1 bill split evenly AA
 *   B: 4 members, 4 bills (each pays one + extra by A)
 *   C: multi-currency (CNY + USD) with conversion
 *   D: 3 members, 2 bills with 1 exclusive (one member pays for self only)
 */
import { test, expect } from "@playwright/test";
import { wipeDb, ensureUserAndToken } from "./test-helpers";

const BASE = "http://localhost:8448";

test.beforeEach(() => {
  wipeDb();
});

/** Helper: assert sum of balances.net rounds to 0.00 within 1 cent tolerance.
 *  balances shape: { [member_id: string]: "100.00" | "-50.00" | ... } (dict keyed by member_id) */
function assertConservation(balances: Record<string, string> | undefined, label: string) {
  expect(balances, `[${label}] balances must be present`).toBeTruthy();
  const values = Object.values(balances ?? {});
  const total = values.reduce((acc, n) => acc + Number(n), 0);
  // Allow ±1 cent tolerance for rounding noise (Decimal ROUND_HALF_UP).
  expect(
    Math.abs(total),
    `[${label}] sum of balances must round to 0 (conservation). Got: ${total.toFixed(6)} from ${values.length} members.`
  ).toBeLessThanOrEqual(0.01);
}

async function createSession(
  request: any,
  opts: {
    name: string;
    currencies?: string[];
    primary_currency?: string;
    exchange_rates?: Array<{ from_currency: string; to_currency: string; rate: string }>;
    member_nicknames?: string[];
  }
) {
  const res = await request.post(`${BASE}/api/sessions`, {
    data: {
      name: opts.name,
      currencies: opts.currencies ?? ["CNY"],
      primary_currency: opts.primary_currency ?? "CNY",
      exchange_rates: opts.exchange_rates,
      member_nicknames: opts.member_nicknames,
    },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function createBill(
  request: any,
  sid: number,
  user: any,
  opts: {
    payer_id: number;
    amount: number;
    currency: string;
    description: string;
    participants: Array<{ member_id: number; is_exclusive?: boolean; exclusive_amount?: number }>;
  }
) {
  const res = await request.post(`${BASE}/api/sessions/${sid}/bills`, {
    headers: { Cookie: `sbc_session=${user.raw_token}` },
    data: {
      amount: opts.amount,
      payer_member_id: opts.payer_id,
      occurred_at: new Date().toISOString(),
      currency: opts.currency,
      description: opts.description,
      participants: opts.participants.map((p) => ({
        member_id: p.member_id,
        is_exclusive: p.is_exclusive ?? false,
        exclusive_amount: p.exclusive_amount ?? 0,
      })),
      amount_expression: String(opts.amount),
      use_calculator: false,
    },
  });
  expect(res.status(), `create bill "${opts.description}" should succeed`).toBe(201);
}

/** Helper: get full session detail (members included) — POST returns summary only. */
async function getSessionDetail(request: any, sid: number, user: any) {
  const r = await request.get(`${BASE}/api/sessions/${sid}`, {
    headers: { Cookie: `sbc_session=${user.raw_token}` },
  });
  expect(r.status()).toBe(200);
  return r.json();
}

async function createSessionAndDetail(
  request: any,
  user: any,
  opts: {
    name: string;
    currencies?: string[];
    primary_currency?: string;
    exchange_rates?: Array<{ from_currency: string; to_currency: string; rate: string }>;
    member_nicknames?: string[];
  }
) {
  const res = await request.post(`${BASE}/api/sessions`, {
    headers: { Cookie: `sbc_session=${user.raw_token}` },
    data: {
      name: opts.name,
      currencies: opts.currencies ?? ["CNY"],
      primary_currency: opts.primary_currency ?? "CNY",
      exchange_rates: opts.exchange_rates,
      member_nicknames: opts.member_nicknames,
    },
  });
  expect(res.status()).toBe(201);
  const summary = await res.json();
  return getSessionDetail(request, summary.id, user);
}

test("TEST-012A: 3 members, 1 bill AA → conservation holds", async ({ request }) => {
  const user = ensureUserAndToken("settle12.alice@jessejia.local");
  const session = await createSessionAndDetail(request, user, {
    name: "TEST-012A AA",
    member_nicknames: ["A", "B", "C"],
  });
  const sid = session.id;
  const memberIds = session.members.map((m: any) => m.id);

  await createBill(request, sid, user, {
    payer_id: memberIds[0],
    amount: 300,
    currency: "CNY",
    description: "300 CNY split 3 ways",
    participants: memberIds.map((mid: number) => ({ member_id: mid })),
  });

  const settleRes = await request.get(`${BASE}/api/sessions/${sid}/settle`, { headers: { Cookie: `sbc_session=${user.raw_token}` } });
  expect(settleRes.status()).toBe(200);
  const settle = await settleRes.json();
  assertConservation(settle.balances, "TEST-012A");
});

test("TEST-012B: 4 members, 4 bills (mixed payers) → conservation holds", async ({ request }) => {
  const user = ensureUserAndToken("settle12.bob@jessejia.local");
  const session = await createSessionAndDetail(request, user, {
    name: "TEST-012B 4x4",
    member_nicknames: ["A", "B", "C", "D"],
  });
  const sid = session.id;
  const m = session.members.map((mm: any) => mm.id);
  const allPpts = m.map((mid: number) => ({ member_id: mid }));

  await createBill(request, sid, user, { payer_id: m[0], amount: 100, currency: "CNY", description: "by A", participants: allPpts });
  await createBill(request, sid, user, { payer_id: m[1], amount: 200, currency: "CNY", description: "by B", participants: allPpts });
  await createBill(request, sid, user, { payer_id: m[2], amount: 50,  currency: "CNY", description: "by C", participants: allPpts });
  await createBill(request, sid, user, { payer_id: m[3], amount: 25,  currency: "CNY", description: "by D", participants: allPpts });

  const settle = await (await request.get(`${BASE}/api/sessions/${sid}/settle`, { headers: { Cookie: `sbc_session=${user.raw_token}` } })).json();
  assertConservation(settle.balances, "TEST-012B");
});

test("TEST-012C: multi-currency (CNY + USD with rate) → conservation in primary", async ({ request }) => {
  const user = ensureUserAndToken("settle12.cathy@jessejia.local");
  const session = await createSessionAndDetail(request, user, {
    name: "TEST-012C multi-ccy",
    currencies: ["CNY", "USD"],
    primary_currency: "CNY",
    exchange_rates: [{ from_currency: "USD", to_currency: "CNY", rate: "7.0" }],
    member_nicknames: ["A", "B", "C"],
  });
  const sid = session.id;
  const m = session.members.map((mm: any) => mm.id);
  const allPpts = m.map((mid: number) => ({ member_id: mid }));

  await createBill(request, sid, user, { payer_id: m[0], amount: 100, currency: "CNY", description: "by A 100CNY", participants: allPpts });
  await createBill(request, sid, user, { payer_id: m[1], amount: 50,  currency: "USD", description: "by B 50USD = 350CNY", participants: allPpts });
  await createBill(request, sid, user, { payer_id: m[2], amount: 30,  currency: "USD", description: "by C 30USD = 210CNY", participants: allPpts });

  const settle = await (await request.get(`${BASE}/api/sessions/${sid}/settle`, { headers: { Cookie: `sbc_session=${user.raw_token}` } })).json();
  // Conservation must hold in the primary currency (settle is converted).
  assertConservation(settle.balances, "TEST-012C");
});

test("TEST-012D: 3 members with 1 exclusive-amount bill → conservation holds", async ({ request }) => {
  const user = ensureUserAndToken("settle12.dave@jessejia.local");
  const session = await createSessionAndDetail(request, user, {
    name: "TEST-012D exclusive",
    member_nicknames: ["A", "B", "C"],
  });
  const sid = session.id;
  const m = session.members.map((mm: any) => mm.id);

  await createBill(request, sid, user, {
    payer_id: m[0], amount: 90, currency: "CNY", description: "shared",
    participants: m.map((mid: number) => ({ member_id: mid })),
  });

  await createBill(request, sid, user, {
    payer_id: m[1], amount: 30, currency: "CNY", description: "B's exclusive A-only",
    participants: [{ member_id: m[0], is_exclusive: true, exclusive_amount: 30 }],
  });

  const settle = await (await request.get(`${BASE}/api/sessions/${sid}/settle`, { headers: { Cookie: `sbc_session=${user.raw_token}` } })).json();
  assertConservation(settle.balances, "TEST-012D");
});