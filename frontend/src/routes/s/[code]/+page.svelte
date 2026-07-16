<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { getSessionByCode, type SessionDetail } from '$api/sessions';

  /** v0.3.1 (Bug & Issues #5): unguessable code → session page. */
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
  <title>打开账本 · Split Bill</title>
</svelte:head>

<main class="container" style="padding-top: 4rem; text-align: center;">
  {#if loading}
    <p>正在打开账本…</p>
  {:else if error}
    <h2>打不开</h2>
    <p class="muted">{error}</p>
  {/if}
</main>
