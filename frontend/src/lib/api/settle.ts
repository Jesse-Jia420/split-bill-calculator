export interface Transfer {
  from_member_id: number;
  to_member_id: number;
  amount: number;
}

/**
 * v0.3.14.1 (hotfix #4): each per-bill row carries the amount in both
 * the bill's source currency (``amount`` / ``share_amount`` /
 * ``exclusive_amount``) and in the session's primary currency
 * (``*_primary`` siblings).  ``primary_currency`` echoes the session
 * primary so the FE can render the unit without a second GET.
 *
 * Personal view rendering rule (PO 拍板 2026-07-14 11:15 #4348):
 * - viewMode='primary' → render ``*_primary`` + ``primary_currency``
 * - viewMode='split'   → render raw values + ``currency``
 */
export interface BillSummary {
  bill_id: number;
  description: string | null;
  /** Raw bill amount in source currency (or primary when same). */
  amount: number;
  /** v0.3.14.1 (hotfix #4): amount in primary currency. */
  amount_primary: number;
  currency: string;
  primary_currency: string;
  occurred_at: string;
}

export interface BillShare {
  bill_id: number;
  description: string | null;
  /** Bill total, raw source currency (or primary when same). */
  amount: number;
  /** v0.3.14.1 (hotfix #4): bill total in primary currency. */
  amount_primary: number;
  /** Member's share, raw source currency (or primary when same). */
  share_amount: number;
  /**
   * v0.3.14.1 (hotfix #4): member's share in primary currency.
   * Identical to ``share_amount`` when ``currency == primary_currency``.
   */
  share_amount_primary: number;
  /**
   * v0.1.2 (PO 2026-07-01 fix #4): the portion of ``share_amount``
   * this member ate alone (``is_exclusive=true`` on the participant
   * row), in source currency. 0 when not exclusive; default 0 so the
   * FE never sees ``undefined``.
   */
  exclusive_amount: number;
  /**
   * v0.3.14.1 (hotfix #4): exclusive_amount in primary currency. 0
   * when not exclusive (matches ``exclusive_amount``).
   */
  exclusive_amount_primary: number;
  currency: string;
  primary_currency: string;
  occurred_at: string;
}

export interface MemberSettlement {
  member_id: number;
  display_name: string;
  role: string;
  /**
   * v0.3.14.1 (T11): primary-currency aggregate across every bill this
   * member paid. Always primary-currency regardless of view mode; in
   * ``split`` mode the FE re-aggregates per source currency from the
   * bill list for the per-currency hero meta.
   */
  total_paid: number;
  /** See ``total_paid``. */
  total_consumed: number;
  /** See ``total_paid``. */
  net: number;
  paid_bills: BillSummary[];
  consumed_bills: BillShare[];
}

export interface CurrencyBreakdown {
  paid: number;
  consumed: number;
  net: number;
}

export interface SettleResponse {
  session_id: number;
  generated_at: string;
  balances: Record<string, number>; // member_id (string) -> net
  transfers: Transfer[];
  /** v0.1.2 (T18): per-member breakdown for the 'personal view' tab. */
  per_member: MemberSettlement[];
  /** v0.3.14.1 (Bug B): only present when view='split'. */
  currency_breakdown?: Record<string, CurrencyBreakdown>;
  /** v0.2.2 (T08): the session's currency set, echoed here so the FE
   *  can render currency chips without a second GET /sessions/{id}. */
  currencies: string[];
  /** v0.2.2 (T11): the session's primary currency. All balances and
   *  transfers are denominated in this currency. */
  primary_currency: string;
  /** v0.2.2 (T11): 'primary' (default) or 'split'. */
  view: string;
}

/**
 * v0.2.2 (T11): fetch the settle view.
 * - `view='primary'` (default): balances + transfers + per-member
 *   breakdown all aggregated into the session's primary currency.
 * - `view='split'`: balances still in primary currency (settlement
 *   maths needs one reference) but the response also echoes per-bill
 *   source currencies on per-member breakdown rows.
 */
export const getSettle = (
  sessionId: number,
  view: 'primary' | 'split' = 'primary'
) => {
  const url = '/sessions/' + sessionId + '/settle?view=' + view;
  // v0.3.1: send X-Nickname-Secret for anonymous access.
  const headers: Record<string, string> = {};
  if (typeof window !== 'undefined') {
    const secret = localStorage.getItem('sbc.actingAs.' + sessionId);
    if (secret) headers['X-Nickname-Secret'] = secret;
  }
  return fetch('/api' + url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...headers },
  }).then(async (r) => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const err: any = new Error(body?.detail?.error ?? `HTTP ${r.status}`);
      err.status = r.status;
      err.code = body?.detail?.error ?? `http_${r.status}`;
      throw err;
    }
    return r.json() as Promise<SettleResponse>;
  });
};
