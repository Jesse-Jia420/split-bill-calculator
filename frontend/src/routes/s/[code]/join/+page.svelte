<!--
  v0.3.x (UAT #0723-3 #3) — /s/[code]/join mirror redirect.

  See /s/[code]/settle for full rationale. 解析 code → getSessionByCode
  → 跳 /sessions/{id}/join. 老 URL 仍工作.

  注意: /join 页面有 4-case dispatch (anon 有 secret / logged-in / 等),
  跟 session id 强耦合 (localStorage 存 sbc.actingAs.{sid}). 所以不能
  在 /s/[code] 自己处理 — 必须先 resolve code → id 再让 /join 接管.

  BUG-V031-A: anon 非成员 getSessionByCode 返 403, BE 403 detail 包含
  session_id. 必须 redirect 到 /join (跟 /s/[code]/+page.svelte 主入口同源).
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
      await goto('/sessions/' + session.id + '/join', { replaceState: true });
    } catch (e: any) {
      // BUG-V031-A: anon 非成员 → 跳 /join (跟 /s/[code]/+page.svelte 主入口同源).
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
  <title>加入账本 · SplitIt</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <p>正在打开账本…</p>
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
  {/if}
</main>