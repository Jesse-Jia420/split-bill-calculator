<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getSessionWithSecret } from '$api/sessions';
  import { createBill, listBills } from '$api/bills';
  import type { SessionDetail } from '$api/sessions';
  import { loadUser } from '$stores/user';
  import BillForm from '$components/BillForm.svelte';

  let session: SessionDetail | null = null;
  let loading = true;
  let error: string | null = null;

  // v0.1.2 (T19): pass this into BillForm so the payer dropdown
  // defaults to the caller's own SessionMember.id in this session.
  let defaultPayerMemberId: number | null = null;

  // v0.2.1 T03 (smart-date chips): only show "今天 / 昨天 / 上周"
  // when this session has zero bills yet. Hooked through the
  // ``existingBillsCount`` prop below.
  let existingBillsCount = 0;

  $: sessionId = Number(page.params.id);

  onMount(async () => {
    try {
      // v0.3.2: use getSessionWithSecret so anon callers (X-Nickname-Secret
      // in localStorage) can read session detail. Plain getSession only
      // sends cookie auth and 403s for anon slots.
      const result = await getSessionWithSecret(sessionId);
      session = result.session;
      // Find the SessionMember that maps to the current user. If the
      // caller isn't yet a member (shouldn't happen in normal flow but
      // be defensive), `defaultPayerMemberId` stays null and the user
      // picks manually. For anon callers, actingAsMemberId IS the member
      // row id and user_id is null, so use that as defaultPayer.
      const u = await loadUser();
      if (u && session) {
        const me = session.members.find((m) => m.user_id === u.user_id);
        if (me) defaultPayerMemberId = me.id;
      } else if (result.actingAsMemberId && session) {
        defaultPayerMemberId = result.actingAsMemberId;
      }
      // v0.2.1 T03: tally the bills to decide whether the smart-date
      // chips appear. We tolerate the listBills call failing (e.g. the
      // caller is brand-new without GET /sessions/{id}/bills access)
      // by defaulting to "0 bills".
      try {
        const all = await listBills(sessionId);
        existingBillsCount = all.length;
      } catch {
        existingBillsCount = 0;
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
        {existingBillsCount}
        onSubmit={handleSubmit}
      />
    </div>
  {/if}
</section>