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