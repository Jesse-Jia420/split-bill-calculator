<script lang="ts">
  import { onMount } from 'svelte';

  type HealthResponse = { status: string } | null;

  let data: HealthResponse = null;
  let error: string | null = null;
  let loading = true;

  const backendBase = 'http://localhost:8449';

  onMount(async () => {
    try {
      const res = await fetch(`${backendBase}/health`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
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
    <p>正在探测 <code>{backendBase}/health</code> …</p>
  {:else if error}
    <p style="color: #c00;">❌ 后端不可达：{error}</p>
    <p>先在 <code>backend/</code> 目录启动 FastAPI：<code>uvicorn app.main:app --reload --port 8000</code></p>
  {:else if data}
    <p>✅ 后端返回 <code>{JSON.stringify(data)}</code></p>
  {/if}
</section>
