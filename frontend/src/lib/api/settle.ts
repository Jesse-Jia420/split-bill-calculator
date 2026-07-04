import { apiFetch } from './client';

export interface Transfer {
  from_member_id: number;
  to_member_id: number;
  amount: number;
}

export interface BillSummary {
  bill_id: number;
  description: string | null;
  amount: number;
  currency: string;
  occurred_at: string;
}

export interface BillShare {
  bill_id: number;
  description: string | null;
  amount: number;
  share_amount: number;
  /**
   * v0.1.2 (PO 2026-07-01 fix #4): the portion of `share_amount` that
   * this member ate alone (is_exclusive=true on the participant row).
   * 0 when the member is not exclusive on this bill. Always present
   * (default 0) on the response so the FE doesn't need to handle
   * `undefined` separately.
   */
  exclusive_amount: number;
  currency: string;
  occurred_at: string;
}

export interface MemberSettlement {
  member_id: number;
  display_name: string;
  role: string;
  total_paid: number;
  total_consumed: number;
  net: number;
  paid_bills: BillSummary[];
  consumed_bills: BillShare[];
}

export interface SettleResponse {
  session_id: number;
  generated_at: string;
  balances: Record<string, number>; // member_id (string) -> net
  transfers: Transfer[];
  /** v0.1.2 (T18): per-member breakdown for the 'personal view' tab. */
  per_member: MemberSettlement[];
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
  return apiFetch<SettleResponse>(url);
};
