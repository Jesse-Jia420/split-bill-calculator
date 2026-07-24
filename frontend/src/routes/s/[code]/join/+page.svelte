<!--
  v0.3.x (UAT #0723-3 #3) — /s/[code]/join mirror redirect.

  See /s/[code]/settle for full rationale. 解析 code → getSessionByCode
  → 跳 /sessions/{id}/join. 老 URL 仍工作.

  注意: /join 页面有 4-case dispatch (anon 有 secret / logged-in / 等),
  跟 session id 强耦合 (localStorage 存 sbc.actingAs.{sid}). 所以不能
  在 /s/[code] 自己处理 — 必须先 resolve code → id 再让 /join 接管.
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