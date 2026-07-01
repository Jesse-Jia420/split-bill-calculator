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
}

export const getSettle = (sessionId: number) => {
  const url = '/sessions/' + sessionId + '/settle';
  return apiFetch<SettleResponse>(url);
};
