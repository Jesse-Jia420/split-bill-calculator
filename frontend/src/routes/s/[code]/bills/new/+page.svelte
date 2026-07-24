<!--
  v0.3.x (UAT #0723-3 #3) — /s/[code]/bills/new mirror redirect.

  See /s/[code]/settle for full rationale. 解析 code → getSessionByCode
  → 跳 /sessions/{id}/bills/new. 老 URL /sessions/{id}/bills/new 仍工作.
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
      await goto('/sessions/' + session.id + '/bills/new', { replaceState: true });
    } catch (e: any) {
      // BUG-V031-A: anon 非成员 → 跳 /join (跟 /s/[code]/+page.svelte 主入口同源)
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
  <title>新建账单 · SplitIt</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <p>正在打开账本…</p>
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
  {/if}
</main>