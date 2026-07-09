<script lang="ts">
  import { onMount } from 'svelte';
  import { FRONTEND_VERSION } from '$lib/version';
  import { getBackendVersion } from '$api/version';

  let beVersion: string | null = null;

  onMount(async () => {
    try {
      const r = await getBackendVersion();
      beVersion = r.backend ?? null;
    } catch {
      beVersion = null;
    }
  });
</script>

<footer class="footer">
  <span class="version">FE: {FRONTEND_VERSION} · BE: {beVersion ?? '—'}</span>
</footer>

<style>
  .footer {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: var(--space-4);
    color: var(--color-text-muted);
    font-size: 0.75rem;
    font-family: monospace;
    border-top: 1px solid var(--color-border);
    margin-top: var(--space-6);
  }
  .version { font-family: monospace; }
</style>