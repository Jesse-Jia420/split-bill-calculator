import { apiFetch } from './client';

export interface SessionMember {
  /** SessionMember.id -- the row PK used for bill payload member references. */
  id: number;
  /** v0.3 (PRD §3.10): nullable for anonymous members. */
  user_id: number | null;
  /** v0.3: email is null for anonymous members (no user account). */
  email: string | null;
  display_name: string;
  role: string;
  joined_at: string;
}

export interface SessionSummary {
  id: number;
  name: string;
  /** v0.3 (PRD §3.10): nullable for anonymous session creation. */
  owner_user_id: number | null;
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

/** v0.3 (PRD §3.10): session detail with acting-as member ID.
 *
 * Checks localStorage for an anonymous acting-as secret for this session.
 * If found, sends X-Nickname-Secret header and returns the member ID
 * extracted from the X-SBC-Member-ID response header.
 *
 * Returns { session, actingAsMemberId } where actingAsMemberId is null
 * if no secret is stored or the secret is invalid (member not found).
 */
export const getSessionByCode = async (code: string): Promise<SessionDetail> => {
  const extraHeaders: Record<string, string> = {};
  if (typeof window !== "undefined") {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("sbc.actingAs.")) {
        const v = localStorage.getItem(k);
        if (v) extraHeaders["X-Nickname-Secret"] = v;
      }
    }
  }
  // BUG-V031-A fix: use apiFetch (not raw fetch) so 403 detail.session_id
  // is preserved on the thrown ApiError. /s/[code]/+page.svelte needs
  // e.detail.session_id to redirect non-members to /join.
  return apiFetch<SessionDetail>(
    "/sessions/by-code/" + encodeURIComponent(code),
    { headers: extraHeaders }
  );
};


export async function getSessionWithSecret(
  id: number
): Promise<{ session: SessionDetail; actingAsMemberId: number | null }> {
  const LS_PREFIX = 'sbc.actingAs.';
  const secretKey = LS_PREFIX + id;
  const secret: string | null = typeof window !== 'undefined'
    ? (localStorage.getItem(secretKey) ?? null)
    : null;

  const headers: Record<string, string> = {};
  if (secret) headers['X-Nickname-Secret'] = secret;

  // We use fetch directly to access response headers (X-SBC-Member-ID).
  // apiFetch doesn't expose response headers to callers.
  const res = await fetch(`/api/sessions/${id}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...headers },
  });

  if (res.status === 401 || res.status === 403) {
    // Secret invalid or expired — clear localStorage and return null memberId.
    if (secret && typeof window !== 'undefined') {
      localStorage.removeItem(secretKey);
    }
    const body = await res.json().catch(() => ({}));
    const err: any = new Error(body?.detail?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body?.detail?.error ?? `http_${res.status}`;
    throw err;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: any = new Error(body?.detail?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body?.detail?.error ?? `http_${res.status}`;
    throw err;
  }

  const session: SessionDetail = await res.json();
  const actingAsMemberId = res.headers.get('X-SBC-Member-ID');

  return {
    session,
    actingAsMemberId: actingAsMemberId ? Number(actingAsMemberId) : null,
  };
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

/** v0.3 (PRD §3.10): Join/claim a nickname in a session.
 *
 * Returns the session_member_id + nickname_secret (for anonymous callers,
 * store the secret in localStorage). */
export interface JoinClaimInput {
  action: 'claim' | 'add';
  session_member_id?: number | null;
  display_name?: string | null;
}

export interface JoinClaimResponse {
  session_member_id: number;
  display_name: string;
  nickname_secret: string | null;
  role: string;
  joined_at: string;
  is_anon: boolean;
}

export const joinClaim = (
  sessionId: number,
  input: JoinClaimInput
): Promise<JoinClaimResponse> => {
  const url = '/sessions/' + sessionId + '/join-claim';
  return apiFetch<JoinClaimResponse>(url, {
    method: 'POST',
    body: JSON.stringify(input)
  });
};
