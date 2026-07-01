<script lang="ts">
  /**
   * v0.1.2 反馈修 5 (PO 2026-07-01 23:00 UX 改写) — bills grouped list,
   * Commit 2: 3+4+5 — Bill item 重构 + iOS Mail-style 滑动操作。
   *
   * 本 Commit 2 涉及:
   * - 项目 3 (Bill item 左右留出适当空间):
   *     .bill-row padding: var(--space-3) 0 → var(--space-3) 0 → 行内 wrap padding
   *     .day-bills 加 padding-left/right var(--space-3) (整组内缩)
   * - 项目 4 (「你分摊」→「分摊」): 更克制专业, 跟结算页「付款 / 消费 / 净」对应
   * - 项目 5 (iOS Mail-style 滑动操作 — 大改):
   *     - 删除: .bill-row on:click 跳编辑页
   *     - 删除: .bill-menu-btn + .bill-menu-popover
   *     - 删除: @media (min-width: 720px) inline delete button 兜底
   *     - 新增: 右滑 → 露出「编辑」(左,accent) | 左滑 → 露出「删除」(右,error)
   *     - 触摸 + mouse 双通道(codeserver Playwright 用 mouse 模拟)
   *     - 阈值 60-80px snap-open, 否则 snap-close
   *     - 拖动 | Δx| > |Δy| 时 preventDefault 阻止垂直滚动
   *     - tap 视为 < 10px 拖动, 走 click fallback (无 swipe open 时)
   *     - snap 250ms cubic-bezier(0.2, 0, 0, 1) 动画
   *     - 一次只能有一个 item open
   *     - tap 任意空白处 / tap 别的 bill row / 滑动另一个 item 时自动 close 已开的
   *
   * Commit 3 (项目 9): bill item mount 入场 in:fly={{ y: 8, duration: 200 }}
   *  - 列表初次 mount 时从下方 8px 滑入,200ms 完成,克制不花哨
   *
   * 历史: v0.1.2 反馈修5 Commit 1 (9ccebcc) — 文字+按钮位置调整已实施
   */
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { fly } from 'svelte/transition';
  import type { Bill } from '$api/bills';

  export let bills: Bill[];
  export let sessionId: number;
  /** map SessionMember.id -> display_name, used in the bill row meta. */
  export let memberIdToName: Record<number, string> = {};
  /** 当前登录人在此 session 内的 member_id。用于「分摊 X」高亮显示。 */
  export let currentUserMemberId: number | null = null;
  /** Called when the user confirms deletion of a bill. */
  export let onDelete: ((billId: number) => void | Promise<void>) | null = null;

  type Group = {
    date: string;
    bills: Bill[];
    total: number;
    currency: string;
    perCapita: number;
  };

  let collapsed: Record<string, boolean> = {};

  // === 项目 5: swipe state ===
  /** Per-bill real-time drag offset during a touch/mouse drag. */
  let dragOffset: Record<number, number> = {};
  /** Per-bill snap-open offset (after release, when commited as open). */
  let swipeOffset: Record<number, number> = {};
  /** Whether the row is currently being dragged (real-time, no transition). */
  let isDragging: Record<number, boolean> = {};
  /** Which bill is currently snap-open (one at a time). */
  let openSwipeBillId: number | null = null;

  // drag tracking (single active drag at a time)
  let dragBillId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragLastX = 0;
  let dragAxis: 'h' | 'v' | null = null; // 'h'=horizontal swipe, 'v'=vertical scroll

  const ACTION_WIDTH = 80;     // 露出 action button 的宽度
  const SWIPE_THRESHOLD = 60;  // 触发 snap-open 的阈值
  const TAP_THRESHOLD = 10;    // < 10px 视为 tap,不进入 swipe

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

  // ===== 项目 5: iOS Mail-style swipe logic =====

  /**
   * Resolve the current visual offset for a bill row:
   *  - if currently being dragged → real-time `dragOffset`
   *  - else if snap-open → `swipeOffset` (capped at ±ACTION_WIDTH)
   *  - else → 0
   */
  function getRowOffset(billId: number): number {
    if (isDragging[billId]) return dragOffset[billId] ?? 0;
    return swipeOffset[billId] ?? 0;
  }

  /** Cap a raw offset to ±ACTION_WIDTH for snap-open state. */
  function clampOffset(n: number): number {
    if (n > ACTION_WIDTH) return ACTION_WIDTH;
    if (n < -ACTION_WIDTH) return -ACTION_WIDTH;
    return n;
  }

  /** Initialize a drag (touchstart or mousedown). */
  function startDrag(billId: number, clientX: number, clientY: number) {
    dragBillId = billId;
    dragStartX = clientX;
    dragStartY = clientY;
    dragLastX = clientX;
    dragAxis = null;
    // If another bill is open, close it immediately on drag start of any bill
    if (openSwipeBillId !== null && openSwipeBillId !== billId) {
      swipeOffset = { ...swipeOffset, [openSwipeBillId]: 0 };
      openSwipeBillId = null;
    }
    // The drag offset starts from the snap-open offset (continue from open)
    const baseOffset = swipeOffset[billId] ?? 0;
    dragOffset = { ...dragOffset, [billId]: baseOffset };
    // Real-time drag flag
    isDragging = { ...isDragging, [billId]: true };
  }

  /** Update during drag (touchmove or mousemove). */
  function moveDrag(billId: number, clientX: number, clientY: number, e?: MouseEvent | TouchEvent) {
    if (dragBillId !== billId) return;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    // Determine axis on first significant movement
    if (dragAxis === null) {
      if (Math.abs(dx) < TAP_THRESHOLD && Math.abs(dy) < TAP_THRESHOLD) {
        return; // too small, still ambiguous
      }
      dragAxis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      // On horizontal swipe, preventDefault to stop vertical scroll (touch)
      if (dragAxis === 'h' && e && 'cancelable' in e && e.cancelable) {
        e.preventDefault();
      }
    }

    // 误触防护: vertical scroll 优先 — 当轴已确定是 vertical,不要翻译成 swipe
    if (dragAxis === 'v') return;

    // 拖动距离 < TAP_THRESHOLD 时视为 tap,不进入 swipe state
    if (Math.abs(dx) < TAP_THRESHOLD && (swipeOffset[billId] ?? 0) === 0) {
      return;
    }

    dragLastX = clientX;

    // Real-time visual: clamp to [-ACTION_WIDTH - 60px overshoot, +ACTION_WIDTH + 60px]
    // Allow small overshoot for elasticity; cap at ±100 visually.
    let next = (swipeOffset[billId] ?? 0) + dx - (dragOffset[billId] ?? 0) + (dragOffset[billId] ?? 0);
    // Simpler: cumulative visual position from start (so users can drag back closed)
    next = (swipeOffset[billId] ?? 0) + (clientX - dragStartX);

    // Allow overshoot up to ±100px for elasticity feel
    if (next > 100) next = 100;
    if (next < -100) next = -100;
    // But cap snap-open (which we'll compute on end) to ±ACTION_WIDTH

    dragOffset = { ...dragOffset, [billId]: next };
    // Force reactivity — touchend will read this
    dragOffset = dragOffset;
  }

  /** End drag (touchend / mouseup). Snap-open or snap-close. */
  function endDrag(billId: number) {
    if (dragBillId !== billId) {
      // No drag in progress or different bill
      return;
    }
    const finalOffset = dragOffset[billId] ?? 0;

    if (Math.abs(finalOffset) >= SWIPE_THRESHOLD) {
      // Snap-open — cap to ±ACTION_WIDTH
      const snap = finalOffset > 0 ? ACTION_WIDTH : -ACTION_WIDTH;
      swipeOffset = { ...swipeOffset, [billId]: snap };
      openSwipeBillId = billId;
    } else {
      // Snap-close
      swipeOffset = { ...swipeOffset, [billId]: 0 };
      if (openSwipeBillId === billId) openSwipeBillId = null;
    }

    // Reset drag state
    isDragging = { ...isDragging, [billId]: false };
    dragOffset = { ...dragOffset, [billId]: 0 };
    dragBillId = null;
    dragAxis = null;
    dragStartX = 0;
    dragStartY = 0;
    dragLastX = 0;
  }

  /** Cancel drag (e.g., touch cancel). */
  function cancelDrag(billId: number) {
    if (dragBillId === billId) {
      swipeOffset = { ...swipeOffset, [billId]: 0 };
      isDragging = { ...isDragging, [billId]: false };
      dragOffset = { ...dragOffset, [billId]: 0 };
      dragBillId = null;
      dragAxis = null;
    }
  }

  // Touch event handlers
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
    // touchend has no touches[0] — use changedTouches
    endDrag(billId);
  }
  function onTouchCancel(billId: number, e: TouchEvent) {
    cancelDrag(billId);
  }

  // Mouse event handlers (mirror for desktop / Playwright test)
  function onMouseDown(billId: number, e: MouseEvent) {
    // Only respond to primary button
    if (e.button !== 0) return;
    startDrag(billId, e.clientX, e.clientY);
    // Capture for mousemove/up outside the row
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    // Prevent text selection during drag
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

  // Tap on row (no drag) — close any open swipe, or do nothing if already closed.
  // We intentionally do NOT auto-open edit on tap; the row itself is no longer
  // "clickable to open edit" — user must swipe-right to reveal "编辑", or
  // swipe-left to reveal "删除". Tap simply closes an open swipe.
  function onRowTap(e: MouseEvent | TouchEvent) {
    // If a swipe was in progress and ended as tap, do nothing special
    if (openSwipeBillId !== null) {
      const target = e.target as HTMLElement;
      // If tap landed on the row content (not action button), close it
      if (!target.closest('.bill-swipe-action')) {
        swipeOffset = { ...swipeOffset, [openSwipeBillId]: 0 };
        openSwipeBillId = null;
        e.preventDefault();
        e.stopPropagation();
          }
    }
  }

  // Click on action button
  async function onSwipeEdit(billId: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Close swipe first
    swipeOffset = { ...swipeOffset, [billId]: 0 };
    if (openSwipeBillId === billId) openSwipeBillId = null;
    await tick();
    goto(`/sessions/${sessionId}/bills/${billId}/edit`);
  }
  async function onSwipeDelete(billId: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Close swipe first
    swipeOffset = { ...swipeOffset, [billId]: 0 };
    if (openSwipeBillId === billId) openSwipeBillId = null;
    await tick();
    if (onDelete) {
      // onDelete is async; intentionally not awaited.
      void onDelete(billId);
    }
  }

  /** Close any open swipe (used by outside-click handler). */
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
    // outside-click 关闭 swipe
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.bill-swipe-wrap')) return; // 点击 row 内 → 由 row 自己处理
      closeAllSwipes();
    };
    // Use capture: false, but a slight delay to avoid race with row tap
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
      {#each groups as g (g.date)}
        <li class="day-group">
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

            <!-- 项目 3: day-bills 加 padding-inline, 整个 day group 内缩,bill row 不贴边缘 -->
            <ul class="day-bills">
              {#each g.bills as b (b.id)}
                {@const share = yourShare(b)}
                <!-- reactivity fix: 内联表达式让 Svelte 5 tracked; @const 不 reassign each 可缓存 -->
                <li class="bill-swipe-wrap" in:fly={{ y: 8, duration: 200 }}>
                  {#if onDelete}
                    <!-- 左滑 → 露出 删除 (右边, 红色) -->
                    <button
                      type="button"
                      class="bill-swipe-action bill-swipe-action-right"
                      tabindex={swipeOffset[b.id] !== undefined && swipeOffset[b.id] < 0 ? 0 : -1}
                      aria-hidden={swipeOffset[b.id] === undefined || swipeOffset[b.id] >= 0}
                      aria-label="删除账单: {b.description || '(无说明)'}"
                      on:click={(e) => onSwipeDelete(b.id, e)}
                    >删除</button>
                  {/if}
                  <!-- 右滑 → 露出 编辑 (左边, 蓝色) -->
                  <button
                    type="button"
                    class="bill-swipe-action bill-swipe-action-left"
                    tabindex={swipeOffset[b.id] !== undefined && swipeOffset[b.id] > 0 ? 0 : -1}
                    aria-hidden={swipeOffset[b.id] === undefined || swipeOffset[b.id] <= 0}
                    aria-label="编辑账单: {b.description || '(无说明)'}"
                    on:click={(e) => onSwipeEdit(b.id, e)}
                  >编辑</button>
                  <!-- 项目 5: bill-row 是 swipe 表面,不是传统 button — 用 svelte-ignore 抑制 a11y 警告 -->
                  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
                  <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
                  <!-- svelte-ignore a11y-no-static-element-interactions -->
                  <!-- svelte-ignore a11y-click-events-have-key-events -->
                  <!-- reactivity fix: 内联表达式 — Svelte 5 tracks these direct reads; 不依赖 @const 缓存 -->
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
                    <!-- row1 - description + 金额 -->
                    <div class="bill-row1">
                      <span class="bill-desc">{b.description || '(无说明)'}</span>
                      <span class="bill-amount">
                        {fmtAmount(b.amount)}<span class="unit">{b.currency}</span>
                      </span>
                    </div>
                    <!-- row2 - 时间·付款人·人均 muted + 右侧 分摊 X (accent) -->
                    <div class="bill-row2 muted">
                      <span class="bill-meta-line">
                        {fmtBillTime(b.occurred_at)} · {payerName(b)} 付 · {b.participants.length} 人均 {fmtAmount(b.amount / Math.max(1, b.participants.length))}{b.currency}
                      </span>
                      {#if share !== null}
                        <!-- 项目 4: 你分摊 X → 分摊 X (PO: 简洁专业)
                             注释: 「PO 反馈修 5: 原「你分摊」非常不专业, 改为「分摊」更克制, 跟结算页「付款 / 消费 / 净」对应」 -->
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
    border: 1px solid var(--color-border);
    border-radius: var(--radius, 8px);
    overflow: hidden;
    background: var(--color-bg, #fff);
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

  /* === 项目 3: day-bills 加 padding-inline → 整个 group 内缩 === */
  .day-bills {
    list-style: none;
    padding: 0 var(--space-3);
    margin: 0;
    border-top: 1px solid var(--color-border);
  }

  /* === 项目 5: iOS Mail-style swipe wrapper & actions === */
  .bill-swipe-wrap {
    position: relative;
    overflow: hidden;
    /* 关键: 默认隐藏 action buttons 的 tabindex/aria,只在 snap-open 时启用 */
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
    /* Avoid default button styles */
    appearance: none;
    padding: 0;
    font-family: inherit;
    /* Action buttons reveal animation */
    opacity: 0;
    transform: scale(0.85);
    transition: opacity 200ms ease, transform 200ms cubic-bezier(0.2, 0, 0, 1);
    pointer-events: none;
  }
  /* 项目 5: 当 .bill-swipe-action[aria-hidden="false"] 时,action 露出 (opacity 1, scale 1)
   * 配合 aria-hidden flip 控制可访问性 + 视觉动画 */
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
    background: #b91c1c; /* darker error */
  }

  /* === 项目 3+5: bill-row (with swipe transform) === */
  .bill-row {
    position: relative;
    z-index: 2;
    background: var(--color-surface, #fff);
    padding: var(--space-3) var(--space-4);  /* 项目 3: 左右 16px */
    border-bottom: 1px solid var(--color-border);
    transition: transform 250ms cubic-bezier(0.2, 0, 0, 1);  /* snap animation */
    outline: none;
    user-select: none;
    -webkit-user-select: none;
    /* 不再 cursor: pointer — 编辑入口是右滑,不是 click */
  }
  .bill-row:last-child {
    border-bottom: none;
  }
  /* 项目 5: 拖动期间禁用 transition (实时跟随手指) */
  .bill-row.swiping {
    transition: none;
  }
  .bill-row:focus-visible {
    box-shadow: inset 2px 0 0 var(--color-accent, #3b82f6);
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
  /* 项目 4: 分摊 X */
  .your-share {
    flex: 0 0 auto;
    font-weight: 600;
    color: var(--color-accent, #3b82f6);
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }
</style>
