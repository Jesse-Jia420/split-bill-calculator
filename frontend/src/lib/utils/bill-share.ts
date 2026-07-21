/**
 * Bill share computation utilities (extracted from BillListGrouped.svelte).
 *
 * v0.3.20 #96 (PO msg 02:41 #7467): the previous inline implementation
 * did ``b.amount / n`` for both the per-bill "分摊" row and the
 * per-day "人均" header. That ignored the ``is_exclusive`` /
 * ``exclusive_amount`` fields and produced a wrong per-person share
 * whenever a bill had any exclusive portion. PO example: bill #95
 * (早餐 336 CNY, 2 参与者, Jesse 独占 36 CNY):
 *
 *   - Wrong (old):   336 / 2 = 168  CNY  (treating everyone as equal)
 *   - Correct:       150 CNY for Q (non-exclusive)
 *                    186 CNY for Jesse (150 shared + 36 exclusive)
 *
 * The backend already computes the per-participant ``share_amount``
 * correctly (see backend/app/api/bills.py::_compute_share_amounts).
 * The fix here is to consume that BE-provided value for the per-bill
 * "分摊" display, and to subtract ``exclusive_total`` from the bill
 * amount for the per-day "人均" aggregate so the displayed number
 * matches the non-exclusive participant's share.
 */

import type { Bill } from "../api/bills";

/**
 * Per-participant share for the current user on a single bill.
 *
 * Returns the BE-computed ``p.share_amount`` for the participant whose
 * ``member_id`` matches ``currentMemberId`` (matches the standard
 * "subtract exclusive, split the rest equally" formula plus the
 * user own exclusive portion).
 *
 * Returns ``null`` when the caller is not signed in, when the bill has
 * no participants, or when the current user is not a participant on the
 * bill (in which case the "分摊 X" row should be hidden by the caller).
 */
export function yourShare(
  bill: Bill,
  currentMemberId: number | null | undefined
): number | null {
  if (currentMemberId === null || currentMemberId === undefined) return null;
  const parts = bill.participants ?? [];
  if (parts.length === 0) return null;
  const me = parts.find((p) => p.member_id === currentMemberId);
  if (!me) return null;
  // BE-provided per-participant share (already correct with exclusive).
  // See backend/app/api/bills.py::_compute_share_amounts.
  return Number(me.share_amount);
}

export interface PerCapitaBreakdownItem {
  ccy: string;
  amount: number;
}

/**
 * Per-day "人均" breakdown, grouped by currency.
 *
 * For each bill in ``bills``:
 *
 *   exclusive_total = sum(p.exclusive_amount for p where p.is_exclusive)
 *   per_user_shared = (bill.amount - exclusive_total) / num_participants
 *   contribute per_user_shared to the day-total for bill.currency
 *
 * This is the "non-exclusive participant share" per bill, summed
 * across bills in the day. With no exclusives it collapses to the
 * naive ``bill.amount / num_participants`` (the v0.3.1 behaviour);
 * with exclusives it correctly excludes the personal portion before
 * averaging out.
 *
 * Returns ``[]`` when ``bills`` is empty or every bill has no
 * participants.
 */
export function computePerCapitaBreakdown(
  bills: Bill[]
): PerCapitaBreakdownItem[] {
  const byCcy = new Map<string, number>();
  for (const b of bills) {
    const parts = b.participants ?? [];
    const n = parts.length;
    if (n <= 0) continue;
    let exclusiveTotal = 0;
    for (const p of parts) {
      if (p.is_exclusive && Number(p.exclusive_amount) > 0) {
        exclusiveTotal += Number(p.exclusive_amount);
      }
    }
    const perUserShared = (Number(b.amount) - exclusiveTotal) / n;
    byCcy.set(
      b.currency,
      (byCcy.get(b.currency) ?? 0) + perUserShared
    );
  }
  return [...byCcy.entries()].map(([ccy, amount]) => ({ ccy, amount }));
}
