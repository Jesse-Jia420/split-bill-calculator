<!--
  v0.3.36 — UAT 0727-1 #8 sub-route: /sessions/[id]/settle 是瘦壳 redirector.
  解析 numeric id → getSession → 拿 session_code → 跳 /s/{code}/settle (保留 #personal hash).
  渲染职责搬到 /s/[code]/settle/+page.svelte (canonical URL).

  排除: 非成员 anon 路径仍 fall back /sessions/{id}/join (legacy compat URL).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getSession } from '$api/sessions';
  import LoadingOverlay from '$components/LoadingOverlay.svelte';

  let id = $derived(Number(page.params.id));
  let loading = $state(true);
  let error: string | null = $state(null);

  onMount(async () => {
    if (!id || Number.isNaN(id)) {
      error = '无效的 session id';
      loading = false;
      return;
    }
    try {
      const session = await getSession(id);
      // Canonical URL = /s/{session_code}/settle. 保留 hash (e.g. #personal tab).
      await goto('/s/' + session.session_code + '/settle' + (page.url.hash || ''), { replaceState: true });
    } catch (e: any) {
      // BUG-V031-A: anon 非成员 → /join (legacy compat path).
      const sidFromDetail = e?.detail?.detail?.session_id ?? e?.detail?.session_id;
      if (e?.status === 403 && sidFromDetail) {
        await goto('/sessions/' + sidFromDetail + '/join', { replaceState: true });
        return;
      }
      error = e?.message ?? '加载失败';
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>打开账本结算 · 轻均 FairLite</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <LoadingOverlay text="正在打开账本结算..." />
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
  {/if}
</main>