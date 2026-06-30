
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
}

export const listBills = (sessionId: number) => {
  const url = "/sessions/" + sessionId + "/bills";
  return apiFetch<Bill[]>(url);
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
