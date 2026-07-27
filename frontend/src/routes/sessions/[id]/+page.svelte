<!--
  v0.3.36 — UAT 0727-1 #8 (PO msg 16:04 字面 "{id} 目前是简单的数字, 不好"):
  详情页 URL 必须永远用 /s/{session_code} hash 格式, 不再用 /sessions/{numeric_id}.
  本文件变成瘦壳: 拿到 numeric id → getSession(id) → 知道 session_code → 跳到 /s/{session_code}.

  旧逻辑 (v0.3.28 之前) 让这个文件渲染完整页面, 现在渲染职责搬到 /s/[code]/+page.svelte (含
  完整 2234 行 SessionDetail body, 大部分逻辑两边共用过重 — 故 spec 拍板: hash 路由是
  canonical, /sessions/[id] 仅做向后兼容转发).

  History: UAT 0723-3 #3 (push b96252a + cb7dbb9 + ad0cc3d) 引入 /s/[code] mirror route
  作为 redirect-to-/sessions/[id]. #8 反向: /sessions/[id] → /s/[code]. canonical URL 永远是 hash.

  兜底: getSession 失败 (404 等) → 渲染 LoadingOverlay + error message, 不让用户卡白页.
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
      // Canonical URL = /s/{session_code}. 老 URL /sessions/{id} 仍支持 (legacy bookmark 兼容).
      await goto('/s/' + session.session_code, { replaceState: true });
    } catch (e: any) {
      // BUG-V031-A fix: anon 非成员 → 403, 跳 /join (保持老 /sessions/[id]/join 兼容路径).
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
  <title>打开账本 · SplitIt</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <LoadingOverlay text="正在打开账本..." />
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
  {/if}
</main>
