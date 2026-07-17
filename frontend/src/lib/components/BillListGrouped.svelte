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
  import { writable, get, type Writable } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { fly, fade } from "svelte/transition";
  import { Pencil, Trash2 } from 'lucide-svelte';
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
    /** v0.3.1: per-currency totals (multi-currency aware). */
    currencyTotals: { ccy: string; amount: number }[];
    /** v0.3.1: formatted display string. Single-currency: "810.00 CNY";
     *  multi-currency: "810.00 CNY + 3,000.00 THB". */
    totalDisplay: string;
    /** v0.3.1: single currency code if all bills share one, else null. */
    singleCurrency: string | null;
    /** v0.3.1: per-currency per-capita (sum of b.amount/n grouped by currency). */
    perCapitaBreakdown: { ccy: string; amount: number }[];
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

  // v0.3.16 #13 (PO msg 23:56 续): swipe 相关 state 必须改 Svelte 5 runes $state()
  // 才能让 {@const leftProgress/rightProgress} 的 derived 重算 — 否则 plain let
  // 在 Svelte 5 legacy 编译下没自动包 mutable_source, getRowOffset() 读这些 state
  // 时被 $.untrack() 包, derived 不重算, --swipe-clip-* CSS var 永远是 0, clip-path
  // 永远 inset(0px), 按钮永远不出。
  //
  // ⚠️ 但 $state() 不能用在 legacy 模式组件里 (会触发 auto-detection 进 runes mode,
  // 然后 export let 全报错); 所以这 4 个 state 改用 writable store — 同样的
  // reactivity, 不需要迁整个组件到 runes mode。其他 state (defaultOpenDates,
  // collapsed) 不动 — 它们不影响 swipe 动画。
  const dragOffsetStore: Writable<Record<number, number>> = writable({});
  const swipeOffsetStore: Writable<Record<number, number>> = writable({});
  const isDraggingStore: Writable<Record<number, boolean>> = writable({});
  const openSwipeBillIdStore: Writable<number | null> = writable(null);

  // dragBillId/dragStartX/dragStartY/dragLastX/dragAxis 只在 event handler 用,
  // 不进 template 表达式, plain let 即可 (不需要 reactivity)。
  let dragBillId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragLastX = 0;
  let dragAxis: 'h' | 'v' | null = null;

  // v0.3.17 #18 hotfix (PO msg 06:18): 编辑/删除按钮改圆形 (从 64px 胶囊 → 56px 真圆)
  // 56 是圆形按钮直径 — Apple HIG 触摸目标 ≥ 44pt, 56 同时跟 row 高 (60-80px) 视觉协调,
  // 不会因 width > height 而退化成竖椭圆 (如果 button height 固定, width 必须 <= height)。
  const ACTION_WIDTH = 56;
  const SWIPE_THRESHOLD = 60;
  const TAP_THRESHOLD = 10;

  /**
   * v0.3.17 #21 (PO msg 13:51): drag rubber band spring damping。
   * drag 0~56px (ACTION_WIDTH): linear progress 0→1
   * drag 56~∞: spring damping
   *   formula: 1 + (1 - exp(-overshoot / 30)) * 0.5
   *   overshoot=20 → 1.245, overshoot=60 → 1.43, overshoot=200 → 1.499
   *   (永远不到 2 — iOS Mail 弹簧拉伸同款)
   *
   * 输入 rowOffset 可正可负, 函数取绝对值计算 progress (≥ 0)。
   * 按钮 width = progress × ACTION_WIDTH, aspect-ratio:1 让 height = width,
   * progress > 1 时是放大的圆形, 而非椭圆 (跟 #18/#19 aspect-ratio:1 配套)。
   */
  function rubberBandProgress(rowOffset: number): number {
    const abs = Math.abs(rowOffset);
    if (abs <= ACTION_WIDTH) return abs / ACTION_WIDTH;
    const overshoot = abs - ACTION_WIDTH;
    return 1 + (1 - Math.exp(-overshoot / 30)) * 0.5;
  }

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

  /**
   * v0.3.1: per-currency per-capita. Sums (b.amount / n) grouped by currency
   * so a multi-currency day's per-capita is shown as e.g. "136 CNY + 1000 THB"
   * (not a naive cross-currency sum).
   */
  function computePerCapitaBreakdown(groupBills: Bill[]): { ccy: string; amount: number }[] {
    const byCcy = new Map<string, number>();
    for (const b of groupBills) {
      const n = b.participants?.length ?? 0;
      if (n > 0) {
        byCcy.set(b.currency, (byCcy.get(b.currency) ?? 0) + b.amount / n);
      }
    }
    return [...byCcy.entries()].map(([ccy, amount]) => ({ ccy, amount }));
  }

  function fmtBreakdown(parts: { ccy: string; amount: number }[]): string {
    return parts
      .map(p => fmtAmount(p.amount) + ' ' + p.ccy)
      .join(' + ');
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
      // v0.3.1: per-currency aggregation (was naive sum across currencies).
      const byCcy = new Map<string, number>();
      for (const b of sorted) {
        byCcy.set(b.currency, (byCcy.get(b.currency) ?? 0) + b.amount);
      }
      const currencyTotals = [...byCcy.entries()]
        .map(([ccy, amount]) => ({ ccy, amount }))
        .sort((a, b) => a.ccy.localeCompare(b.ccy));
      const perCapitaBreakdown = computePerCapitaBreakdown(sorted)
        .sort((a, b) => a.ccy.localeCompare(b.ccy));
      out.push({
        date,
        bills: sorted,
        currencyTotals,
        totalDisplay: fmtBreakdown(currencyTotals),
        singleCurrency: currencyTotals.length === 1 ? currencyTotals[0].ccy : null,
        perCapitaBreakdown,
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
    const dragging = get(isDraggingStore)[billId];
    const dragVal = get(dragOffsetStore)[billId] ?? 0;
    const swipeVal = get(swipeOffsetStore)[billId] ?? 0;
    return dragging ? dragVal : swipeVal;
  }

  function startDrag(billId: number, clientX: number, clientY: number) {
    dragBillId = billId;
    dragStartX = clientX;
    dragStartY = clientY;
    dragLastX = clientX;
    dragAxis = null;
    const curOpen = get(openSwipeBillIdStore);
    if (curOpen !== null && curOpen !== billId) {
      swipeOffsetStore.update((o) => ({ ...o, [curOpen]: 0 }));
      openSwipeBillIdStore.set(null);
    }
    const baseOffset = get(swipeOffsetStore)[billId] ?? 0;
    dragOffsetStore.update((o) => ({ ...o, [billId]: baseOffset }));
    isDraggingStore.update((o) => ({ ...o, [billId]: true }));
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

    if (Math.abs(dx) < TAP_THRESHOLD && (get(swipeOffsetStore)[billId] ?? 0) === 0) {
      return;
    }

    dragLastX = clientX;

    // v0.3.17 #21 (PO msg 13:51): 取消硬 clamp 到 ±100, 改为 ±300。
      // 物理上限 300 让 rubber band spring damping 接管 visual 拉伸:
      // drag 0~56px: progress linear 0→1
      // drag 56~∞: progress 用 spring damping 1→1.5 (永远不到 2)
      //   formula: 1 + (1 - exp(-overshoot/30)) * 0.5
      //   overshoot=20 → 1.245, overshoot=60 → 1.43, overshoot=200 → 1.50
      // 按钮 width = progress × 56 → 满显后继续延伸但 spring 阻尼,
      // aspect-ratio:1 让 height 同步 width → 大圆形 (iOS Mail 同款)
      let next = (get(swipeOffsetStore)[billId] ?? 0) + (clientX - dragStartX);
      if (next > 300) next = 300;
      if (next < -300) next = -300;

    dragOffsetStore.update((o) => ({ ...o, [billId]: next }));
  }

  function endDrag(billId: number) {
    if (dragBillId !== billId) {
      return;
    }
    const finalOffset = get(dragOffsetStore)[billId] ?? 0;

    if (Math.abs(finalOffset) >= SWIPE_THRESHOLD) {
      const snap = finalOffset > 0 ? ACTION_WIDTH : -ACTION_WIDTH;
      swipeOffsetStore.update((o) => ({ ...o, [billId]: snap }));
      openSwipeBillIdStore.set(billId);
    } else {
      swipeOffsetStore.update((o) => ({ ...o, [billId]: 0 }));
      if (get(openSwipeBillIdStore) === billId) openSwipeBillIdStore.set(null);
    }

    isDraggingStore.update((o) => ({ ...o, [billId]: false }));
    dragOffsetStore.update((o) => ({ ...o, [billId]: 0 }));
    dragBillId = null;
    dragAxis = null;
    dragStartX = 0;
    dragStartY = 0;
    dragLastX = 0;
  }

  function cancelDrag(billId: number) {
    if (dragBillId === billId) {
      swipeOffsetStore.update((o) => ({ ...o, [billId]: 0 }));
      isDraggingStore.update((o) => ({ ...o, [billId]: false }));
      dragOffsetStore.update((o) => ({ ...o, [billId]: 0 }));
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
    const curOpen = get(openSwipeBillIdStore);
    if (curOpen !== null) {
      const target = e.target as HTMLElement;
      if (!target.closest('.bill-swipe-action')) {
        swipeOffsetStore.update((o) => ({ ...o, [curOpen]: 0 }));
        openSwipeBillIdStore.set(null);
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }

  async function onSwipeEdit(billId: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    swipeOffsetStore.update((o) => ({ ...o, [billId]: 0 }));
    if (get(openSwipeBillIdStore) === billId) openSwipeBillIdStore.set(null);
    await tick();
    goto(`/sessions/${sessionId}/bills/${billId}/edit`);
  }
  async function onSwipeDelete(billId: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    swipeOffsetStore.update((o) => ({ ...o, [billId]: 0 }));
    if (get(openSwipeBillIdStore) === billId) openSwipeBillIdStore.set(null);
    await tick();
    if (onDelete) {
      void onDelete(billId);
    }
  }

  function closeAllSwipes() {
    const curOpen = get(openSwipeBillIdStore);
    if (curOpen !== null) {
      swipeOffsetStore.update((o) => ({ ...o, [curOpen]: 0 }));
      openSwipeBillIdStore.set(null);
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
                <span class="day-total" data-testid="day-total">
                  {g.totalDisplay}
                </span>
              </div>
              <div class="day-header-sub">
                <span class="muted">人均 {fmtBreakdown(g.perCapitaBreakdown)}</span>
                <span class="muted">总笔数 {g.bills.length}</span>
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
                    <!-- v0.3.16 #11 (PO msg 21:07): swipe 动画重做 — bill info 不动,
                         按钮随 --swipe-progress 从 0 → 80px clip-path 展开 -->
                    <!-- v0.3.16 #13 (PO msg 23:56 续): 改用 $store auto-subscription
                         直接读 store 值, 让 derived 重算。Svelte 5 legacy 模式组件
                         里 $state() 不可用, 用 writable<>() 替代。 -->
                    {@const rowOffset = $isDraggingStore[b.id] ? ($dragOffsetStore[b.id] ?? 0) : ($swipeOffsetStore[b.id] ?? 0)}
                    <!-- v0.3.17 #21 (PO msg 13:51): drag rubber band spring damping。
                         drag 0~56px: progress linear 0→1 (按钮正常显形)
                         drag 56~∞: progress = 1 + (1 - exp(-overshoot/30)) * 0.5
                                    (1→1.5, 永远到不了 2 — iOS Mail 同款 spring 拉伸)
                         按钮 width = progress × 56, aspect-ratio:1 → height 跟 width,
                         满显后延伸但 spring 阻尼, 不会出现「物理不可能的 56xN 椭圆」。
                         snap 阈值仍是 SWIPE_THRESHOLD=60: drag ≥ 60 松手 → snap 到 ±56
                         (按钮停留满显状态), drag < 60 松手 → spring 回弹到 0。
                         v0.3.17 #23 hotfix (PO msg 16:32 #3, 修 #22 #22.1 rubberBand abs() bug):
                         rubberBandProgress 内部用 Math.abs(rowOffset), 所以
                         leftProgress(rowOffset) === rightProgress(-rowOffset),
                         左滑时 leftProgress ≈ rightProgress ≈ 1.43, 两个按钮同时显
                         (紫编辑 + 红删除), 用户体验混乱。
                         修法: caller 加 sign gate — 左滑 (rowOffset<0) 只让
                         rightProgress>0 (红删除按钮在右边缘显), 右滑 (rowOffset>0)
                         只让 leftProgress>0 (紫编辑按钮在左边缘显)。函数本身保持
                         abs-based 行为不变 (single source of truth), 语义 gate 放
                         caller 端, 反 #121/#125 边界。 -->
                    {@const leftProgress = rowOffset > 0 ? rubberBandProgress(rowOffset) : 0}
                    {@const rightProgress = rowOffset < 0 ? rubberBandProgress(-rowOffset) : 0}
<!-- v0.3.17 #20 hotfix (PO msg 13:12): 取消 stagger in:fly,
                         改 in:fade 80ms — toggle 展开时所有 row 同步淡入,
                         30 行不再逐行 delay 200ms, 不再「卡卡的」。
                         首次加载由 day-body-wrap grid-template-rows 250ms 接管
                         整体展开动画。 -->
                    <li
                      class="bill-swipe-wrap"
                      in:fade={{ duration: 80 }}
                    >
                      {#if onDelete}
                        <button
                          type="button"
                          class="bill-swipe-action bill-swipe-action-right glass-pill glass-pill--delete"
                          style="--swipe-progress: {rightProgress}"
                          tabindex={rightProgress >= 1 ? 0 : -1}
                          aria-hidden={rightProgress <= 0}
                          aria-label="删除账单 (圆形按钮): {b.description || '(无说明)'}"
                          on:click={(e) => onSwipeDelete(b.id, e)}
                        >
                          <!-- v0.3.17 #18 hotfix (PO msg 06:18): 圆形 icon-only 按钮。
                               size 14→22: 圆形按钮直径 56px, icon 14 在圆里偏小不协调,
                               22 视觉占圆形约 40%, 跟全站 landing/settle 大圆形 FAB 同语言。
                               删文字「删除」: 圆形 + 2 字塞不下 (iOS Mail 也是 icon-only 圆)。
                               aria-label 屏幕阅读器仍告知 "删除账单", 视觉只是 icon。 -->
                          <Trash2 size={22} strokeWidth={2} aria-hidden="true" />
                        </button>
                      {/if}
                      <button
                        type="button"
                        class="bill-swipe-action bill-swipe-action-left glass-pill glass-pill--edit"
                        style="--swipe-progress: {leftProgress}"
                        tabindex={leftProgress >= 1 ? 0 : -1}
                        aria-hidden={leftProgress <= 0}
                        aria-label="编辑账单 (圆形按钮): {b.description || '(无说明)'}"
                        on:click={(e) => onSwipeEdit(b.id, e)}
                      >
                          <Pencil size={22} strokeWidth={2} aria-hidden="true" />
                      </button>
                      <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
                      <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
                      <!-- svelte-ignore a11y-no-static-element-interactions -->
                      <!-- svelte-ignore a11y-click-events-have-key-events -->
                      <!-- v0.3.16 #12 (PO msg 23:56): 前景层永远原位, 加 clip-path 让按钮露出来。
                           86 = 80(button width) + 6(edge offset) -->
                      <div
                        class="bill-row bill-info-layer"
                        style="--swipe-clip-left: {leftProgress}; --swipe-clip-right: {rightProgress};"
                        class:swiping={!!$isDraggingStore[b.id]}
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
                            <span class="bill-participants" aria-label="参与人数 {b.participants.length}">
                              <svg
                                viewBox="0 0 24 24"
                                width="14"
                                height="14"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.75"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                                <circle cx="9" cy="7" r="4" />
                                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                              </svg>
                              <span>{b.participants.length}人</span>
                            </span>
                            <span class="bill-meta-text">{fmtBillTime(b.occurred_at)} · {payerName(b)} 付</span>
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
    border-radius: var(--radius-md);
    background: transparent;
  }
  .bill-swipe-wrap:last-child {
    border-bottom: none;
  }

  /* v0.3.17 #18 hotfix (PO msg 06:18): 编辑/删除按钮从 64px 横长胶囊 → 56px 真圆 icon-only
     PO 06:18 反馈 #17 「编辑删除按钮要圆形的」— 上一版 border-radius: 999px + 64px 宽
     = 横长椭圆胶囊, 不像圆。这次:
     - border-radius: 50% (真圆, 不是 999px 椭圆胶囊)
     - 直径 56px (Apple HIG 触摸目标 ≥ 44pt; 56 也跟 row 高度 60-80px 视觉协调)
     - 删「删除/编辑」文字, 只保留 Lucide icon (Trash2/Pencil) size 14→22
       (圆形 + 2 字塞不下, iOS Mail 也都是 icon-only 圆)
     - width 公式 64px→56px, height 公式不变 (仍 top:6 bottom:6 = 高度跟 row 走)
       物理约束: progress<1 时 width<height → 视觉上是竖椭圆 (iOS Mail 同款,
       物理不可避免, 见完成消息)
     - 基类 .glass-pill 的玻璃背景/边框/blur 全部保留 (跟全站其它玻璃按钮同语�      ��),
       只把 border-radius 改 50% + 删 padding (圆里没文字不需内边距)
     - 基类不重复定义 — 继承 app.css .glass-pill 的 0.10/0.08 玻璃 + accent-700 字
     - --delete / --edit 玻璃色 modifier 同 #17, 不重调 */
  /* 基类不重写 — 继承 app.css .glass-pill (已在 .btn.glass-pill / button.glass-pill
     复合选择子下 specificity bump 到 0,2,0, 盖过 .btn.primary 0,1,1)
     v0.3.17 #17 hotfix 之前这里有 5 行重复定义 glass-pill 同款属性, 全删 —
     specificity 已够, 重复定义只会在改 app.css 时脱节。*/

  /* 语义色 modifier: 红色玻璃 (用于删除)
     思路跟全站 .glass-pill 同级, 但用红玻璃渐变 (红 0.10 → 0.08) + 红字
     (var(--error-700, #be123c))。保留 backdrop blur + pill + inset shadow。*/
  .bill-swipe-action.glass-pill.glass-pill--delete {
    background: linear-gradient(
      135deg,
      rgba(220, 38, 38, 0.10) 0%,
      rgba(239, 68, 68, 0.08) 100%
    );
    border-color: rgba(220, 38, 38, 0.22);
    color: var(--error-700, #be123c);
  }
  .bill-swipe-action.glass-pill.glass-pill--delete:hover {
    background: linear-gradient(
      135deg,
      rgba(220, 38, 38, 0.18) 0%,
      rgba(239, 68, 68, 0.15) 100%
    );
    border-color: rgba(220, 38, 38, 0.30);
    color: #9f1239; /* rose-800 — 比 --error-700 更深, 跟全站 .glass-pill:hover
                      color: var(--accent-800, #3730a3) 同样的"加深一档"模式 */
  }

  /* 语义色 modifier: 蓝紫玻璃 (用于编辑) — 跟基类 .glass-pill 同色,
     但 --edit 显式覆盖一次以保持语义可读性 (跟 --delete 对称)
     v0.3.17 #17 hotfix 之前是 0.92 实色, 跟全站调色板完全脱节, 这里改成跟基类
     完全一致即可, 但保留 modifier 让 design 后续可微调而其他按钮不变。*/
  .bill-swipe-action.glass-pill.glass-pill--edit {
    /* 沿用基类 app.css .glass-pill 的渐变 (不重写) — 仅显式声明便于读 */
    color: var(--accent-700, #4338ca);
    border-color: rgba(99, 102, 241, 0.22);
  }
  .bill-swipe-action.glass-pill.glass-pill--edit:hover {
    color: var(--accent-800, #3730a3);
    border-color: rgba(99, 102, 241, 0.30);
  }

  .bill-swipe-action {
    position: absolute;
    /* v0.3.17 #19 hotfix (PO msg 09:14 真验): 删 top:6/bottom:6 + 加 aspect-ratio:1,
         让 width === height 永远保持 1:1。
         之前 #18 用 top:6 + bottom:6 让按钮 height 跟 row 高度走 (~82px),
         跟 progress→56px width 不匹配 → 视觉是 56×82 竖椭圆, 不是圆。
         现在 top:50% + translateY(-50%) 垂直居中, aspect-ratio:1 让
         progress=1 时是 56×56 真圆, progress<1 时也是 28×28 / 14×14 等
         缩小版真圆 (而不是椭圆)。border-radius 50% 在方形上 = 真圆。 */
    top: 50%;
    transform: translateY(-50%);
    width: calc(var(--swipe-progress, 0) * 56px);
    aspect-ratio: 1 / 1;
    /* v0.3.17 #19: 真圆形 — aspect-ratio 保证 1:1, 50% border-radius 在方形上
         就是圆 (之前 #18 也是 50%, 但 height != width 让 50% 在矩形上只能
         切圆角, 不是圆)。 */
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    /* v0.3.17 #18: 圆形 icon-only, 删 gap (圆里只有 1 个 svg, 不需要 icon-text 间距) */
    cursor: pointer;
    /* v0.3.16 #14 hotfix (PO msg 02:02): z-index 提到 2, 盖在 .bill-row (z=1) 上,
       让 glass-pill 玻璃 blur 看穿到下方的 bill 文字 (meta/amount)。
       v0.3.17 #17: 玻璃饱和度降回 0.10/0.08 后, 玻璃 blur 看穿效果再次可见
       (跟 #12 clip-path 后透明玻璃一样) — button 后面是 bill 文字, 不是 day 白底。
       v0.3.17 #19: z-index 不动 (按钮还是 absolute + 居中)。*/
    z-index: 2;
    appearance: none;
    padding: 0;
    font-family: inherit;
    /* v0.3.17 #18 hotfix: 删 font-weight/font-size (圆里没文字) */
    /* opacity 跟随 --swipe-progress 同步淡入 */
    opacity: var(--swipe-progress, 0);
    /* v0.3.17 #17: 跟全站 .glass-pill hover/active 同步加 transform 反馈 —
       translateY(-1px) (hover) + scale(0.97) (active).
       但 swipe 期间不能 transform (按钮 absolute 跟 row 不动), 只在非 swiping
       (--swipe-progress ≥ 1) 时有反馈 — 用 transition 上 width/opacity 控制,
       transform 仍 fixed 时不抖动。*/
    transition:
      width 100ms ease-out,
      opacity 100ms ease-out,
      background 150ms ease,
      border-color 150ms ease,
      color 150ms ease;
    pointer-events: none;
    overflow: hidden;
    white-space: nowrap;
    box-sizing: border-box;
  }
  /* 阈值 (≥ 1) 才允许点击, 避免 0~80px 之间误触 */
  .bill-swipe-action[aria-hidden="false"] {
    pointer-events: auto;
  }
  .bill-swipe-action-left {
    left: 6px;
  }
  .bill-swipe-action-right {
    right: 6px;
  }
  /* v0.3.17 #18 hotfix (PO msg 06:18): 圆形按钮里只剩 Lucide icon, 没文字。
     svg size 14→22 (圆形直径 56, icon 22 占 ~40%, 视觉协调)。
     color: currentColor 仍跟随 .bill-swipe-action (蓝紫编辑 / 红色删除)。
     删 .bill-swipe-action-label rule (没文字节点了)。 */
  .bill-swipe-action > svg {
    flex: 0 0 auto;
    display: inline-block;
    color: currentColor;
  }

  /* === 反馈修 6 项目 3: .bill-row 删独立 background,默认透明继承,
       跟 .day-group 共享同一 surface 背景色 === */
  .bill-row {
    position: relative;
    z-index: 1;
    /* 删除 background: white — 让 day-group 背景透出 */
    padding: var(--space-3) var(--space-4);
    /* 删除 border-bottom (已移到 .bill-swipe-wrap,避免双层) */
    transition: background-color 200ms ease;
    outline: none;
    user-select: none;
    -webkit-user-select: none;
  }
  /* v0.3.16 #14 hotfix (PO msg 02:02): 之前 #11/#12 用 white bg + clip-path
     把按钮从 bill-info-layer 后面"挖洞"出来, 但挖洞后那块是 day-group 白底,
     用户看到「按钮罩在白方块上」而不是「玻璃罩在账单内容上」。
     这次改: 删 white bg + clip-path (class 仍挂 markup 上但无 rules),
     bill 文字满宽直通到按钮玻璃 blur 后面。 */

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
    align-items: stretch;
    gap: 2px;
    margin-top: 2px;
    font-size: var(--font-size-sm);
  }
  .bill-meta-line {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .bill-meta-text {
    min-width: 0;
    flex: 1 1 auto;
  }
  /* v0.3.16 #9 (PO msg 20:01): bill row2 时间右侧加 Lucide users icon + 人数,
     跟 SettleMemberBreakdown.svelte .participant-count 风格一致 (灰色文字) */
  .bill-participants {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--gray-500);
    font-size: var(--font-size-xs, 12px);
    flex-shrink: 0;
    white-space: nowrap;
  }
  .bill-participants svg {
    display: inline-block;
    vertical-align: -2px;
    color: currentColor;
    flex-shrink: 0;
  }
  .your-share {
    font-weight: 600;
    color: var(--accent-500);
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }
</style>
