<script lang="ts">
  /**
   * v0.1.2 反馈修 6 (PO 2026-07-02 11:23 UX 改写) — bills grouped list。
   *
   * 本次改写:
   * - 项目 3 (Bill item 背景色统一):
   *     .bill-row 删除独立 background (默认透明继承)
   *     .day-bills 删除 padding + border-top,bill row 直接贴在 day header 下
   *     结果: bill row 跟 day group 内部容器共享同一背景色 (消除灰色边框)
   *
   * 沿用项目 5 (iOS Mail-style swipe) + 项目 4 (「分摊」克制文案)
   *
   * 历史: v0.1.2 反馈修 5 Commit 2 (bd0cf89) — bill item 重构 + swipe
   */
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { fly } from 'svelte/transition';
  import type { Bill } from '$api/bills';

  export let bills: Bill[];
  export let sessionId: number;
  export let memberIdToName: Record<number, string> = {};
  export let currentUserMemberId: number | null = null;
  export let onDelete: ((billId: number) => void | Promise<void>) | null = null;

  type Group = {
    date: string;
    bills: Bill[];
    total: number;
    currency: string;
    perCapita: number;
  };

  let collapsed: Record<string, boolean> = {};

  let dragOffset: Record<number, number> = {};
  let swipeOffset: Record<number, number> = {};
  let isDragging: Record<number, boolean> = {};
  let openSwipeBillId: number | null = null;

  let dragBillId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragLastX = 0;
  let dragAxis: 'h' | 'v' | null = null;

  const ACTION_WIDTH = 80;
  const SWIPE_THRESHOLD = 60;
  const TAP_THRESHOLD = 10;

  function localDateKey(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'unknown';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function computePerCapita(groupBills: Bill[]): number {
    let sum = 0;
    for (const b of groupBills) {
      const n = b.participants?.length ?? 0;
      if (n > 0) sum += b.amount / n;
    }
    return sum;
  }

  function buildGroups(billList: Bill[]): Group[] {
    if (!billList || billList.length === 0) return [];
    const buckets = new Map<string, Bill[]>();
    for (const b of billList) {
      const k = localDateKey(b.occurred_at);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(b);
    }
    const out: Group[] = [];
    for (const [date, list] of buckets.entries()) {
      const sorted = [...list].sort((a, b) => {
        const ta = new Date(a.occurred_at).getTime();
        const tb = new Date(b.occurred_at).getTime();
        if (ta !== tb) return ta - tb;
        return a.id - b.id;
      });
      const total = sorted.reduce((acc, b) => acc + b.amount, 0);
      const currency = sorted[0]?.currency ?? '';
      out.push({
        date,
        bills: sorted,
        total,
        currency,
        perCapita: computePerCapita(sorted),
      });
    }
    out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return out;
  }

  $: groups = buildGroups(bills);

  function fmtAmount(n: number): string {
    return n.toFixed(2);
  }

  function fmtBillTime(iso: string): string {
    try {
      const d = new Date(iso);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    } catch {
      return iso;
    }
  }

  function payerName(b: Bill): string {
    return memberIdToName[b.payer_id] ?? ('#' + b.payer_id);
  }

  function yourShare(b: Bill): number | null {
    if (currentUserMemberId === null || currentUserMemberId === undefined) return null;
    const inPart = (b.participants ?? []).some((p) => p.member_id === currentUserMemberId);
    if (!inPart) return null;
    const n = b.participants?.length ?? 0;
    if (n <= 0) return null;
    return b.amount / n;
  }

  // ===== swipe logic =====

  function getRowOffset(billId: number): number {
    if (isDragging[billId]) return dragOffset[billId] ?? 0;
    return swipeOffset[billId] ?? 0;
  }

  function startDrag(billId: number, clientX: number, clientY: number) {
    dragBillId = billId;
    dragStartX = clientX;
    dragStartY = clientY;
    dragLastX = clientX;
    dragAxis = null;
    if (openSwipeBillId !== null && openSwipeBillId !== billId) {
      swipeOffset = { ...swipeOffset, [openSwipeBillId]: 0 };
      openSwipeBillId = null;
    }
    const baseOffset = swipeOffset[billId] ?? 0;
    dragOffset = { ...dragOffset, [billId]: baseOffset };
    isDragging = { ...isDragging, [billId]: true };
  }

  function moveDrag(billId: number, clientX: number, clientY: number, e?: MouseEvent | TouchEvent) {
    if (dragBillId !== billId) return;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    if (dragAxis === null) {
      if (Math.abs(dx) < TAP_THRESHOLD && Math.abs(dy) < TAP_THRESHOLD) {
        return;
      }
      dragAxis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (dragAxis === 'h' && e && 'cancelable' in e && e.cancelable) {
        e.preventDefault();
      }
    }

    if (dragAxis === 'v') return;

    if (Math.abs(dx) < TAP_THRESHOLD && (swipeOffset[billId] ?? 0) === 0) {
      return;
    }

    dragLastX = clientX;

    let next = (swipeOffset[billId] ?? 0) + (clientX - dragStartX);
    if (next > 100) next = 100;
    if (next < -100) next = -100;

    dragOffset = { ...dragOffset, [billId]: next };
    dragOffset = dragOffset;
  }

  function endDrag(billId: number) {
    if (dragBillId !== billId) {
      return;
    }
    const finalOffset = dragOffset[billId] ?? 0;

    if (Math.abs(finalOffset) >= SWIPE_THRESHOLD) {
      const snap = finalOffset > 0 ? ACTION_WIDTH : -ACTION_WIDTH;
      swipeOffset = { ...swipeOffset, [billId]: snap };
      openSwipeBillId = billId;
    } else {
      swipeOffset = { ...swipeOffset, [billId]: 0 };
      if (openSwipeBillId === billId) openSwipeBillId = null;
    }

    isDragging = { ...isDragging, [billId]: false };
    dragOffset = { ...dragOffset, [billId]: 0 };
    dragBillId = null;
    dragAxis = null;
    dragStartX = 0;
    dragStartY = 0;
    dragLastX = 0;
  }

  function cancelDrag(billId: number) {
    if (dragBillId === billId) {
      swipeOffset = { ...swipeOffset, [billId]: 0 };
      isDragging = { ...isDragging, [billId]: false };
      dragOffset = { ...dragOffset, [billId]: 0 };
      dragBillId = null;
      dragAxis = null;
    }
  }

  function onTouchStart(billId: number, e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    startDrag(billId, t.clientX, t.clientY);
  }
  function onTouchMove(billId: number, e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    moveDrag(billId, t.clientX, t.clientY, e);
  }
  function onTouchEnd(billId: number, e: TouchEvent) {
    endDrag(billId);
  }
  function onTouchCancel(billId: number, e: TouchEvent) {
    cancelDrag(billId);
  }

  function onMouseDown(billId: number, e: MouseEvent) {
    if (e.button !== 0) return;
    startDrag(billId, e.clientX, e.clientY);
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    e.preventDefault();
  }
  function onWindowMouseMove(e: MouseEvent) {
    if (dragBillId === null) return;
    moveDrag(dragBillId, e.clientX, e.clientY, e);
  }
  function onWindowMouseUp(e: MouseEvent) {
    if (dragBillId === null) return;
    const id = dragBillId;
    endDrag(id);
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
  }

  function onRowTap(e: MouseEvent | TouchEvent) {
    if (openSwipeBillId !== null) {
      const target = e.target as HTMLElement;
      if (!target.closest('.bill-swipe-action')) {
        swipeOffset = { ...swipeOffset, [openSwipeBillId]: 0 };
        openSwipeBillId = null;
        e.preventDefault();
        e.stopPropagation();
          }
    }
  }

  async function onSwipeEdit(billId: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    swipeOffset = { ...swipeOffset, [billId]: 0 };
    if (openSwipeBillId === billId) openSwipeBillId = null;
    await tick();
    goto(`/sessions/${sessionId}/bills/${billId}/edit`);
  }
  async function onSwipeDelete(billId: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    swipeOffset = { ...swipeOffset, [billId]: 0 };
    if (openSwipeBillId === billId) openSwipeBillId = null;
    await tick();
    if (onDelete) {
      void onDelete(billId);
    }
  }

  function closeAllSwipes() {
    if (openSwipeBillId !== null) {
      swipeOffset = { ...swipeOffset, [openSwipeBillId]: 0 };
      openSwipeBillId = null;
    }
  }

  // ===== Storage: collapsed day groups =====
  function storageKey(): string {
    return `sbc.billGroupCollapsed.${sessionId}`;
  }

  function loadCollapsedState() {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(storageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        collapsed = { ...collapsed, ...parsed };
      }
    } catch {
      // ignore corrupt localStorage
    }
  }

  function saveCollapsedState() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(collapsed));
    } catch {
      // localStorage might be full or disabled; non-fatal
    }
  }

  function isOpen(date: string): boolean {
    return !collapsed[date];
  }

  function onGroupToggle(date: string, e: Event) {
    const el = e.currentTarget as HTMLDetailsElement;
    const isOpenNow = el.open;
    collapsed = { ...collapsed, [date]: !isOpenNow };
    saveCollapsedState();
  }

  onMount(() => {
    loadCollapsedState();
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.bill-swipe-wrap')) return;
      closeAllSwipes();
    };
    document.addEventListener('click', onDocClick);
    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
    };
  });
</script>

<div class="bill-grouped">
  {#if !bills || bills.length === 0}
    <p class="muted">
      还没有账单,<a href="/sessions/{sessionId}/bills/new">点"+ 新建账单"开始</a>。
    </p>
  {:else}
    <ul class="day-list" style="list-style: none; padding: 0; margin: 0;">
      {#each groups as g, gi (g.date)}
        <li class="day-group" in:fly={{ y: 8, duration: 220, delay: Math.min(gi * 40, 240) }}>
          <details open={isOpen(g.date)} on:toggle={(e) => onGroupToggle(g.date, e)}>
            <summary class="day-header">
              <span class="day-toggle" aria-hidden="true">{isOpen(g.date) ? '−' : '+'}</span>
              <div class="day-header-main">
                <span class="day-date">{g.date}</span>
                <span class="day-total">
                  {fmtAmount(g.total)}<span class="unit">{g.currency}</span>
                </span>
              </div>
              <div class="day-header-sub">
                <span class="muted">人均 {fmtAmount(g.perCapita)}{g.currency}</span>
                <span class="muted">总笔数 {g.bills.length}</span>
                <span class="muted day-header-tag">(合计)</span>
              </div>
            </summary>

            <!-- 反馈修 6 项目 3: 删 .day-bills padding + border-top,
                 bill row 直接贴在 day header 下,共享同一背景色 -->
            <ul class="day-bills">
              {#each g.bills as b, bi (b.id)}
                {@const share = yourShare(b)}
                <li
                  class="bill-swipe-wrap"
                  in:fly={{ y: 8, duration: 220, delay: Math.min(bi * 25, 200) }}
                >
                  {#if onDelete}
                    <button
                      type="button"
                      class="bill-swipe-action bill-swipe-action-right"
                      tabindex={swipeOffset[b.id] !== undefined && swipeOffset[b.id] < 0 ? 0 : -1}
                      aria-hidden={swipeOffset[b.id] === undefined || swipeOffset[b.id] >= 0}
                      aria-label="删除账单: {b.description || '(无说明)'}"
                      on:click={(e) => onSwipeDelete(b.id, e)}
                    >删除</button>
                  {/if}
                  <button
                    type="button"
                    class="bill-swipe-action bill-swipe-action-left"
                    tabindex={swipeOffset[b.id] !== undefined && swipeOffset[b.id] > 0 ? 0 : -1}
                    aria-hidden={swipeOffset[b.id] === undefined || swipeOffset[b.id] <= 0}
                    aria-label="编辑账单: {b.description || '(无说明)'}"
                    on:click={(e) => onSwipeEdit(b.id, e)}
                  >编辑</button>
                  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
                  <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
                  <!-- svelte-ignore a11y-no-static-element-interactions -->
                  <!-- svelte-ignore a11y-click-events-have-key-events -->
                  <div
                    class="bill-row"
                    class:swiping={!!isDragging[b.id]}
                    style="transform: translateX({isDragging[b.id] ? (dragOffset[b.id] ?? 0) : (swipeOffset[b.id] ?? 0)}px)"
                    role="group"
                    aria-label="账单: {b.description || '(无说明)'}"
                    on:touchstart={(e) => onTouchStart(b.id, e)}
                    on:touchmove={(e) => onTouchMove(b.id, e)}
                    on:touchend={(e) => onTouchEnd(b.id, e)}
                    on:touchcancel={(e) => onTouchCancel(b.id, e)}
                    on:mousedown={(e) => onMouseDown(b.id, e)}
                    on:click={onRowTap}
                  >
                    <div class="bill-row1">
                      <span class="bill-desc">{b.description || '(无说明)'}</span>
                      <span class="bill-amount">
                        {fmtAmount(b.amount)}<span class="unit">{b.currency}</span>
                      </span>
                    </div>
                    <div class="bill-row2 muted">
                      <span class="bill-meta-line">
                        {fmtBillTime(b.occurred_at)} · {payerName(b)} 付 · {b.participants.length} 人均 {fmtAmount(b.amount / Math.max(1, b.participants.length))}{b.currency}
                      </span>
                      {#if share !== null}
                        <span class="your-share">分摊 {fmtAmount(share)}<span class="unit">{b.currency}</span></span>
                      {/if}
                    </div>
                  </div>
                </li>
              {/each}
            </ul>
          </details>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .day-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .day-group {
    /* 反馈修 6 项目 3: day group 用 surface 背景,bill row 默认透明继承,
       共享同一背景色,消除原灰色边框的"两层卡片"视觉 */
    border: 1px solid var(--color-border);
    border-radius: var(--radius, 8px);
    overflow: hidden;
    background: var(--color-surface, #fff);
  }
  .day-group details {
    width: 100%;
  }

  /* === day header 排版 === */
  .day-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
    list-style: none;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface, #fff);
    min-height: var(--touch-target, 44px);
    flex-wrap: wrap;
    position: relative;
  }
  .day-header::-webkit-details-marker {
    display: none;
  }
  .day-header:focus-visible {
    outline: 2px solid var(--color-accent, #3b82f6);
    outline-offset: -2px;
  }
  .day-toggle {
    position: absolute;
    top: var(--space-2);
    left: var(--space-2);
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    color: var(--color-text-muted, #666);
    line-height: 1;
    font-weight: 400;
  }
  .day-header-main,
  .day-header-sub {
    padding-left: 28px;
  }
  .day-header-main {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .day-header-sub {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: var(--font-size-sm, 13px);
  }
  .day-header-tag {
    color: var(--color-text-muted);
    opacity: 0.85;
  }
  .day-date {
    font-weight: 600;
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
  }
  .day-total {
    font-weight: 600;
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
    text-align: right;
    margin-left: auto;
  }
  .unit {
    font-size: 10px;
    font-weight: 400;
    margin-left: 2px;
    color: inherit;
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* === 反馈修 6 项目 3: day-bills 删 padding + border-top,
       bill row 直接贴在 day header 下 === */
  .day-bills {
    list-style: none;
    padding: 0;
    margin: 0;
    /* 删除 border-top + padding,bill row 跟 day header 同一容器背景色 */
  }

  /* === iOS Mail-style swipe wrapper & actions === */
  .bill-swipe-wrap {
    position: relative;
    overflow: hidden;
    border-bottom: 1px solid var(--color-border);
  }
  .bill-swipe-wrap:last-child {
    border-bottom: none;
  }

  .bill-swipe-action {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 600;
    font-size: var(--font-size-base);
    border: 0;
    cursor: pointer;
    z-index: 1;
    appearance: none;
    padding: 0;
    font-family: inherit;
    opacity: 0;
    transform: scale(0.85);
    transition: opacity 200ms ease, transform 200ms cubic-bezier(0.2, 0, 0, 1);
    pointer-events: none;
  }
  .bill-swipe-action[aria-hidden="false"] {
    opacity: 1;
    transform: scale(1);
    pointer-events: auto;
  }
  .bill-swipe-action-left {
    left: 0;
    background: var(--color-accent, #3b82f6);
  }
  .bill-swipe-action-left:hover {
    background: var(--color-accent-hover, #2563eb);
  }
  .bill-swipe-action-right {
    right: 0;
    background: var(--color-error, #dc2626);
  }
  .bill-swipe-action-right:hover {
    background: #b91c1c;
  }

  /* === 反馈修 6 项目 3: .bill-row 删独立 background,默认透明继承,
       跟 .day-group 共享同一 surface 背景色 === */
  .bill-row {
    position: relative;
    z-index: 2;
    /* 删除 background: var(--color-surface, #fff) — 让 day-group 背景透出 */
    padding: var(--space-3) var(--space-4);
    /* 删除 border-bottom (已移到 .bill-swipe-wrap,避免双层) */
    transition: transform 250ms cubic-bezier(0.2, 0, 0, 1), background-color 200ms ease;
    outline: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .bill-row.swiping {
    transition: none;
  }
  .bill-row:focus-visible {
    box-shadow: inset 2px 0 0 var(--color-accent, #3b82f6);
  }
  /* 触摸设备无 hover 反馈 (避免 :hover 误触) */
  @media (hover: hover) {
    .bill-row:hover {
      background: rgba(0, 0, 0, 0.035);
    }
  }

  .bill-row1 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .bill-desc {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .bill-amount {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 1rem;
    color: var(--color-text);
    white-space: nowrap;
  }

  .bill-row2 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: 2px;
    font-size: var(--font-size-sm);
  }
  .bill-meta-line {
    flex: 1 1 auto;
    min-width: 0;
  }
  .your-share {
    flex: 0 0 auto;
    font-weight: 600;
    color: var(--color-accent, #3b82f6);
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }
</style>