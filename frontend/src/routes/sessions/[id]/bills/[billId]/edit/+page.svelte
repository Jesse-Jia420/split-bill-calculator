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
  // v0.3.15 (PRD §3.15.2 #6 v2, PO msg #4752+#4763): 圆形 FAB 替代 sticky bar。
  // - 左下 FAB: ArrowLeft (返回 session)
  // - 右下 FAB: Check (保存账单, 走 form="bill-form" 外部 submit)
  // 跟 session 主页「新建账单」FAB 同形态 (56×56 圆形 + indigo 渐变)。
  import { ArrowLeft, Check } from 'lucide-svelte';
  import { fly } from 'svelte/transition';
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
    <a class="btn ghost" href="/sessions/{sessionId}"><ArrowLeft size={16} /> 返回</a>
  {:else if session && bill}
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

    <!-- v0.3.15 §3.15.2 #6 v2 (PO msg #4752+#4763): 圆形 FAB -->
    <a
      class="fab fab-left"
      href="/sessions/{sessionId}"
      aria-label="返回"
      in:fly={{ y: 60, duration: 400, delay: 200 }}
    >
      <ArrowLeft size={24} strokeWidth={2.4} />
    </a>
    <button
      type="submit"
      class="fab fab-right"
      form="bill-form"
      aria-label="保存"
      in:fly={{ y: 60, duration: 400, delay: 250 }}
    >
      <Check size={24} strokeWidth={2.8} />
    </button>
  {/if}
</section>

<style>
  /* v0.3.15 §3.15.2 #6 v2: 圆形 FAB (跟 session 主页「新建账单」FAB 同形态) */
  .fab {
    position: fixed;
    bottom: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
    color: #fff;
    box-shadow: 0 4px 12px rgba(79, 70, 229, 0.35);
    z-index: 100;
    text-decoration: none;
    border: none;
    cursor: pointer;
    transition: transform 150ms ease, box-shadow 150ms ease;
  }
  .fab-left { left: 24px; }
  .fab-right { right: 24px; }
  .fab:hover { transform: scale(1.05); }
  .fab:active { transform: scale(0.95); }
  .fab:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px #4f46e5;
  }
  @media (max-width: 600px) {
    .fab { bottom: 16px; }
    .fab-left { left: 16px; }
    .fab-right { right: 16px; }
  }
</style>
