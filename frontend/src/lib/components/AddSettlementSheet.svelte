<!--
  AddSettlementSheet.svelte -- v0.3.32 -- UAT 0725-2 #1

  PO 字面 "增加结算记录时,任一成员可给任一其它成员任一 session 内币种的任意正金额."

  形态 (mockup 2 + 3 -- add sheet empty + with preview):
  - Bottom sheet (玻璃 modal, 跟 CurrencyAddModal / InviteLinkButton modal 同族).
  - 字段: 付款人 select / 收款人 select / 币种 select / 金额 input / 备注 input.
  - 实时 preview 区: "旧应结算 - 已结 = 新应结算" 算式 (mockup 3 核心).
  - CTA "确认添加" (purple gradient -- 跟全站 primary button 同源).

  Props:
  - sessionId: number
  - members: { id, display_name }[]  -- 付款/收款 select 选项 (避免依赖 user store 之外的全局状态).
  - currencies: string[] -- session.currencies.
  - primaryCurrency: string -- session.primary_currency (默认币种 select + preview 用).
  - transfers: { from_member_id, to_member_id, amount }[] -- 当前 settle 返回的原始 transfers (用于 preview 算式).
  - onAdded: () => void -- 提交成功回调, parent 负责 refetch.

  行为约束:
  - 弹窗存在时锁 main 滚动 (跟 CurrencyAddModal 同款 onMount cleanup).
  - 付款/收款 select 默认: 付款人 = 当前 user (acting member), 收款人 = 当前最大欠款的 member.
  - preview 计算: 找 (payer, payee) 对的 raw transfer amount, 减去 amount 输入, 显示 new amount.
  - 如果 (payer, payee) 对当前 transfer 不存在 → preview 显示 "无对应转账" + new = -amount (即这变成新的 transfer).
  - amount > 0 强制, <= 0 时 disable submit.
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  // v0.3.0729-2 #6: 恢复 XIcon (× 关闭按钮) — 仅靠 drag-down 真机关不稳.
  import { X as XIcon } from 'lucide-svelte';
  import { portal } from '$lib/actions/portal';
  import { toast } from '$stores/toast';
  import { createSettlementRecord, type SettlementRecord } from '$api/settlements';
  import { ApiError } from '$api/client';
  import { formatMoney } from '$lib/utils/format';
  import { currencySymbol } from '$lib/utils/currency';

  export let sessionId: number;
  /** SessionMember.id -> display_name. 来自 session.members. */
  export let members: { id: number; display_name: string }[] = [];
  export let currencies: string[] = [];
  export let primaryCurrency: string = 'CNY';
  /** 当前 raw transfers from GET /sessions/{id}/settle -- 用于 preview 算式. */
  export let transfers: { from_member_id: number; to_member_id: number; amount: number }[] = [];
  /** 当前 SessionMember.id -- 决定付款人 select 默认值. */
  export let currentMemberId: number | null = null;
  /** 提交成功回调. */
  export let onAdded: ((record: SettlementRecord) => void) | undefined = undefined;

  // v0.3.0729-2 #6: dismiss callback (故意不用 on* 名) + createEventDispatcher 双通道.
  // 真正关不掉的根因在 portal.ts destroy 孤儿 DOM; dismiss 是父页 runes 可靠回调.
  export let dismiss: (() => void) | undefined = undefined;

  const dispatch = createEventDispatcher<{ close: void }>();

  // ---- 表单 state ----
  let payerId: number | null = null;
  let payeeId: number | null = null;
  let currency: string = primaryCurrency;
  /** 用户输入的金额字符串 (raw text), 避免受控 input 的浮点精度陷阱. */
  let amountStr: string = '';
  let note: string = '';
  let busy = false;

  /** 默认付款人 = 当前用户 (PO 字面 "任一成员可给任一其它成员"). */
  $: if (payerId === null && currentMemberId != null && members.length > 0) {
    if (members.some((m) => m.id === currentMemberId)) {
      payerId = currentMemberId;
    }
  }
  /** 默认收款人 = raw transfers 中 from=currentMemberId 的第一个 to_member_id (欠最多的人). */
  $: if (
    payeeId === null &&
    payerId != null &&
    transfers.length > 0
  ) {
    const largestOwed = transfers.find((t) => t.from_member_id === payerId);
    if (largestOwed) payeeId = largestOwed.to_member_id;
    else if (members.length > 1) {
      // 退化: 选第一个非付款人的 member.
      const other = members.find((m) => m.id !== payerId);
      if (other) payeeId = other.id;
    }
  }

  /** amount 解析 + 校验. */
  $: amountNum = amountStr.trim() === '' ? NaN : Number(amountStr.trim());
  $: amountValid = Number.isFinite(amountNum) && amountNum > 0;

  /** payer != payee 校验 (PO 字面 c). */
  $: payerPayeeValid = payerId != null && payeeId != null && payerId !== payeeId;

  /** currency 必须在 currencies 数组里 (BE 已校验, FE 防止 race). */
  $: currencyValid = currencies.length === 0 ? true : currencies.includes(currency);

  $: canSubmit = amountValid && payerPayeeValid && currencyValid && !busy;

  // ---- Preview 算式 ----
  /** 找 raw transfer (payer -> payee), 找不到时为 null (新 transfer). */
  function findRawTransfer(
    fromId: number,
    toId: number
  ): { from_member_id: number; to_member_id: number; amount: number } | null {
    return (
      transfers.find((t) => t.from_member_id === fromId && t.to_member_id === toId) ?? null
    );
  }
  $: rawTransfer =
    payerId != null && payeeId != null ? findRawTransfer(payerId, payeeId) : null;
  $: newAmount =
    rawTransfer && amountValid ? Math.max(rawTransfer.amount - amountNum, 0) : null;

  /** 找出 payer / payee 名字 (供 preview 文案用). */
  function nameOf(id: number | null): string {
    if (id == null) return '';
    return members.find((m) => m.id === id)?.display_name ?? `#${id}`;
  }

  function fmtAmt(n: number): string {
    return currencySymbol(currency) + formatMoney(n, { currency, showSymbol: false });
  }

  function close() {
    if (busy) return;
    dismiss?.();
    dispatch('close');
  }

  /** v0.3.0728-2 #21 — UAT 0728-2 #21 (PO msg 16:50) 拖动下滑关闭 (跟 v0.3.37 #5 InviteLinkButton 同款):
   *  - touchstart: record dragStartY + sheetHeight.
   *  - touchmove (deltaY >= 0): sheet `transform: translateY(deltaY)px` 跟手下滑.
   *  - touchmove (deltaY < 0): rubber band `translateY(deltaY/3)px + scale(1 + max(deltaY, -100)/4000)` 轻微反馈.
   *  - touchend (deltaY > sheetHeight * 0.3): close() (跟手下滑超阈值 → dismiss).
   *  - touchend (deltaY < 阈值): 回弹 (transition: transform 280ms cubic-bezier(0.32, 0.72, 0, 1)). */
  let sheetEl: HTMLDivElement | null = null;
  let dragStartY = 0;
  let dragging = false;
  let dragDeltaY = 0;
  let sheetHeight = 0;

  function handleTouchStart(e: TouchEvent) {
    if (!sheetEl) return;
    const t = e.touches[0];
    if (!t) return;
    dragStartY = t.clientY;
    dragging = true;
    sheetHeight = sheetEl.getBoundingClientRect().height;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!dragging || !sheetEl) return;
    const t = e.touches[0];
    if (!t) return;
    const deltaY = t.clientY - dragStartY;
    dragDeltaY = deltaY;
    if (deltaY >= 0) {
      // v0.3.0728-2 #21 re-fix: preventDefault 阻止 iOS Safari pan-y 浏览器默认 pan,
      // 让 JS drag-down dismiss 完全接管 touchmove. 否则浏览器开始 pan (虽然 sheet 已 bottom:0
      // 无 overflow 视觉不动) 但 touchend 可能提前 fire 导致 dragDeltaY < threshold 不关.
      e.preventDefault();
      sheetEl.style.transform = `translateY(${deltaY}px)`;
      sheetEl.style.transition = 'none';
    } else {
      const rubberY = deltaY / 3;
      const scale = 1 + Math.max(deltaY, -100) / 4000;
      sheetEl.style.transform = `translateY(${rubberY}px) scale(${scale})`;
      sheetEl.style.transition = 'none';
    }
  }

  function handleTouchEnd() {
    if (!dragging || !sheetEl) return;
    // v0.3.0729-2 #6: 阈值 30% → 15%/80px, 跟 CurrencyAddModal 一致, 下滑更易关闭.
    const threshold = Math.min(sheetHeight * 0.15, 80);
    if (dragDeltaY > threshold) {
      close();
    } else {
      sheetEl.style.transform = '';
      sheetEl.style.transition = 'transform 280ms cubic-bezier(0.32, 0.72, 0, 1)';
      setTimeout(() => {
        if (sheetEl) sheetEl.style.transition = '';
      }, 300);
    }
    dragging = false;
    dragDeltaY = 0;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) close();
  }

  /** 锁 main 滚动 (跟 CurrencyAddModal 同款). */
  onMount(() => {
    const mainEl = document.querySelector('main');
    if (!mainEl) return () => {};
    const origOverflow = mainEl.style.overflow;
    const origOverscroll = mainEl.style.overscrollBehavior;
    mainEl.style.overflow = 'hidden';
    mainEl.style.overscrollBehavior = 'contain';
    return () => {
      mainEl.style.overflow = origOverflow;
      mainEl.style.overscrollBehavior = origOverscroll;
    };
  });

  async function handleSubmit() {
    if (!canSubmit || payerId == null || payeeId == null) return;
    busy = true;
    try {
      const record = await createSettlementRecord(sessionId, {
        payer_id: payerId,
        payee_id: payeeId,
        currency,
        amount: amountNum,
        note: note.trim() === '' ? undefined : note.trim(),
      });
      toast.success(`已添加 ${nameOf(record.payer_id)} → ${nameOf(record.payee_id)} ${record.amount} ${record.currency}`);
      onAdded?.(record);
      dismiss?.();
      dispatch('close');
    } catch (e: any) {
      const code = e?.code ?? e?.detail?.error ?? 'unknown';
      const msg = e?.detail?.error ?? e?.message ?? '添加失败';
      toast.error(`添加失败: ${msg}`);
      // code 仅用于日志, 不暴露给用户
      console.error('[AddSettlementSheet] submit failed:', code, e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- v0.3.27 (PO msg 9234 真机截图质问, 跟 InviteLinkButton / CurrencyAddModal 同根因): wrap 整个
     modal markup 在 `<div use:portal>` host 里, portal action 物理 appendChild 到 document.body,
     跳出 ancestor 任何 backdrop-filter 的 CSS containing block trap. -->
<div use:portal data-testid="add-settlement-sheet-host">
<!-- Backdrop (跟 mockup 2 / 3 一致: rgba(15,23,42,0.40) + blur(4px)) -->
<div
  class="backdrop"
  role="presentation"
  onclick={close}
  data-sbc="settlement-sheet-backdrop"
></div>

<!-- Bottom sheet -->
<!-- v0.3.0729-2 #6: 恢复 × 关闭按钮 (仅靠 drag-down 真机关不稳) + 保留 drag-down 作辅助. -->
<div
  class="sheet"
  class:dragging
  role="dialog"
  aria-modal="true"
  aria-label="添加已结算记录"
  data-sbc="settlement-sheet"
  bind:this={sheetEl}
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
  ontouchcancel={handleTouchEnd}
>
  <div class="sheet-handle" aria-hidden="true"></div>
  <div class="sheet-head">
    <span class="sheet-title">添加已结算记录</span>
    <button
      class="sheet-close"
      type="button"
      aria-label="关闭"
      onclick={close}
      data-sbc="settlement-sheet-close"
    >
      <XIcon size={16} strokeWidth={2.4} color="currentColor" />
    </button>
  </div>

  <div class="form">
    <!-- Row 1: 付款人 + 收款人 (并排) -->
    <div class="form-row">
      <div class="field">
        <label class="field-label" for="add-settle-payer">付款人</label>
        <select
          id="add-settle-payer"
          class="field-control"
          bind:value={payerId}
          disabled={busy}
          data-sbc="sheet-payer-select"
        >
          <option value={null}>— 请选择 —</option>
          {#each members as m (m.id)}
            <option value={m.id}>{m.display_name}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="add-settle-payee">收款人</label>
        <select
          id="add-settle-payee"
          class="field-control"
          bind:value={payeeId}
          disabled={busy}
          data-sbc="sheet-payee-select"
        >
          <option value={null}>— 请选择 —</option>
          {#each members as m (m.id)}
            <option value={m.id}>{m.display_name}</option>
          {/each}
        </select>
      </div>
    </div>

    <!-- Row 2: 币种 + 金额 (并排) -->
    <div class="form-row">
      <div class="field currency-field">
        <label class="field-label" for="add-settle-currency">币种</label>
        <select
          id="add-settle-currency"
          class="field-control"
          bind:value={currency}
          disabled={busy}
          data-sbc="sheet-currency-select"
        >
          {#each currencies as c (c)}
            <option value={c}>{c}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="add-settle-amount">金额</label>
        <div
          class="field-control"
          class:focused={amountStr.length > 0}
          data-sbc="sheet-amount-control"
        >
          <span class="currency-prefix">{currencySymbol(currency)}</span>
          <input
            id="add-settle-amount"
            class="amount-input"
            type="text"
            inputmode="decimal"
            placeholder="0.00"
            autocomplete="off"
            bind:value={amountStr}
            disabled={busy}
            data-sbc="sheet-amount-input"
          />
        </div>
      </div>
    </div>

    <!-- Row 3: 备注 (full) -->
    <div class="form-row full">
      <div class="field">
        <label class="field-label" for="add-settle-note">备注 (可选)</label>
        <div class="field-control">
          <input
            id="add-settle-note"
            type="text"
            placeholder="比如: 已微信转账 / 已现金"
            autocomplete="off"
            bind:value={note}
            disabled={busy}
            data-sbc="sheet-note-input"
          />
        </div>
        {#if !note}
          <div class="field-note">例如「已微信转账」「机场付过」便于事后核对</div>
        {/if}
      </div>
    </div>
  </div>

  <!-- 实时 preview: 旧应结算 - 已结 = 新应结算 (mockup 3) -->
  {#if payerPayeeValid}
    <div class="preview" data-sbc="sheet-preview">
      <div class="preview-title">应结算金额变化</div>
      {#if rawTransfer}
        <div class="preview-row">
          <span class="label">旧应结算</span>
          <span class="val muted">{nameOf(rawTransfer.from_member_id)} → {nameOf(rawTransfer.to_member_id)} {fmtAmt(rawTransfer.amount)}</span>
        </div>
        <div class="preview-divider"></div>
        {#if amountValid}
          <div class="preview-row">
            <span class="label">本次已结算</span>
            <span class="val added">{nameOf(payerId)} → {nameOf(payeeId)} {fmtAmt(amountNum)}</span>
          </div>
          <div class="preview-arrow-wrap"><span class="arrow-down" aria-hidden="true">↓</span></div>
          <div class="preview-new">
            <div class="left">
              <span class="badge">新</span>
              <span class="from-to">{nameOf(payerId)} <span class="arrow" aria-hidden="true">→</span> {nameOf(payeeId)}</span>
            </div>
            <span class="new-amount">{fmtAmt(newAmount ?? 0)}</span>
          </div>
        {/if}
      {:else if amountValid}
        <div class="preview-row">
          <span class="label">无对应原转账</span>
          <span class="val muted">将新建一笔 {fmtAmt(amountNum)} 的反向转账</span>
        </div>
      {:else}
        <div class="preview-row">
          <span class="label">填写金额</span>
          <span class="val muted">查看 preview</span>
        </div>
      {/if}
    </div>
  {/if}

  <!-- CTA -->
  <div class="cta-row">
    <button
      class="btn-primary"
      type="button"
      disabled={!canSubmit}
      onclick={handleSubmit}
      data-sbc="sheet-submit-btn"
    >
      {busy ? '提交中…' : '确认添加'}
    </button>
  </div>

  <!-- v0.3.0729-2 #6: 删 home-indicator 占位 (黑 bar 早删, 30px 空 spacer 也多余). -->
</div>
</div>

<style>
  /* === Backdrop === */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.40);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    /* v0.3.0729-2 #6: backdrop z 跟 sheet 配套升高 (sheet=1000). */
    z-index: 999;
  }

  /* === Bottom Sheet (modal) === */
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    max-width: 480px;
    margin: 0 auto;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: saturate(220%) blur(28px);
    -webkit-backdrop-filter: saturate(220%) blur(28px);
    border-top-left-radius: 24px;
    border-top-right-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-bottom: 0;
    box-shadow:
      0 -8px 32px rgba(15, 23, 42, 0.12),
      inset 0 1px 0 rgba(255, 255, 255, 0.85);
    /* v0.3.0729-2 #6: z-index 60 → 1000, 跟 CurrencyAddModal 对齐,
       避免被 VersionBadge (z=200) / NavBar (z=100) 盖住交互. */
    z-index: 1000;
    padding: 8px 16px 16px;
    animation: slideUp 280ms cubic-bezier(0.32, 0.72, 0, 1);
    max-height: 92vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    /* v0.3.0728-2 #21 re-fix: touch-action: none 让 JS 完全接管 touchmove (避免 iOS Safari
       pan-y 浏览器默认 pan 抢 touchend → dragDeltaY 跟手指不一致 → 关不掉).
       form 字段短 (max-height:92vh 内 fit) 不需要内部 scroll, 改 none 安全. */
    touch-action: none;
    will-change: transform;
  }
  /* v0.3.0728-2 #21: drag 时 inline style 控制 transform, 这里只保证动画期间 overflow 不被 clip */
  .sheet.dragging {
    transition: none !important;
  }
  @keyframes slideUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  .sheet-handle {
    width: 36px;
    height: 4px;
    background: rgba(15, 23, 42, 0.18);
    border-radius: 100px;
    margin: 0 auto 12px;
  }
  .sheet-head {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0 4px 12px;
  }
  .sheet-title {
    grid-column: 2;
    font-size: 17px;
    font-weight: 600;
    color: #171717;
    letter-spacing: -0.01em;
    justify-self: center;
  }
  .sheet-close {
    grid-column: 3;
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    justify-self: end;
    border-radius: 50%;
    background: rgba(15, 23, 42, 0.10);
    color: #404040;
    border: 0;
    cursor: pointer;
    transition: background 150ms ease;
  }
  .sheet-close:hover { background: rgba(15, 23, 42, 0.12); }

  /* === Form === */
  .form { padding-bottom: 8px; }
  .form-row { display: flex; gap: 10px; margin-bottom: 10px; }
  .form-row.full { flex-direction: column; gap: 0; }
  .field { flex: 1; min-width: 0; }
  .currency-field { flex: 0 0 96px; }
  .field-label {
    font-size: 12px;
    font-weight: 500;
    color: #6b7280;
    margin-bottom: 4px;
    letter-spacing: 0.02em;
  }
  .field-control {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 12px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(15, 23, 42, 0.08);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.8),
      0 1px 2px rgba(15, 23, 42, 0.03);
    color: #171717;
    font-size: 14px;
  }
  .field-control.focused {
    border-color: rgba(99, 102, 241, 0.55);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.8),
      0 0 0 3px rgba(99, 102, 241, 0.12),
      0 1px 2px rgba(15, 23, 42, 0.03);
  }
  select.field-control {
    appearance: none;
    -webkit-appearance: none;
    padding-right: 28px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    cursor: pointer;
  }
  select.field-control:disabled { cursor: not-allowed; opacity: 0.6; }
  .field-control input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: 15px;
    color: #171717;
    padding: 0;
  }
  .field-control input::placeholder { color: #a3a3a3; }
  .field-control .currency-prefix {
    color: #525252;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .field-control .amount-input {
    font-size: 16px;
    font-weight: 600;
    color: #171717;
    font-variant-numeric: tabular-nums;
  }
  .field-note {
    font-size: 11px;
    color: #737373;
    margin-top: 4px;
    padding: 0 4px;
  }

  /* === Preview (mockup 3) === */
  .preview {
    margin: 10px 0 12px;
    padding: 12px 14px;
    background: linear-gradient(135deg, rgba(236, 254, 230, 0.85) 0%, rgba(220, 252, 231, 0.75) 100%);
    border: 1px solid rgba(16, 185, 129, 0.25);
    border-radius: 14px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      0 1px 4px rgba(16, 185, 129, 0.10);
  }
  .preview-title {
    font-size: 11px;
    font-weight: 600;
    color: #047857;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .preview-title::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.20);
  }
  .preview-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
    font-size: 13px;
    color: #374151;
  }
  .preview-row .label { font-weight: 500; color: #374151; }
  .preview-row .val {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: #171717;
  }
  .preview-row .val.muted { color: #737373; font-weight: 500; }
  .preview-row .val.added { color: #047857; }
  .preview-divider {
    height: 1px;
    background: rgba(16, 185, 129, 0.18);
    margin: 6px 0;
  }
  .preview-arrow-wrap {
    display: flex;
    justify-content: center;
    padding: 2px 0;
    color: #10b981;
    font-size: 14px;
    font-weight: 700;
  }
  .preview-new {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.65);
    border-radius: 10px;
    border: 1.5px dashed rgba(16, 185, 129, 0.40);
  }
  .preview-new .left { display: flex; align-items: center; gap: 8px; }
  .preview-new .badge {
    font-size: 10px;
    font-weight: 700;
    color: #047857;
    padding: 2px 7px;
    border-radius: 9999px;
    background: rgba(16, 185, 129, 0.15);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .preview-new .from-to {
    font-size: 14px;
    font-weight: 600;
    color: #171717;
  }
  .preview-new .from-to .arrow {
    color: #a3a3a3;
    padding: 0 4px;
    font-weight: 400;
  }
  .preview-new .new-amount {
    font-size: 20px;
    font-weight: 700;
    color: #10b981;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }

  /* === CTA === */
  .cta-row { padding: 4px 0 12px; }
  .btn-primary {
    width: 100%;
    height: 50px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.95) 0%, rgba(168, 85, 247, 0.95) 100%);
    color: #fff;
    font-size: 16px;
    font-weight: 600;
    border: 0;
    cursor: pointer;
    box-shadow:
      0 4px 12px rgba(99, 102, 241, 0.30),
      inset 0 1px 0 rgba(255, 255, 255, 0.25);
    letter-spacing: 0.01em;
  }
  .btn-primary:disabled {
    background: rgba(15, 23, 42, 0.10);
    color: rgba(15, 23, 42, 0.40);
    box-shadow: none;
    cursor: not-allowed;
  }
</style>