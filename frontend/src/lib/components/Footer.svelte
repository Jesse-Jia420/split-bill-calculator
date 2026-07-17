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
    /* v0.3.17 #30 (PO msg 14:28): 加 env(safe-area-inset-bottom) — iOS 全面屏
     * home indicator (小白条) 不挡底部版本号. body 已 lock 外层滚 (见 app.css),
     * .footer 是 body flex column 最后一项, 始终贴底. */
    padding: var(--space-4) var(--space-4) calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
    color: var(--color-text-muted);
    font-size: 0.75rem;
    font-family: monospace;
    border-top: 1px solid var(--color-border);
    flex-shrink: 0; /* 不被 main flex:1 压. */
  }
  .version { font-family: monospace; }
</style>