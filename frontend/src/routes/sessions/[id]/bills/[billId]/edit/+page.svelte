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

    <!-- v0.3.15 §3.15.2 #6 v2 (PO msg #4752+#4763): 圆形 FAB
         v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 (保留 50% 圆形 + 白色 icon) -->
    <a
      class="fab glass-pill fab-left"
      href="/sessions/{sessionId}"
      aria-label="返回"
      in:fly={{ y: 60, duration: 400, delay: 200 }}
    >
      <ArrowLeft size={24} strokeWidth={2.4} />
    </a>
    <button
      type="submit"
      class="fab glass-pill fab-right"
      form="bill-form"
      aria-label="保存"
      in:fly={{ y: 60, duration: 400, delay: 250 }}
    >
      <Check size={24} strokeWidth={2.8} />
    </button>
  {/if}
</section>

<style>
  /* v0.3.15 §3.15.2 #6 v2: 圆形 FAB (跟 session 主页「新建账单」FAB 同形态)
   * v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 — bg/box-shadow/border 由
   *   .glass-pill 提供。
   * v0.3.16 #9 (PO msg 20:01): FAB icon color 改主题色 — 删 color: #fff (icon 白色在浅紫
   *   玻璃上看不清),改由 .glass-pill 提供 var(--accent-700, #4338ca) 深紫主题色。
   *   .fab 写在 .glass-pill 之后 → 同 specificity 时 .fab 后定义覆盖 .glass-pill。 */
  .fab {
    position: fixed;
    bottom: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    /* glass-pill 提供 bg / box-shadow / border / backdrop-filter / color (var(--accent-700, #4338ca)),
       这里只补 padding + z-index + 圆形保持。icon 颜色 = 主题色,跟玻璃协调。 */
    z-index: 100;
    text-decoration: none;
    border: none;
    cursor: pointer;
    padding: 0;
    transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease, color 150ms ease;
  }
  .fab-left { left: 24px; }
  .fab-right { right: 24px; }
  /* .fab:hover 不再写 color — 由 .glass-pill:hover 全局处理 (icon 颜色保持主题色) */
  .fab:hover { transform: translateY(-2px); }
  .fab:active { transform: scale(0.96); }
  .fab:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  @media (max-width: 600px) {
    .fab { bottom: 16px; }
    .fab-left { left: 16px; }
    .fab-right { right: 16px; }
  }
</style>
