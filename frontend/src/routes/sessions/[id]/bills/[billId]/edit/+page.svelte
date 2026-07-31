<!--
  v0.3.36 — UAT 0727-1 #8 sub-route: /sessions/[id]/bills/[billId]/edit 是瘦壳 redirector.
  解析 numeric id → getSession → 拿 session_code → 跳 /s/{code}/bills/{billId}/edit.
  渲染职责搬到 /s/[code]/bills/[billId]/edit/+page.svelte (canonical URL).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getSession } from '$api/sessions';
  import LoadingOverlay from '$components/LoadingOverlay.svelte';

  let id = $derived(Number(page.params.id));
  let billId = $derived(Number(page.params.billId));
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
      // Canonical URL = /s/{session_code}/bills/{billId}/edit. 保留 billId.
      await goto('/s/' + session.session_code + '/bills/' + billId + '/edit', { replaceState: true });
    } catch (e: any) {
      error = e?.message ?? '加载失败';
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>编辑账单 · 轻均 FairLite</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <LoadingOverlay text="正在打开编辑账单..." />
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
  {/if}
</main>