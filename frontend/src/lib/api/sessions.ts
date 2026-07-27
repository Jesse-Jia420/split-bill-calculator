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

/** v0.3.x (UAT 0723 #6): 一名成员的 avatar 信息. BE 在 POST /sessions
 *  和 GET /sessions 返回的 SessionSummary.avatars 用这个 shape.
 *  SessionCard 渲染 .avatar-mini 圆点时把 `initial` 当 textContent
 *  显示 (e.g. "J" for "Jesse", "像" for "像汤圆一样圆").
 */
export interface AvatarItem {
  name: string;  // 原始 display_name (FE aria-label / tooltip / fallback)
  initial: string;  // 1 char 显示文字 (Latin 大写 + CJK 原字符)
}

export interface SessionSummary {
  id: number;
  /** v0.3.x (UAT 0723-3 #3): unguessable 10-char public code. Frontend
   *  uses `/s/{session_code}` for new UI links (代替 /sessions/{id}).
   *  老 URL /sessions/{id} 仍工作 (向后兼容 — UI 不再生成但兼容).
   *  老 client (没 session_code 字段) 走 fallback 拼 id. */
  session_code?: string;
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
  /** v0.3.x (UAT 0723 #6): 最多 6 个成员的 name/initial (跟 SessionCard
   *  MAX_AVATARS=6 对齐). 老 client (没有 avatars 字段) 走 fallback
   *  N 个 palette 渐变实心圆点占位.
   */
  avatars?: AvatarItem[];
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
  /** v0.3.x (PRD §3.11): mirrors owner_user_id; NULL until the anonymous
   *  creator claims the session via the email link / login flow. Used by
   *  the FE to render "🔐 登录以保存" CTA conditionally. v0.3.18 #60
   *  batch2: also surfaces anon invite expiry hint under the invite button. */
  owner_email?: string | null;
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
  // v0.3.36 (UAT 0727-1 #8): /sessions/[id] 瘦壳要给 anon 成员也能 resolve, 必须
  // 发 X-Nickname-Secret header (否则 401 → apiFetch 重定向到 /auth/login,
  // URL hash 化反而进不去). sync mirror getSessionByCode 的 anonHeaders 模式.
  const headers: Record<string, string> = {};
  if (typeof window !== "undefined") {
    const secret = localStorage.getItem("sbc.actingAs." + id);
    if (secret) headers["X-Nickname-Secret"] = secret;
  }
  return apiFetch<SessionDetail>(url, { headers });
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

/** v0.3.x (PRD §3.11) — Owner email claim.
 *
 * Sole entry point called from the session detail page onMount when
 * the URL carries `?claim=1`. BE atomically sets owner_user_id +
 * owner_email on the sessions row and returns the full SessionDetail
 * so the FE can drop the response into its existing session state and
 * re-render without the "🔐 登录以保存" CTA.
 *
 * Errors (caught by apiFetch + ApiError):
 *   - 401: no auth cookie -- should be unreachable here because the
 *     CTA flow only fires after /auth/login → /auth/verify-code sets
 *     sbc_session. If it happens, client.ts auto-redirects to login.
 *   - 404: session does not exist.
 *   - 409: session already claimed (owner_user_id set) -- the user
 *     raced with another claimant. UI should toast and reload.
 */
export const claimSession = (
  sessionId: number
): Promise<SessionDetail> => {
  const url = '/sessions/' + sessionId + '/claim';
  return apiFetch<SessionDetail>(url, {
    method: 'POST'
  });
};

// §3.11.13 — public session preview for anon / login-context derivation.
// BE returns nickname_secret only for anon-claimed slots (logged-in slot
// secrets are never exposed). Used by /auth/login page to derive a
// personalised H2 (e.g. "嗨 alice，请登录") based on the returnTo path +
// the caller's localStorage actingAs secret.
export interface SessionMemberPreview {
  id: number;
  display_name: string;
  role: string;
  user_id: number | null;
  claimed_at: string | null;
  /** Only present for anon-claimed slots (user_id === null). */
  nickname_secret: string | null;
  /**
   * v0.3.x (UAT #0723-3 #2 续): the bound user's email, surfaced by
   * GET /sessions/{id}/preview so the /join page can render
   * "已被 {masked_email} 绑定" for anon visitors. Null for unbound
   * (anon-created placeholder) slots. Optional so older FE builds that
   * don't yet read it stay compile-clean.
   */
  email?: string | null;
}

export interface SessionPreview {
  id: number;
  /** v0.3.x (UAT 0723-3 #3): unguessable 10-char public code (anon preview
   *  也回 — 让 anon /join 跳到 detail 时用 /s/{session_code}). */
  session_code?: string;
  name: string;
  currencies: string[];
  primary_currency: string;
  members: SessionMemberPreview[];
}

export async function getSessionPreview(sessionId: number): Promise<SessionPreview> {
  return apiFetch<SessionPreview>(`/sessions/${sessionId}/preview`, { method: 'GET' });
}
/**
 * §3.11.14: anon-claimed slot → user-bound on login.
 *
 * Called from `+page.svelte::tryBindActingMember` after verify_code 200
 * succeeds. Pass the localStorage `sbc.actingAs.{sid}` secret; BE finds
 * the matching SessionMember (session_id, nickname_secret, is_anon=true,
 * user_id IS NULL) and binds it to the current user.
 *
 * Returns the bound member info. 404 is swallowed by the caller (slot
 * rotated / already bound / session expired) — the user still falls back
 * to anon-acting inside the session via the stored localStorage secret.
 */
export async function bindActingMember(
  sessionId: number,
  payload: { nickname_secret: string }
): Promise<{ session_member_id: number; display_name: string; user_id: number }> {
  return apiFetch(`/sessions/${sessionId}/bind-acting-member`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * v0.3.18 #53 (PO msg 10:49 #6542): owner-driven "add secondary currency"
 * flow. Called from CurrencyAddModal when the user picks the new currency;
 * the modal follows up with `createExchangeRate` to wire up the rate row.
 *
 * The primary currency is locked (per v0.2.2 PRD \u00a73.7.5) and cannot be
 * changed via this endpoint - only a SECONDARY currency may be appended.
 * If the session already has 2 currencies, the BE returns 422.
 *
 * Returns the updated SessionDetail payload (same shape as `getSession`)
 * so the FE can drop the response into its existing session state and
 * re-render the SessionCurrencyBadge from single-pill to dual-bar.
 */
export async function addSessionCurrency(
  sessionId: number,
  payload: { currency: string }
): Promise<SessionDetail> {
  return apiFetch<SessionDetail>(`/sessions/${sessionId}/currencies`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * v0.3.21 #108 (PO msg 17:54): owner-driven "remove secondary currency"
 * flow. Mirror of addSessionCurrency — called from CurrencyAddModal when:
 *  - user picks 「—」 in multi+!has_bills mode → 切回单币种 (modal label "切换单币种")
 *  - user picks a different currency as new secondary in multi+!has_bills
 *    → REPLACE flow (DELETE old + POST new + POST rate, atomic intent)
 *
 * The primary currency cannot be removed via this endpoint (BE 409).
 * The cascade deletes every SessionExchangeRate row whose from_currency
 * OR to_currency matches the removed currency.
 *
 * Returns the updated SessionDetail payload (same shape as addSessionCurrency)
 * so the FE can drop the response into its existing session state and
 * re-render SessionCurrencyBadge from dual-bar back to single-pill (or to
 * the new secondary after REPLACE).
 */
export async function deleteSessionCurrency(
  sessionId: number,
  currency: string
): Promise<SessionDetail> {
  return apiFetch<SessionDetail>(
    `/sessions/${sessionId}/currencies/${encodeURIComponent(currency)}`,
    { method: 'DELETE' }
  );
}
