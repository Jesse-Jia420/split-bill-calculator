��<script lang="ts">
  /**
   * v0.1.2 (PO 2026-07-01 fix #3): edit-bill page.
   *
   * Reuses BillForm in `mode="edit"` + an `existingBill` prop, which
   * pre-fills amount / payer / occurred_at / currency / participants
   * (description is read-only per the T17 backend rule).
   *
   * On submit, calls `updateBill(sessionId, billId, payload)` and
   * navigates back to the session detail page on success.
   */
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getSessionWithSecret } from '$api/sessions';
  import { getBill, updateBill } from '$api/bills';
  import { formatDate } from '$lib/utils/format';
  import type { SessionDetail } from '$api/sessions';
  import type { Bill } from '$api/bills';
  import BillForm from '$components/BillForm.svelte';

  let session: SessionDetail | null = null;
  let bill: Bill | null = null;
  let loading = true;
  let error: string | null = null;

  $: sessionId = Number(page.params.id);
  $: billId = Number(page.params.billId);

  onMount(async () => {
    try {
      // v0.3.2: use getSessionWithSecret so anon callers can read
      // session detail. Plain getSession only sends cookie auth and
      // 403s for anon slots.
      const result = await getSessionWithSecret(sessionId);
      session = result.session;
      bill = await getBill(sessionId, billId);
    } catch (e: any) {
      error = e?.message ?? '加载失败';
      // 401 is handled by the auth middleware; 403/404 land here.
    } finally {
      loading = false;
    }
  });

  async function handleSubmit(payload: any) {
    await updateBill(sessionId, billId, payload);
    await goto(`/sessions/${sessionId}`);
  }
</script>

<section>
  {#if loading}
    <p class="muted">加载中…</p>
  {:else if error}
    <div class="error">{error}</div>
    <a class="btn ghost" href="/sessions/{sessionId}">← 返回</a>
  {:else if session && bill}
    <div class="row" style="margin-bottom: var(--space-3);">
      <a class="btn ghost" href="/sessions/{session.id}">← 返回</a>
    </div>
    <h2>编辑账单</h2>
    <p class="muted">
      session: {session.name} · 账单 #{bill.id} · 记录于
      {formatDate(bill.created_at, { full: true })}
    </p>

    <div class="card">
      <BillForm
        {session}
        mode="edit"
        existingBill={bill}
        onSubmit={handleSubmit}
      />
    </div>
  {/if}
</section>
