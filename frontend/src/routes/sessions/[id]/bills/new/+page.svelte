<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getSession } from '$api/sessions';
  import { createBill } from '$api/bills';
  import type { SessionDetail } from '$api/sessions';
  import { loadUser } from '$stores/user';
  import BillForm from '$components/BillForm.svelte';

  let session: SessionDetail | null = null;
  let loading = true;
  let error: string | null = null;

  // v0.1.2 (T19): pass this into BillForm so the payer dropdown
  // defaults to the caller's own SessionMember.id in this session.
  let defaultPayerMemberId: number | null = null;

  $: sessionId = Number($page.params.id);

  onMount(async () => {
    try {
      session = await getSession(sessionId);
      // Find the SessionMember that maps to the current user. If the
      // caller isn't yet a member (shouldn't happen in normal flow but
      // be defensive), `defaultPayerMemberId` stays null and the user
      // picks manually.
      const u = await loadUser();
      if (u && session) {
        const me = session.members.find((m) => m.user_id === u.user_id);
        if (me) defaultPayerMemberId = me.id;
      }
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
      <BillForm
        {session}
        {defaultPayerMemberId}
        onSubmit={handleSubmit}
      />
    </div>
  {/if}
</section>