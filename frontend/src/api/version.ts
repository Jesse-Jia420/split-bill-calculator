/**
 * Backend version helper. Fetches `/api/version` (proxied to BE `/version` by
 * vite dev proxy) and returns the short commit hash reported by the backend.
 *
 * Cached: one fetch per browser session via a memoized Promise. The badge
 * immediately shows the cached value on subsequent renders; restarts force a
 * refetch by virtue of the new JS bundle being loaded.
 *
 * Failures degrade to 'unreachable' instead of throwing — the badge must
 * stay visible even when BE is down so we can still tell FE is alive.
 */
let cached: Promise<string> | null = null;

export function getBackendVersion(): Promise<string> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const r = await fetch('/api/version', {
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: { backend?: string } = await r.json();
      return (data.backend ?? 'unknown').trim();
    } catch {
      return 'unreachable';
    }
  })();
  return cached;
}

/**
 * Force a re-fetch (e.g. after a router reload that changes commit). Used by
 * the dev hot-reload watch; safe to call multiple times.
 */
export function invalidateBackendVersion(): void {
  cached = null;
}
