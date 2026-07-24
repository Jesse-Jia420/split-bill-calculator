<!--
  v0.3.x (UAT #0723-3 #3) — /s/[code]/bills/[billId]/edit mirror redirect.

  See /s/[code]/settle for full rationale. 解析 code + billId → getSessionByCode
  → 跳 /sessions/{id}/bills/{billId}/edit. 老 URL 仍工作.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getSessionByCode } from '$api/sessions';

  let code = $derived(page.params.code ?? '');
  let billId = $derived(page.params.billId ?? '');
  let loading = $state(true);
  let error: string | null = $state(null);

  onMount(async () => {
    if (!code || !billId) {
      error = '无效的账本链接';
      loading = false;
      return;
    }
    try {
      const session = await getSessionByCode(code);
      await goto('/sessions/' + session.id + '/bills/' + billId + '/edit', { replaceState: true });
    } catch (e: any) {
      error = e?.message ?? '加载失败';
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>编辑账单 · SplitIt</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <p>正在打开账本…</p>
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
  {/if}
</main>