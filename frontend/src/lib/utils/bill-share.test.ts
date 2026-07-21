/**
 * v0.3.20 #96 (PO msg 02:41 #7467): regression tests for the bill
 * share utilities extracted from BillListGrouped.svelte. The bug we
 * guarded against:
 *
 *   bill #95 (早餐 336 CNY, 2 参与者, Jesse 独占 36 CNY)
 *     - old code: yourShare = 336 / 2 = 168   (WRONG -- should be 150)
 *     - new code: yourShare = p.share_amount = 150 for Q
 *
 * Both ``yourShare`` and ``computePerCapitaBreakdown`` used to compute
 * ``b.amount / n`` without subtracting the exclusive portion. These
 * tests pin the corrected math.
 */

import { describe, it, expect } from "vitest";
import { yourShare, computePerCapitaBreakdown } from "./bill-share";
import type { Bill } from "../api/bills";

function mkBill(
  amount: number,
  participants: { member_id: number; is_exclusive?: boolean; exclusive_amount?: number; share_amount: number }[],
  currency: string = "CNY"
): Bill {
  return {
    id: 0,
    session_id: 0,
    payer_id: participants[0]?.member_id ?? 0,
    amount,
    currency,
    description: null,
    occurred_at: "2026-07-20T15:12:00+00:00",
    created_by: 0,
    created_by_session_member_id: null,
    created_at: "2026-07-20T15:12:00+00:00",
    status: "recorded",
    participants: participants.map((p) => ({
      member_id: p.member_id,
      is_exclusive: p.is_exclusive ?? false,
      exclusive_amount: p.exclusive_amount ?? 0,
      share_amount: p.share_amount,
    })),
    amount_expression: null,
  };
}

describe("yourShare (v0.3.20 #96 fix)", () => {
  it("returns 150 for Q (non-exclusive) on bill #95 (PO case)", () => {
    // bill #95: 336 total, Jesse exclusive 36, Jesse + Q share.
    // BE computes: shared_pool = 300, per_user_shared = 150.
    // Jesse share = 150 + 36 = 186. Q share = 150.
    const bill = mkBill(336, [
      { member_id: 15, is_exclusive: true, exclusive_amount: 36, share_amount: 186 },
      { member_id: 18, is_exclusive: false, exclusive_amount: 0, share_amount: 150 },
    ]);
    expect(yourShare(bill, 18)).toBe(150);
  });

  it("returns 186 for Jesse (exclusive) on bill #95", () => {
    const bill = mkBill(336, [
      { member_id: 15, is_exclusive: true, exclusive_amount: 36, share_amount: 186 },
      { member_id: 18, is_exclusive: false, exclusive_amount: 0, share_amount: 150 },
    ]);
    expect(yourShare(bill, 15)).toBe(186);
  });

  it("returns null when caller is not signed in", () => {
    const bill = mkBill(100, [
      { member_id: 1, share_amount: 50 },
      { member_id: 2, share_amount: 50 },
    ]);
    expect(yourShare(bill, null)).toBeNull();
    expect(yourShare(bill, undefined)).toBeNull();
  });

  it("returns null when current user is not a participant", () => {
    const bill = mkBill(100, [
      { member_id: 1, share_amount: 50 },
      { member_id: 2, share_amount: 50 },
    ]);
    expect(yourShare(bill, 99)).toBeNull();
  });

  it("returns null when bill has no participants", () => {
    const bill = mkBill(100, []);
    expect(yourShare(bill, 1)).toBeNull();
  });

  it("returns share for the only participant when alone", () => {
    const bill = mkBill(100, [{ member_id: 1, share_amount: 100 }]);
    expect(yourShare(bill, 1)).toBe(100);
  });

  it("matches naive split when no exclusive portions", () => {
    // 200 total, 4 participants, no exclusives -- naive 50/50/50/50.
    const bill = mkBill(200, [
      { member_id: 1, share_amount: 50 },
      { member_id: 2, share_amount: 50 },
      { member_id: 3, share_amount: 50 },
      { member_id: 4, share_amount: 50 },
    ]);
    expect(yourShare(bill, 1)).toBe(50);
    expect(yourShare(bill, 4)).toBe(50);
  });
});

describe("computePerCapitaBreakdown (v0.3.20 #96 fix)", () => {
  it("returns 150 CNY for bill #95 day (PO case, single bill)", () => {
    const bill = mkBill(336, [
      { member_id: 15, is_exclusive: true, exclusive_amount: 36, share_amount: 186 },
      { member_id: 18, is_exclusive: false, exclusive_amount: 0, share_amount: 150 },
    ]);
    expect(computePerCapitaBreakdown([bill])).toEqual([
      { ccy: "CNY", amount: 150 },
    ]);
  });

  it("matches naive split when no exclusive portions", () => {
    // 200 total / 4 ppts / no exclusive -> per_user_shared = 50 (same as naive).
    const bill = mkBill(200, [
      { member_id: 1, share_amount: 50 },
      { member_id: 2, share_amount: 50 },
      { member_id: 3, share_amount: 50 },
      { member_id: 4, share_amount: 50 },
    ]);
    expect(computePerCapitaBreakdown([bill])).toEqual([
      { ccy: "CNY", amount: 50 },
    ]);
  });

  it("sums multiple bills in same currency (mixed exclusive / non-exclusive)", () => {
    // Day with two bills:
    //   Bill A: 100 / 2 ppts / no exclusive -> 50
    //   Bill B: 200 / 2 ppts / Alice exclusive 40 -> (200-40)/2 = 80
    // Day total per_user_shared: 50 + 80 = 130 CNY
    const billA = mkBill(100, [
      { member_id: 1, share_amount: 50 },
      { member_id: 2, share_amount: 50 },
    ]);
    const billB = mkBill(200, [
      { member_id: 1, is_exclusive: true, exclusive_amount: 40, share_amount: 140 },
      { member_id: 2, is_exclusive: false, exclusive_amount: 0, share_amount: 80 },
    ]);
    expect(computePerCapitaBreakdown([billA, billB])).toEqual([
      { ccy: "CNY", amount: 130 },
    ]);
  });

  it("groups by currency (multi-currency day)", () => {
    const billCNY = mkBill(100, [
      { member_id: 1, share_amount: 50 },
      { member_id: 2, share_amount: 50 },
    ], "CNY");
    const billTHB = mkBill(1000, [
      { member_id: 1, share_amount: 500 },
      { member_id: 2, share_amount: 500 },
    ], "THB");
    const out = computePerCapitaBreakdown([billCNY, billTHB]);
    expect(out).toEqual(
      expect.arrayContaining([
        { ccy: "CNY", amount: 50 },
        { ccy: "THB", amount: 500 },
      ])
    );
    expect(out).toHaveLength(2);
  });

  it("returns empty array when no bills", () => {
    expect(computePerCapitaBreakdown([])).toEqual([]);
  });

  it("skips bills with no participants", () => {
    const empty = mkBill(100, []);
    const ok = mkBill(200, [
      { member_id: 1, share_amount: 100 },
      { member_id: 2, share_amount: 100 },
    ]);
    expect(computePerCapitaBreakdown([empty, ok])).toEqual([
      { ccy: "CNY", amount: 100 },
    ]);
  });

  it("handles everyone-exclusive case (per_user_shared = 0)", () => {
    // Bill = 100; 2 people each have exclusive 50.
    // exclusive_total = 100, shared_pool = 0, per_user_shared = 0.
    const bill = mkBill(100, [
      { member_id: 1, is_exclusive: true, exclusive_amount: 50, share_amount: 50 },
      { member_id: 2, is_exclusive: true, exclusive_amount: 50, share_amount: 50 },
    ]);
    expect(computePerCapitaBreakdown([bill])).toEqual([
      { ccy: "CNY", amount: 0 },
    ]);
  });
});
