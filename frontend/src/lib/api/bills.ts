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

export const listBills = (sessionId: number) => {
  const url = "/sessions/" + sessionId + "/bills";
  // v0.3.1: send X-Nickname-Secret for anonymous access.
  const headers: Record<string, string> = {};
  if (typeof window !== "undefined") {
    const secret = localStorage.getItem("sbc.actingAs." + sessionId);
    if (secret) headers["X-Nickname-Secret"] = secret;
  }
  return fetch("/api" + url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...headers },
  }).then(async (r) => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const err: any = new Error(body?.detail?.error ?? `HTTP ${r.status}`);
      err.status = r.status;
      err.code = body?.detail?.error ?? `http_${r.status}`;
      throw err;
    }
    return r.json() as Promise<Bill[]>;
  });
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
  return apiFetch<Bill>(url, {
    method: "POST",
    body: JSON.stringify(body)
  });
};

export const updateBill = (
  sessionId: number,
  billId: number,
  body: Partial<CreateBillInput>
) => {
  const url = "/sessions/" + sessionId + "/bills/" + billId;
  return apiFetch<Bill>(url, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
};

export const deleteBill = (sessionId: number, billId: number) => {
  const url = "/sessions/" + sessionId + "/bills/" + billId;
  return apiFetch<void>(url, { method: "DELETE" });
};

export interface ParseBillResult {
  amount: number;
  payer_hint: string;
  participants_hint: string[];
  description: string;
}

export const parseBill = (sessionId: number, text: string) => {
  const url = "/sessions/" + sessionId + "/bills/parse";
  return apiFetch<ParseBillResult>(url, {
    method: "POST",
    body: JSON.stringify({ text })
  });
};
