<script lang="ts">
  /**
   * v0.1.4 (2026-07-02) — bills grouped list polish。
   *
   * 本次 polish (v0.1.4):
   * - <details> 顺滑折叠动画: 包一层 .day-body-wrap + .day-body,用 grid-template-rows
   *   0fr ↔ 1fr 实现 250ms cubic-bezier 过渡。Chrome 117+/Safari 17.4+/Firefox 127+
   *   支持,老浏览器降级到 <details> 默认瞬时展开。
   * - share_amount 独立一行: .bill-row2 从 row 改 column 布局,让 share_amount
   *   从右侧变到下一行,与 meta 上下两行展示,避免元信息被挤压。
   *
   * 沿用 v0.1.3 Sprint 2:
   * - T6 千分位: 删除手写数字格式化,统一切到 $lib/utils/format.formatMoney。
   * - T7 折叠默认: 找 session 中**最新**的 occurred_at 日期作为「当天」,只有
   *   「当天」group 默认展开,其他全部默认折叠。用户手动 toggle 后用 localStorage
   *   记住。
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token。
   *
   * 沿用:
   * - v0.1.2 反馈修 6 项目 3 (Bill item 背景色统一)
   * - v0.1.2 反馈修 5 项目 4 (iOS Mail-style swipe)
   * - v0.1.2 反馈修 5 Commit 2 (bd0cf89) — bill item 重构 + swipe
   */
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { fly } from 'svelte/transition';
  import { formatMoney, formatDate } from '$lib/utils/format';
  import type { Bill } from '$api/bills';
  import SkeletonBill from './SkeletonBill.svelte';
  import CategoryIcon from './CategoryIcon.svelte';

  export let bills: Bill[];
  export let sessionId: number;
  export let memberIdToName: Record<number, string> = {};
  export let currentUserMemberId: number | null = null;
  export let onDelete: ((billId: number) => void | Promise<void>) | null = null;
  /** Sprint 3 T13: true 时显示 N 个 SkeletonBill 骨架 */
  export let loading: boolean = false;

  type Group = {
    date: string;
    bills: Bill[];
    total: number;
    currency: string;
    perCapita: number;
  };

  /**
   * T7 默认展开日期映射 (YYYY-MM-DD → bool)。`true` 表示默认展开 (open),
   * `false` 表示默认折叠 (closed)。在 onMount 内根据当前 bills 计算一次后
   * freeze,用户切 session / 重渲染不会重算。
   */
  let defaultOpenDates: Record<string, boolean> = {};

  /**
   * 用户手动 toggle 后的折叠状态。localStorage 也持久化这里。
   * key = date string, value = true (collapsed) | false (open)。
   */
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

  /**
   * T7: 计算「今天 (Asia/Shanghai 视角下 bills 最新发生的那天)」对应的 YYYY-MM-DD
   * bucket,其余 bucket 全部折叠。其他 bucket = `false` (closed)。
   * 返回值为 `Record<dateKey, isOpen>`。
   */
  function computeDefaultOpenDates(billList: Bill[]): Record<string, boolean> {
    if (!billList || billList.length === 0) return {};
    // 找 session 中**最新**的 occurred_at (max ISO)
    let maxIso = '';
    for (const b of billList) {
      if (b.occurred_at && b.occurred_at > maxIso) maxIso = b.occurred_at;
    }
    if (!maxIso) return {};
    const todayBucket = localDateKey(maxIso);
    const out: Record<string, boolean> = {};
    for (const g of buildGroups(billList)) {
      out[g.date] = g.date === todayBucket;
    }
    return out;
  }

  $: groups = buildGroups(bills);

  /** T6: 金额显示用 formatMoney,带千分位。 */
  function fmtAmount(n: number): string {
    return formatMoney(n, { showSymbol: false });
  }

  /** T6: 时间显示改用 formatDate({ time: true })。 */
  function fmtBillTime(iso: string): string {
    return formatDate(iso, { time: true });
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

  // ===== T7 Storage: collapsed day groups =====

  function storageKey(): string {
    return `sbc.billGroupCollapsed.${sessionId}`;
  }

  function loadCollapsedState(): Record<string, boolean> {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(storageKey());
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // ignore corrupt localStorage
    }
    return {};
  }

  function saveCollapsedState() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(collapsed));
    } catch {
      // localStorage might be full or disabled; non-fatal
    }
  }

  /**
   * T7: 解析「date 这天 group 是否应展开」。
   * 优先级: 用户在 collapsed 中**显式**设置的值 > 默认值。
   * collapsed[key] 未设置 → 用 defaultOpenDates[key] (onMount 已 freeze)。
   */
  function isOpen(date: string): boolean {
    if (date in collapsed) return !collapsed[date];
    return defaultOpenDates[date] ?? false;
  }

  function onGroupToggle(date: string, e: Event) {
    const el = e.currentTarget as HTMLDetailsElement;
    const isOpenNow = el.open;
    collapsed = { ...collapsed, [date]: !isOpenNow };
    saveCollapsedState();
  }

  onMount(() => {
    // T7: freeze defaultOpenDates(在 onMount 后不再重算,切 session 也不会动)。
    defaultOpenDates = computeDefaultOpenDates(bills);

    // 尝试加载用户已保存的 state。
    const saved = loadCollapsedState();
    const userTouched = Object.keys(saved).length > 0;

    if (userTouched) {
      // 用户手动 toggle 过 → localStorage 优先
      collapsed = { ...collapsed, ...saved };
    } else {
      // 从未手动折叠过 → 应用默认值 (only 今天展开, 其他折叠)
      collapsed = { ...defaultOpenDates };
      // 不写 localStorage,等用户真正 toggle 时再写。
    }

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
  {#if loading}
    <ul class="skeleton-list" aria-busy="true" aria-label="加载中">
      <li><SkeletonBill /></li>
      <li><SkeletonBill /></li>
      <li><SkeletonBill /></li>
    </ul>
  {:else if !bills || bills.length === 0}
    <p class="muted">
      还没有账单,<a href="/sessions/{sessionId}/bills/new">点"+ 新建账单"开始</a>。
    </p>
  {:else}
    <ul class="day-list" style="list-style: none; padding: 0; margin: 0;">
      {#each groups as g, gi (g.date)}
        <li class="day-group" in:fly={{ y: 8, duration: 220, delay: Math.min(gi * 40, 240) }}>
          <details open={isOpen(g.date)} on:toggle={(e) => onGroupToggle(g.date, e)}>
            <summary class="day-header section-header">
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

            <!-- v0.1.4: 折叠顺滑动画 (grid-template-rows 0fr ↔ 1fr)。
                 Chrome 117+ / Safari 17.4+ / Firefox 127+ 全部支持;
                 老浏览器降级到浏览器默认的瞬时展开 (已是 details 的默认行为) -->
            <div class="day-body-wrap">
              <div class="day-body">
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
                          <CategoryIcon description={b.description ?? ''} size={18} />
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
              </div>
            </div>
          </details>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .skeleton-list {
    list-style: none;
    padding: 0;
    margin: 0;
    background: white;
    border: 1px solid var(--gray-200);
    border-radius: var(--radius-md, 8px);
  }
  .skeleton-list > li:last-child :global(.skeleton-bill) {
    border-bottom: none;
  }
  .day-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .day-group {
    /* 反馈修 6 项目 3: day group 用 surface 背景,bill row 默认透明继承,
       共享同一背景色,消除原灰色边框的"两层卡片"视觉 */
    border: 1px solid var(--gray-200);
    border-radius: var(--radius-md, 8px);
    /* overflow:hidden removed: T10 sticky backdrop-blur needs visible overflow */
    background: white;
  }
  .day-group details {
    width: 100%;
  }

  /* === day header 排版 ===
     注: day-header 的 sticky / backdrop-blur 会在 Commit 2 (T10) 加,先保持纯白底。 */
  .day-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
    list-style: none;
    padding: var(--space-2) var(--space-3);
    background: white;
    min-height: var(--touch-target, 44px);
    flex-wrap: wrap;
    position: relative;
  }
  .day-header::-webkit-details-marker {
    display: none;
  }
  .day-header:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: -2px;
  }

  /* T10: Sticky section header with glassmorphism */
  .section-header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    border-bottom: 1px solid var(--gray-200);
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
    color: var(--gray-500);
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
    color: var(--gray-500);
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

  /* === v0.1.4 polish: <details> 顺滑折叠动画 (grid-template-rows 0fr ↔ 1fr)
     包装 day-bills 的两层 div: 外层做 grid 高度过渡,内层装内容做 overflow:hidden。
     Chrome 117+ / Safari 17.4+ / Firefox 127+ 全部支持;
     老浏览器降级到 <details> 默认的瞬时展开。 === */
  .day-body-wrap {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 250ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  details[open] .day-body-wrap {
    grid-template-rows: 1fr;
  }
  .day-body {
    overflow: hidden;
    min-height: 0;
  }

  /* === iOS Mail-style swipe wrapper & actions === */
  .bill-swipe-wrap {
    position: relative;
    overflow: hidden;
    border-bottom: 1px solid var(--gray-200);
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
    background: var(--accent-500);
  }
  .bill-swipe-action-left:hover {
    background: var(--accent-700);
  }
  .bill-swipe-action-right {
    right: 0;
    background: var(--error-500);
  }
  .bill-swipe-action-right:hover {
    background: var(--error-700);
  }

  /* === 反馈修 6 项目 3: .bill-row 删独立 background,默认透明继承,
       跟 .day-group 共享同一 surface 背景色 === */
  .bill-row {
    position: relative;
    z-index: 2;
    /* 删除 background: white — 让 day-group 背景透出 */
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
    box-shadow: inset 2px 0 0 var(--accent-500);
  }
  /* 触摸设备无 hover 反馈 (避免 :hover 误触) */
  @media (hover: hover) {
    .bill-row:hover {
      background: rgba(0, 0, 0, 0.035);
    }
  }

  .bill-row1 {
    display: flex;
    align-items: center;
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
    color: var(--gray-900);
    white-space: nowrap;
  }

  .bill-row2 {
    /* v0.1.4 polish: share_amount 独立新一行 — column 布局让 meta 在上、share 在下 */
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    margin-top: 2px;
    font-size: var(--font-size-sm);
  }
  .bill-meta-line {
    min-width: 0;
  }
  .your-share {
    font-weight: 600;
    color: var(--accent-500);
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }
</style>
