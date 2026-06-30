<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getSession } from '$api/sessions';
  import { createBill } from '$api/bills';
  import type { SessionDetail } from '$api/sessions';
  import BillForm from '$components/BillForm.svelte';

  let session: SessionDetail | null = null;
  let loading = true;
  let error: string | null = null;

  $: sessionId = Number($page.params.id);

  onMount(async () => {
    try {
      session = await getSession(sessionId);
    } catch (e: any) {
      error = e?.message ?? '加载失败';
    } finally {
      loading = false;
    }
  });

  async function handleSubmit(payload: any) {
    await createBill(sessionId, payload);
    await goto('/sessions/' + sessionId);
  }

  // Svelte 5: re-import onMount to make it available without explicit import above.
  import { onMount } from 'svelte';
</script>

<section>
  {#if loading}
    <p class="muted">加载中…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if session}
    <div class="row" style="margin-bottom: var(--space-3);">
      <a class="btn ghost" href="/sessions/{session.id}">← 返回</a>
    </div>
    <h2>新建账单</h2>
    <p class="muted">session: {session.name}</p>

    <div class="card">
      <BillForm {session} onSubmit={handleSubmit} />
    </div>
  {/if}
</section>