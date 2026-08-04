/**
 * Persist login "verification code sent" step across tab backgrounding /
 * accidental reloads. The global +layout hard-reloads after long hide, which
 * otherwise wipes in-memory `step = 'verify'` and leaves users unable to enter
 * the OTP they just received by email.
 *
 * sessionStorage (not localStorage): scoped to the tab, cleared when the tab
 * closes; TTL matches / exceeds typical verification_code TTL (10 min).
 */

const KEY = 'sbc.login.draft';
/** Keep draft long enough for the user to leave, open mail, and return. */
const TTL_MS = 15 * 60 * 1000;

export type LoginDraft = {
  /** Which login route owns this draft. */
  path: string;
  email: string;
  step: 'verify';
  sentAt: number;
};

export function isAuthLoginPath(pathname: string): boolean {
  if (pathname === '/auth/login' || pathname === '/auth/login/') return true;
  return /^\/sessions\/\d+\/login\/?$/.test(pathname);
}

export function saveLoginDraft(draft: {
  path: string;
  email: string;
}): void {
  if (typeof sessionStorage === 'undefined') return;
  const email = draft.email.trim();
  if (!email) return;
  try {
    const payload: LoginDraft = {
      path: draft.path,
      email,
      step: 'verify',
      sentAt: Date.now(),
    };
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // quota / private mode — ignore
  }
}

export function loadLoginDraft(path: string): LoginDraft | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as LoginDraft;
    if (!d || d.path !== path || d.step !== 'verify') return null;
    if (typeof d.email !== 'string' || !d.email.includes('@')) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    if (typeof d.sentAt !== 'number' || Date.now() - d.sentAt > TTL_MS) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return d;
  } catch {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function clearLoginDraft(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
