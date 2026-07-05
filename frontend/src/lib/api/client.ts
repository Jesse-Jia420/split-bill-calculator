// Common fetch wrapper used by every domain API module.
// cookies are auto-attached via credentials: 'include'.
// All API paths are relative to /api -- the vite dev proxy strips that
// prefix and forwards to the FastAPI backend on 8449.

export class ApiError extends Error {
  status: number;
  code: string;
  detail: any;
  constructor(status: number, code: string, detail?: any) {
    super(String(status) + " " + code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 401 handling — auto-redirect to /auth/login with returnTo.
 *
 * Rules (per SPEC §4 + T16 implementation note):
 *   - If the API path starts with `/auth/` (i.e. /auth/me, /auth/send-code,
 *     /auth/verify-code, /auth/logout), we **never** auto-redirect. Those
 *     endpoints are part of the login flow itself and need to surface
 *     the 401 to the caller so login pages can render error states
 *     (especially /auth/me which loadUser uses to detect anon users
 *     — redirecting there would loop every page load).
 *   - Otherwise, in the browser, we **always** redirect on 401 — even
 *     for anonymous users — because every non-/auth/ endpoint is a
 *     protected page that requires login. An anonymous user landing on
 *     /sessions and getting 401 from `/api/sessions` should be sent to
 *     /auth/login (with their current page as returnTo) instead of
 *     staring at an error toast. This is also how the user gets
 *     "session expired" UX when a previously-valid cookie was cleared:
 *     the next protected API call 401s and we redirect.
 *   - On redirect we clear the user store and
 *     `window.location.assign` to `/auth/login?returnTo=<encoded current path>&expired=1`.
 *     The current Promise is replaced with a never-resolving one so the
 *     caller's `await apiFetch(...)` doesn't see an ApiError — UI doesn't
 *     flicker / show stale error toasts while the redirect is in flight.
 *   - In SSR (no `window`) we just throw normally — no one is around to
 *     receive a redirect.
 *
 * Why `$app/navigation.goto` instead of `window.location.assign`?
 *   - client.ts is a plain `.ts` module; `$app/navigation` aliases are
 *     statically only resolvable from `+page.svelte` / `+layout.svelte`
 *     files. A dynamic `await import('$app/navigation')` would work in
 *     the browser bundle but is brittle during SSR/hydration transitions.
 *     Hard nav via `window.location.assign` is the safest cross-context
 *     choice and the SvelteKit team explicitly documents this pattern
 *     for "outside the router" redirects.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`/api` + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options
  });

  // 401 special handling BEFORE generic !res.ok branch.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (typeof window !== 'undefined') {
      // Lazy import: stores live under `$stores` which only resolves
      // through Vite/SvelteKit at build time, and we want to avoid the
      // module-load cycle (`client.ts → stores → auth.ts → client.ts`)
      // firing at import time.
      const userMod = await import('$stores/user');
      userMod.clearUser();
      const here = window.location.pathname + window.location.search;
      window.location.assign(
        '/auth/login?returnTo=' + encodeURIComponent(here) + '&expired=1'
      );
      // Never resolve — the navigation is the outcome.
      return new Promise<T>(() => {});
    }
    // SSR: fall through to throw below.
  }

  if (!res.ok) {
    let detail: any = undefined;
    try {
      detail = await res.json();
    } catch {
      detail = { detail: { error: res.statusText } };
    }
    const code = detail?.detail?.error ?? (`http_${res.status}`);
    throw new ApiError(res.status, code, detail);
  }

  // 204 No Content -- return undefined casted to T.
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}