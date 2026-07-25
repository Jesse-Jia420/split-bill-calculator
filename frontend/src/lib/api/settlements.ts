// v0.3.32 -- UAT 0725-2 #1: settlement_records API client
//
// PO 字面要求: 用户可增加已结算记录 + 系统调整 transfer cards + 展示所有已结算记录.
// BE 端点: POST / GET / DELETE /sessions/{id}/settlement_records
// (命名 settlement_records 而非 settlements, 跟 BE 同名, 避开 legacy snapshot table)

import { apiFetch } from './client';

export interface SettlementRecord {
  id: number;
  payer_id: number;
  payer_name: string;
  payee_id: number;
  payee_name: string;
  currency: string;
  /** Decimal returned as string (BE uses NUMERIC(12,2) + serialize Decimal -> str). */
  amount: string;
  note: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
}

export interface CreateSettlementInput {
  payer_id: number;
  payee_id: number;
  currency: string;
  amount: number;
  note?: string;
}

/** Create a new 已结算记录 entry. Returns the new record (with id). */
export const createSettlementRecord = (
  sessionId: number,
  payload: CreateSettlementInput
): Promise<SettlementRecord> => {
  return apiFetch<SettlementRecord>(
    `/sessions/${sessionId}/settlement_records`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
};

/** List every 已结算记录 for the session, newest first. */
export const listSettlementRecords = (
  sessionId: number
): Promise<SettlementRecord[]> => {
  return apiFetch<SettlementRecord[]>(
    `/sessions/${sessionId}/settlement_records`
  );
};

/** Delete a record (only the creator can delete; BE enforces 403 otherwise). */
export const deleteSettlementRecord = (
  sessionId: number,
  recordId: number
): Promise<void> => {
  return apiFetch<void>(
    `/sessions/${sessionId}/settlement_records/${recordId}`,
    { method: 'DELETE' }
  );
};