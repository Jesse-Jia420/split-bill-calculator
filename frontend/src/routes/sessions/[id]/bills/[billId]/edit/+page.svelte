<script lang="ts">
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
  // v0.3.15 (PRD §3.15.2 #7): 用 Lucide ArrowLeft 替代 ← Unicode 字符
  // (iOS 系统字体在 PO 真机截图里显示为"乱码" #4543).
  import { ArrowLeft } from 'lucide-svelte';
  import BillForm from '$components/BillForm.svelte';
  import { toast } from '$stores/toast';

  let session: SessionDetail | null = null;
  let bill: Bill | null = null;
  let loading = true;

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
      // v0.3.15 (PO #4807): 错误统一走 Toast. 401 handled by auth middleware; 403/404 land here.
      toast.error(e?.message ?? '加载失败');
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
  {:else if session && bill}
    <h2>编辑账单</h2>
    <!-- v0.3.16 #8 (PO msg 19:26): 字段简化 — 去 'session:' 前缀 +
         '账单 #N' 编号 + '记录于' 文字, 只留 session.name + 时间。 -->
    <p class="muted">
      {session.name} · {formatDate(bill.created_at, { full: true })}
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

