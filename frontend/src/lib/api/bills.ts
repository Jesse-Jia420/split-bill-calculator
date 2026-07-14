import { apiFetch } from './client';

export interface BillParticipant {
  member_id: number;
  is_exclusive: boolean;
  exclusive_amount: number;
  share_amount: number;
}

export interface Bill {
  id: number;
  session_id: number;
  payer_id: number;
  amount: number;
  currency: string;
  description: string | null;
  occurred_at: string;
  created_by: number;
  created_at: string;
  status: string;
  participants: BillParticipant[];
  /** v0.2.1 T01 (PRD §3.6.1): raw calculator expression echoed from BE.
   *  Null for bills recorded before v0.2.1 or with use_calculator=false. */
  amount_expression: string | null;
}

export interface BillParticipantInput {
  member_id: number;
  is_exclusive: boolean;
  exclusive_amount: number;
}

export interface CreateBillInput {
  amount: number;
  payer_member_id: number;
  description?: string | null;
  occurred_at: string;
  currency?: string;
  participants: BillParticipantInput[];
  /** v0.2.1 T01: raw calculator expression. Send empty string when the
   *  user didn't use the calculator. */
  amount_expression?: string;
  /** v0.2.1 T01: when true, BE re-evaluates amount_expression and uses
   *  the result for `amount`. Default false (legacy callers). */
  use_calculator?: boolean;
}

/**
 * Build headers that include the anonymous session-member secret, if one
 * is stored in localStorage for this session. Anon users (the wizard flow
 * and `?nickname=` join flow) only have their identity proved via this
 * header — the BE's `require_session_member` dependency reads it.
 *
 * Centralized here so every session-scoped bill endpoint stays in sync.
 * Prior to v0.3.x this was open-coded in each function and `createBill`
 * was missing it, causing 403 "not a session member" on real iPhone UAT.
 */
function anonHeaders(sessionId: number): Record<string, string> {
  const h: Record<string, string> = {};
  if (typeof window !== "undefined") {
    const secret = localStorage.getItem("sbc.actingAs." + sessionId);
    if (secret) h["X-Nickname-Secret"] = secret;
  }
  return h;
}

export const listBills = (sessionId: number) => {
  const url = "/sessions/" + sessionId + "/bills";
  // Routed through apiFetch so 401/403 redirect logic kicks in
  // consistently (raw fetch bypassed it before).
  return apiFetch<Bill[]>(url, { headers: anonHeaders(sessionId) });
};

/**
 * v0.1.2 (PO 2026-07-01 fix #3): fetch a single bill for the edit page.
 *
 * The backend doesn't have a dedicated GET /bills/{bill_id} endpoint
 * (the v0.1 list endpoint already returns the full BillOut shape
 * including participants with computed share_amount). We reuse the
 * list and pick the one with the matching id, keeping the surface
 * small and avoiding a new BE route for what's effectively a
 * client-side lookup.
 */
export const getBill = async (sessionId: number, billId: number): Promise<Bill> => {
  const all = await listBills(sessionId);
  const found = all.find((b) => b.id === billId);
  if (!found) {
    const err: any = new Error("账单不存在");
    err.code = "not_found";
    err.status = 404;
    throw err;
  }
  return found;
};

export const createBill = (sessionId: number, body: CreateBillInput) => {
  const url = "/sessions/" + sessionId + "/bills";
  // v0.3.2 (PRD §3.12): 3rd arg `apiFetch.extraHeaders` carries
  // X-Nickname-Secret so anon dd can POST without a cookie (BE uses
  // get_session_member_or_secret).
  return apiFetch<Bill>(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: anonHeaders(sessionId),
  });
};

export const updateBill = (
  sessionId: number,
  billId: number,
  body: Partial<CreateBillInput>
) => {
  const url = "/sessions/" + sessionId + "/bills/" + billId;
  // v0.3.2: PATCH now anonymous-capable (BE upgraded to or_secret).
  return apiFetch<Bill>(url, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: anonHeaders(sessionId),
  });
};

export const deleteBill = (sessionId: number, billId: number) => {
  const url = "/sessions/" + sessionId + "/bills/" + billId;
  return apiFetch<void>(url, {
    method: "DELETE",
    headers: anonHeaders(sessionId),
  });
};

export interface ParseBillResult {
  amount: number;
  payer_hint: string;
  participants_hint: string[];
  description: string;
}

export const parseBill = (sessionId: number, text: string) => {
  const url = "/sessions/" + sessionId + "/bills/parse";
  // v0.3.2: AI parse now anonymous-capable (BE upgraded to or_secret).
  return apiFetch<ParseBillResult>(url, {
    method: "POST",
    body: JSON.stringify({ text }),
    headers: anonHeaders(sessionId),
  });
};
