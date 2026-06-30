<script lang="ts">
  import { onMount } from 'svelte';

  type HealthResponse = { status: string } | null;

  let data: HealthResponse = null;
  let error: string | null = null;
  let loading = true;

  // Use vite proxy (relative path) — same-origin, no CORS. Vite dev server
  // rewrites /api/* to http://127.0.0.1:8449/*.
  const probePath = '/api/health';

  onMount(async () => {
    try {
      const res = await fetch(probePath, { credentials: 'include' });
      if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      }
      data = (await res.json()) as HealthResponse;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });
</script>

<section>
  <h2>后端状态</h2>
  {#if loading}
    <p>正在探测 <code>{probePath}</code>（走 vite proxy）…</p>
  {:else if error}
    <p style="color: #c00;">❌ 后端不可达：{error}</p>
    <p>确认 backend 进程在 8449 端口：<code>ps aux | grep uvicorn</code></p>
  {:else if data}
    <p>✅ 后端返回 <code>{JSON.stringify(data)}</code></p>
  {/if}
</section>

<style>
  code {
    background: var(--color-bg);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: var(--font-size-sm);
    font-family: monospace;
  }
</style>
