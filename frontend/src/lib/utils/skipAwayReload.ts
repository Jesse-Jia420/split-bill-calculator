/**
 * Paths where global +layout must NOT hard-reload after long backgrounding.
 * Reload wipes in-memory UI (login OTP step, etc.).
 */
export function shouldSkipAwayReload(pathname: string): boolean {
  if (pathname === '/auth/login' || pathname === '/auth/login/') return true;
  if (/^\/sessions\/\d+\/login\/?$/.test(pathname)) return true;
  return false;
}
