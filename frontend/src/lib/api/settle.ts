
import { apiFetch } from './client';

export interface Transfer {
  from_member_id: number;
  to_member_id: number;
  amount: number;
}

export interface SettleResponse {
  session_id: number;
  generated_at: string;
  balances: Record<string, number>; // member_id (string) -> net
  transfers: Transfer[];
}

export const getSettle = (sessionId: number) => {
  const url = '/sessions/' + sessionId + '/settle';
  return apiFetch<SettleResponse>(url);
};
