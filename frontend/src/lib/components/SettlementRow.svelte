<!--
  SettlementRow.svelte -- v0.3.0729-4 #10

  PO 字面 "用户可以增加 已结算的记录" -- FE 显示一条 settlement_records 的 row.
  形态 (mockup 5 record-row): 头像 → 头像 + (name → name) + amount + meta + ✕ delete (仅 owner).

  v0.3.0729-4 #10:
    已结算记录删除：item 先滑到最左侧后，继续左滑才出现删除按钮；
    跟手 + 橡皮糖效果与账单/账本列表一致。
-->
<script lang="ts">
  import type { SettlementRecord } from '$api/settlements';
  import { formatMoney } from '$lib/utils/format';
  import { currencySymbol } from '$lib/utils/currency';
  import { paletteGradient, paletteIndexFromMemberId, avatarInitialOf } from '$lib/utils/palette';
  import { Trash2 } from 'lucide-svelte';

  let { record, sessionMemberId, onDelete = undefined }: {
    record: SettlementRecord;
    sessionMemberId: number;
    onDelete?: ((recordId: number) => void | Promise<void>) | undefined;
  } = $props();

  function paletteIndex(memberId: number): number {
    return paletteIndexFromMemberId(memberId);
  }
  function initialOf(name: string): string {
    return avatarInitialOf(name);
  }

  function fmtAmount(amountStr: string, currency: string): string {
    const n = Number(amountStr);
    if (Number.isNaN(n)) return amountStr;
    return currencySymbol(currency) + formatMoney(n, { currency, showSymbol: false });
  }

  function fmtDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // Compact inline time left of names — date + clock, no year (currency lives in amount).
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  }

  let canDelete = $derived(record.created_by === sessionMemberId);
  let payerPal = $derived(paletteGradient(paletteIndex(record.payer_id)));
  let payeePal = $derived(paletteGradient(paletteIndex(record.payee_id)));

  let rowEl: HTMLElement | undefined;
  let deleteBtnEl: HTMLButtonElement | undefined;

  // v0.3.0729-4 #10: 连续跟手滑动
  // Phase 1 (0..ITEM_SLIDE): 内容左移到最左
  // Phase 2 (>ITEM_SLIDE): 删除按钮跟手出现 + 橡皮糖
  // 删除圆 40px（非账单列表 56px）：record-row ≈ avatar 28 + pad 24 = 52px，
  // 56px 圆会被 .settlement-swipe-wrap overflow:hidden 上下裁切。
  const ACTION_WIDTH = 40;
  const ITEM_SLIDE = 48;
  const SWIPE_THRESHOLD = ITEM_SLIDE + 30;
  const TAP_THRESHOLD = 10;

  let swipeOffset = $state(0);
  let dragOffset = $state(0);
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let dragAxis: 'h' | 'v' | null = null;
  let gestureArmed = false; // 已在最左 / 无横向溢出时可接管删除手势

  function rubberBandProgress(abs: number): number {
    if (abs <= ACTION_WIDTH) return abs / ACTION_WIDTH;
    const overshoot = abs - ACTION_WIDTH;
    return 1 + (1 - Math.exp(-overshoot / 30)) * 0.5;
  }

  function rowOffset(): number {
    return isDragging ? dragOffset : swipeOffset;
  }

  function contentShift(offset: number): number {
    // offset 负 = 左滑；内容最多左移 ITEM_SLIDE
    if (offset >= 0) return 0;
    return Math.max(offset, -ITEM_SLIDE);
  }

  function deleteProgress(offset: number): number {
    if (offset >= -ITEM_SLIDE) return 0;
    return rubberBandProgress(-offset - ITEM_SLIDE);
  }

  function isAtLeftmost(): boolean {
    if (!rowEl) return true;
    // 无横向溢出，或已滚到最右端（视觉最左内容尽头）
    if (rowEl.scrollWidth <= rowEl.clientWidth + 1) return true;
    return rowEl.scrollLeft + rowEl.clientWidth >= rowEl.scrollWidth - 1;
  }

  function applyDeleteProgress(progress: number) {
    if (deleteBtnEl) {
      deleteBtnEl.style.setProperty('--swipe-progress', String(progress));
    }
  }

  function startDrag(clientX: number, clientY: number) {
    if (!canDelete) return;
    dragStartX = clientX;
    dragStartY = clientY;
    dragAxis = null;
    gestureArmed = isAtLeftmost() || swipeOffset < 0;
    dragOffset = swipeOffset;
    isDragging = true;
  }

  function moveDrag(clientX: number, clientY: number, e?: TouchEvent | MouseEvent) {
    if (!isDragging || !canDelete) return;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    if (dragAxis === null) {
      if (Math.abs(dx) < TAP_THRESHOLD && Math.abs(dy) < TAP_THRESHOLD) return;
      dragAxis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (dragAxis === 'h') {
        // 未到最左且想左滑：让原生横向滚动接管
        if (!gestureArmed && dx < 0 && !isAtLeftmost()) {
          isDragging = false;
          dragAxis = null;
          return;
        }
        gestureArmed = true;
        if (e && 'cancelable' in e && e.cancelable) e.preventDefault();
      }
    }

    if (dragAxis === 'v' || !gestureArmed) return;
    if (e && 'cancelable' in e && e.cancelable) e.preventDefault();

    let next = swipeOffset + dx;
    if (next > 0) next = 0;
    if (next < -300) next = -300;
    dragOffset = next;
    applyDeleteProgress(deleteProgress(next));
  }

  function endDrag() {
    if (!isDragging) return;
    const finalOffset = dragOffset;
    if (finalOffset <= -SWIPE_THRESHOLD) {
      swipeOffset = -(ITEM_SLIDE + ACTION_WIDTH);
    } else {
      swipeOffset = 0;
    }
    applyDeleteProgress(deleteProgress(swipeOffset));
    isDragging = false;
    dragOffset = 0;
    dragAxis = null;
    gestureArmed = false;
  }

  function cancelDrag() {
    if (!isDragging) return;
    swipeOffset = 0;
    dragOffset = 0;
    isDragging = false;
    dragAxis = null;
    gestureArmed = false;
    applyDeleteProgress(0);
  }

  function handleTouchStart(e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    startDrag(t.clientX, t.clientY);
  }
  function handleTouchMove(e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    moveDrag(t.clientX, t.clientY, e);
  }
  function handleTouchEnd() {
    endDrag();
  }

  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    startDrag(e.clientX, e.clientY);
    const onMove = (ev: MouseEvent) => moveDrag(ev.clientX, ev.clientY, ev);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      endDrag();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function handleClickOutside(e: MouseEvent) {
    if (swipeOffset === 0 && !isDragging) return;
    const target = e.target as HTMLElement | null;
    if (target && target.closest(`[data-record-id="${record.id}"]`)) return;
    swipeOffset = 0;
    applyDeleteProgress(0);
  }

  function handleDeleteClick(e: MouseEvent) {
    e.stopPropagation();
    swipeOffset = 0;
    applyDeleteProgress(0);
    onDelete?.(record.id);
  }

  $effect(() => {
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  });

  $effect(() => {
    const el = rowEl;
    if (!el) return;
    const update = () => {
      el.classList.toggle('at-start', el.scrollLeft <= 1);
      el.classList.toggle(
        'at-end',
        el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
      );
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  });

  let offset = $derived(rowOffset());
  let progress = $derived(deleteProgress(offset));
  let shift = $derived(contentShift(offset));
</script>

<div
  class="settlement-swipe-wrap"
  class:dragging={isDragging}
  data-sbc="settlement-row"
  data-record-id={record.id}
  role="group"
  aria-label="已结算: {record.payer_name} → {record.payee_name}"
>
  {#if canDelete}
    <button
      bind:this={deleteBtnEl}
      class="delete-btn"
      type="button"
      aria-label="删除记录"
      title="删除"
      aria-hidden={progress <= 0}
      tabindex={progress >= 1 ? 0 : -1}
      style="--swipe-progress: {progress}"
      onclick={handleDeleteClick}
    >
      <Trash2 size={18} strokeWidth={2} aria-hidden="true" />
    </button>
  {/if}
  <div
    class="record-row scroll-wrapper"
    class:swiping={isDragging}
    style="transform: translateX({shift}px)"
    bind:this={rowEl}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    ontouchcancel={cancelDrag}
    onmousedown={handleMouseDown}
  >
    <span class="avatar" style={payerPal} aria-hidden="true">{initialOf(record.payer_name)}</span>
    <span class="arrow-mini" aria-hidden="true">→</span>
    <span class="avatar" style={payeePal} aria-hidden="true">{initialOf(record.payee_name)}</span>
    <!-- Single row: time left of nicknames; currency/time meta row removed (redundant with amount). -->
    <div
      class="row-main"
      title={record.note ? record.note : undefined}
    >
      <span class="row-time">{fmtDate(record.created_at)}</span>
      <span class="row-name">{record.payer_name}</span>
      <span class="row-arrow" aria-hidden="true">→</span>
      <span class="row-name">{record.payee_name}</span>
    </div>
    <div class="row-amount">{fmtAmount(record.amount, record.currency)}</div>
  </div>
</div>

<style>
  .settlement-swipe-wrap {
    position: relative;
    overflow: hidden;
  }

  .record-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid rgba(15, 23, 42, 0.05);
    background: transparent;
    will-change: transform;
    transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
    position: relative;
    z-index: 1;
  }
  .record-row.swiping {
    transition: none;
  }

  .avatar {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    color: #fff;
    border: 1.5px solid #fff;
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.08);
  }
  .arrow-mini { color: #a3a3a3; font-size: 12px; padding: 0 1px; flex-shrink: 0; }
  /* One horizontal band: time | names — all share the row's vertical center axis */
  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .row-time {
    flex: 0 0 auto;
    font-size: 12px;
    font-weight: 500;
    color: #737373;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
    white-space: nowrap;
    line-height: 1;
  }
  .row-name {
    font-size: 14px;
    font-weight: 500;
    color: #171717;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    line-height: 1.2;
  }
  .row-arrow {
    color: #737373;
    font-size: 12px;
    flex-shrink: 0;
    line-height: 1;
  }
  .row-amount {
    font-size: 14px;
    font-weight: 600;
    color: #10b981;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    flex-shrink: 0;
    line-height: 1;
  }

  /* v0.3.0729-4 #10: 跟手圆形删除按钮（形态同 BillListGrouped，直径适配矮行） */
  .delete-btn {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    width: calc(var(--swipe-progress, 0) * 40px);
    aspect-ratio: 1 / 1;
    min-height: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(
      135deg,
      rgba(220, 38, 38, 0.18) 0%,
      rgba(239, 68, 68, 0.12) 100%
    );
    border: 1px solid rgba(220, 38, 38, 0.28);
    color: var(--error-700, #be123c);
    cursor: pointer;
    padding: 0;
    backdrop-filter: blur(8px) saturate(1.8);
    -webkit-backdrop-filter: blur(8px) saturate(1.8);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      0 1px 2px rgba(220, 38, 38, 0.12);
    transition:
      width 220ms cubic-bezier(0.34, 1.56, 0.64, 1),
      opacity 180ms ease-out;
    z-index: 2;
    appearance: none;
    font-family: inherit;
    pointer-events: none;
    overflow: hidden;
    /* v0.3.0729-4+: 满显再乘 0.7，整体略降透明度 */
    opacity: calc(var(--swipe-progress, 0) * 0.7);
  }
  .settlement-swipe-wrap.dragging .delete-btn {
    transition: none;
  }
  .delete-btn[aria-hidden="false"] {
    pointer-events: auto;
  }

  .scroll-wrapper {
    position: relative;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    -ms-overflow-style: none;
    scroll-snap-type: x proximity;
    overscroll-behavior-x: contain;
  }
  .scroll-wrapper::-webkit-scrollbar { display: none; }
</style>
