
import { apiFetch } from './client';

export interface InviteCreateResponse {
  id: number;
  token: string;
  session_id: number;
  created_at: string;
  expires_at: string;
}

export interface InvitePublicView {
  session_id: number;
  session_name: string;
  inviter_display_name: string;
  status: 'active' | 'accepted' | 'expired' | 'deleted';
  expires_at: string;
}

export const createInvite = (sessionId: number) => {
  const url = '/sessions/' + sessionId + '/invites';
  return apiFetch<InviteCreateResponse>(url, { method: 'POST' });
};

export const revokeInvite = (sessionId: number, inviteId: number) => {
  const url = '/sessions/' + sessionId + '/invites/' + inviteId;
  return apiFetch<void>(url, { method: 'DELETE' });
};

export const getInvite = (token: string) => {
  const url = '/invites/' + token;
  return apiFetch<InvitePublicView>(url);
};

export interface AcceptInviteInput {
  display_name: string;
}

export interface AcceptInviteResponse {
  session_id: number;
  role: string;
  display_name: string;
  joined_at: string;
}

export const acceptInvite = (token: string, body: AcceptInviteInput) => {
  const url = '/invites/' + token + '/accept';
  return apiFetch<AcceptInviteResponse>(url, {
    method: 'POST',
    body: JSON.stringify(body)
  });
};
