import { apiFetch } from './client';

// ---------------------------------------------------------------------------
// v0.1.1 redesign (2026-06-30): per-session fixed invite token.
//
// Old API: POST /sessions/{id}/invites + DELETE /sessions/{id}/invites/{iid}
//          (one row per invite in session_invites table)
// New API: GET  /sessions/{id}/invite        (member reads current token)
//          POST /sessions/{id}/invite/rotate (owner rotates the token)
//          GET  /invites/{token}             (public preview -- unchanged)
//          POST /invites/{token}/accept      (public join -- unchanged)
// ---------------------------------------------------------------------------

export interface SessionInvite {
  /** The raw token to embed in the URL `/invites/{token}`. */
  token: string;
  /** Client-relative URL: `/invites/{token}`. The frontend prepends
   *  `window.location.origin` at render time. */
  url: string;
  /** ISO 8601 timestamp. */
  created_at: string;
  /** ISO 8601 timestamp; 30-day TTL from `created_at`. */
  expires_at: string;
  /** "active" while expires_at is in the future, "expired" otherwise. */
  status: 'active' | 'expired';
}

export interface InvitePublicView {
  session_id: number;
  session_name: string;
  inviter_display_name: string;
  status: 'active' | 'expired';
  expires_at: string;
}

/** GET /sessions/{id}/invite -- any session member can read. */
export const getSessionInvite = (sessionId: number) => {
  const url = '/sessions/' + sessionId + '/invite';
  const headers: Record<string, string> = {};
  if (typeof window !== 'undefined') {
    const secret = localStorage.getItem('sbc.actingAs.' + sessionId);
    if (secret) headers['X-Nickname-Secret'] = secret;
  }
  return apiFetch<SessionInvite>(url, { headers });
};

/** POST /sessions/{id}/invite/rotate -- owner only. */
export const rotateSessionInvite = (sessionId: number) => {
  const url = '/sessions/' + sessionId + '/invite/rotate';
  const headers: Record<string, string> = {};
  if (typeof window !== 'undefined') {
    const secret = localStorage.getItem('sbc.actingAs.' + sessionId);
    if (secret) headers['X-Nickname-Secret'] = secret;
  }
  return apiFetch<SessionInvite>(url, { method: 'POST', headers });
};

/** GET /invites/{token} -- public preview (no auth). */
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

/** POST /invites/{token}/accept -- public (requires auth cookie). */
export const acceptInvite = (token: string, body: AcceptInviteInput) => {
  const url = '/invites/' + token + '/accept';
  return apiFetch<AcceptInviteResponse>(url, {
    method: 'POST',
    body: JSON.stringify(body)
  });
};
