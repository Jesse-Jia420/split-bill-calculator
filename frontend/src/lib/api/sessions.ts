import { apiFetch } from './client';

export interface SessionMember {
  /** SessionMember.id -- the row PK used for bill payload member references. */
  id: number;
  user_id: number;
  email: string;
  display_name: string;
  role: string;
  joined_at: string;
}

export interface SessionSummary {
  id: number;
  name: string;
  owner_user_id: number;
  role: string;
  member_count: number | null;
  created_at: string;
  /** v0.2.2 (T08): list-sessions echoes currency metadata so the FE
   *  can render the right chip without a follow-up detail round-trip. */
  currencies: string[];
  primary_currency: string;
}

/** v0.2.2 (T08/T09): one row of the session_exchange_rates table. */
export interface SessionExchangeRate {
  id: number;
  session_id: number;
  from_currency: string;
  to_currency: string;
  /** Decimal-as-string (BE serialises Decimal this way so precision is
   *  preserved on the wire). parseFloat() at the consumer. */
  rate: string;
  snapshot_at: string;
  set_by: number | null;
}

export interface SessionDetail extends Omit<SessionSummary, 'role' | 'member_count'> {
  members: SessionMember[];
  /** v0.1.1: first ~12 chars of `sessions.invite_token`, returned only to
   * the session owner (NULL for non-owners). Used by the frontend to
   * show an inline copy-paste affordance next to the member list. */
  invite_token_preview?: string | null;
  /** v0.1.1: ISO 8601 invite expiration, also owner-only. */
  invite_expires_at?: string | null;
  /** v0.2.1 T02 (PRD §3.6.2): SessionMember.ids of the most recent
   *  bill's participants. Null when the session has no bills yet. */
  last_bill_participants?: number[] | null;
  /** v0.2.2 (T09): per-session exchange rates (forward + reciprocal
   *  pairs). Empty array for single-currency sessions. */
  exchange_rates: SessionExchangeRate[];
}

/** v0.2.2 (T08): input shape for creating a multi-currency session. */
export interface CreateSessionInput {
  name: string;
  currencies?: string[];
  primary_currency?: string;
  exchange_rates?: Array<{
    from_currency: string;
    to_currency: string;
    rate: string;
  }>;
}

export const createSession = (input: CreateSessionInput | string) => {
  // Legacy callers pass just a string name; v0.2.2 callers pass a
  // full object that may include currencies / primary_currency /
  // exchange_rates.
  const body = typeof input === 'string' ? { name: input } : input;
  return apiFetch<SessionSummary>('/sessions', {
    method: 'POST',
    body: JSON.stringify(body)
  });
};

export const listSessions = () =>
  apiFetch<SessionSummary[]>('/sessions');

export const getSession = (id: number) => {
  const url = '/sessions/' + id;
  return apiFetch<SessionDetail>(url);
};

export const updateMemberDisplayName = (
  sessionId: number,
  memberId: number,
  display_name: string
) => {
  const url = '/sessions/' + sessionId + '/members/' + memberId;
  return apiFetch<{ user_id: number; display_name: string }>(url, {
    method: 'PATCH',
    body: JSON.stringify({ display_name })
  });
};