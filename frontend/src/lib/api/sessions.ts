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
}

export interface SessionDetail extends Omit<SessionSummary, 'role' | 'member_count'> {
  members: SessionMember[];
  /** v0.1.1: first ~12 chars of `sessions.invite_token`, returned only to
   * the session owner (NULL for non-owners). Used by the frontend to
   * show an inline copy-paste affordance next to the member list. */
  invite_token_preview?: string | null;
  /** v0.1.1: ISO 8601 invite expiration, also owner-only. */
  invite_expires_at?: string | null;
}

export const createSession = (name: string) =>
  apiFetch<SessionSummary>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ name })
  });

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