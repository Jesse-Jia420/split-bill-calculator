<!--
  v0.3.x (UAT #0723-3 #3) — /s/[code] 主入口 (redirect to /sessions/{id}).

  Background: 老 URL /sessions/{id} 的 id 是简单递增整数, 容易被用户试出
  别人的 session. 改用 10 字符 session_code (BE 会话生成时随机生成, 32 字符
  alphabet "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", ~10^15 entropy).

  PO spec (#8645) "只接新. 没有外部链接.":
  - 只接 new approach: 不 migrate 老 session URL
  - 没有外部链接: 不考虑外部 share link 兼容

  实现:
  - 路由 /s/[code] 作为公开入口, 解析 code → getSessionByCode → 跳
    /sessions/{id}. 子路由 (/settle /bills/new /bills/{billId}/edit /join)
    在 sibling 目录处理, 各自 redirect 透传 #personal 等 hash.
  - 老 URL /sessions/{id} 保持工作 (UI 不再生成, 但用户从书签进仍能访问,
    向后兼容).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getSessionByCode, type SessionDetail } from '$api/sessions';
  // v0.3.28 UAT 0724-1 #5 (Option C 玻璃圆环): /s/[code] unguessable URL 格式路由 (v0.3.28 #0723-3 #3 引入)
  // 跟 /sessions/{id} 是同一组件, 但用 unguessable 10-char session_code 替代 numeric id.
  // LoadingOverlay 跟 /sessions/{id}/+page.svelte 一致 (Option C 玻璃圆环).
  import LoadingOverlay from '$components/LoadingOverlay.svelte';

  /** v0.3.1 (Bug & Issues #5): unguessable code → session page.
   *  v0.3.x (UAT #0723-3 #3): 新 UI 链接生成用 /s/{session_code} 格式. */
  let code = $derived(page.params.code ?? '');
  let loading = $state(true);
  let error: string | null = $state(null);

  onMount(async () => {
    if (!code) {
      error = '无效的账本链接';
      loading = false;
      return;
    }
    try {
      const session: SessionDetail = await getSessionByCode(code);
      await goto('/sessions/' + session.id, { replaceState: true });
    } catch (e: any) {
      // BUG-V031-A: non-member visitor should be redirected to /join,
      // not see an error page. BE 403 detail includes session_id; the
      // apiFetch ApiError wraps the BE's `detail` field under
      // `e.detail.detail.session_id`.
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
