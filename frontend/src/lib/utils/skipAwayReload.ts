/**
 * Paths where global +layout must NOT hard-reload after long backgrounding.
 * Reload wipes in-memory UI (login OTP step, bill undo queue, scroll, etc.).
 */
export function shouldSkipAwayReload(pathname: string): boolean {
  if (pathname === '/auth/login' || pathname === '/auth/login/') return true;
  if (/^\/sessions\/\d+\/login\/?$/.test(pathname)) return true;
  // Bill list / ledger detail (/s/{code}) — keep undo toast, members fold, scroll.
  if (/^\/s\/[A-Z0-9]+\/?$/i.test(pathname)) return true;
  return false;
}
