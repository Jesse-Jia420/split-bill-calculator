<!--
  v0.3.x (UAT #0723-3 #3) — /s/[code]/settle mirror redirect.

  Background: 老 URL /sessions/{id} 的 id 是简单递增整数, 容易被用户试出
  别人的 session. 改用 10 字符 session_code (BE 会话生成时随机生成, 32 字符
  alphabet "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", ~10^15 entropy).

  PO spec (#8645) "只接新. 没有外部链接.":
  - 只接 new approach: 不 migrate 老 session URL
  - 没有外部链接: 不考虑外部 share link 兼容

  实现:
  - 路由 /s/[code]/settle 作为公开 /s/{code} 的子路由, 解析 code →
    getSessionByCode → 跳 /sessions/{id}/settle (保留 #personal hash).
  - 老 URL /sessions/{id}/settle 保持工作 (UI 不再生成, 但用户从书签进仍
    能访问, 向后兼容).

  Note: 不能只 redirect, 因为详情页 settle 内部很多 anchor (e.g. #personal),
  都得透传.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getSessionByCode } from '$api/sessions';

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
      const session = await getSessionByCode(code);
      // 透传 hash (e.g. #personal for 个人视图 tab)
      await goto('/sessions/' + session.id + '/settle' + (page.url.hash || ''), { replaceState: true });
    } catch (e: any) {
      error = e?.message ?? '加载失败';
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>打开账本结算 · SplitIt</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <p>正在打开账本结算…</p>
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
  {/if}
</main>