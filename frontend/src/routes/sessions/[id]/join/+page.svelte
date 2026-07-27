<!--
  v0.3.36 — UAT 0727-1 #8 sub-route: /sessions/[id]/join 是瘦壳 redirector.
  解析 numeric id → getSession → 拿 session_code → 跳 /s/{code}/join (保留 ?token=xxx query).
  渲染职责搬到 /s/[code]/join/+page.svelte (canonical URL).
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
      // Canonical URL = /s/{session_code}/join. 保留 ?token=xxx query (邀请 token).
      await goto('/s/' + session.session_code + '/join' + page.url.search, { replaceState: true });
    } catch (e: any) {
      // BUG-V031-A: anon 非成员 (预期路径) → /s/{code}/join 让其 claim nickname.
      // 注: 此 redirector 应只在 member 路径触发 (已有 secret / 已登录), anon 直接走 /s/[code]/join.
      // 老 fallback: anon 仍可走 /sessions/{id}/join 兼容 (BE 端 BE anon 返 403 也能跳).
      const sidFromDetail = e?.detail?.detail?.session_id ?? e?.detail?.session_id;
      const code = e?.detail?.detail?.session_code ?? e?.detail?.session_code;
      if (e?.status === 403 && code) {
        await goto('/s/' + code + '/join' + page.url.search, { replaceState: true });
        return;
      }
      if (e?.status === 403 && sidFromDetail) {
        // sidFromDetail fallback — 老 URL 兼容路径, 走 numeric id → /sessions/{sid}/join 形式
        // (保留 兼容 URL, 不强跳 hash format 因为不知道 code)
        // 不再 redirect (会死循环), 改成让用户重新走 hash URL
        error = '请使用分享链接加入账本';
        loading = false;
        return;
      }
      error = e?.message ?? '加载失败';
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>加入账本 · SplitIt</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <LoadingOverlay text="正在打开加入页..." />
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
  {/if}
</main>