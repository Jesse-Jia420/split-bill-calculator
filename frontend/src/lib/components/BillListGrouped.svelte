<script lang="ts">
  /**
   * v0.3.18 #68 (2026-07-20) — 账单时间 header 单/双币统一 (PO #6899 ★★★ A)。
   *
   * 本次 polish (v0.3.18 #68):
   * - 固定 3 行布局: 单/双币 group header 高度 100% 一致 (反 #121 自决, 跟 Designer
   *   mockup A 字面执行)。
   * - Row 1 = [+ toggle] [日期] ... [总笔数 badge]
   * - Row 2 = 货币玻璃 chip 行 (单币 1 chip / 双币 2 chip inline-flex + nowrap)
   * - Row 3 = 人均行 (单币 "人均 X CNY" / 双币 "人均 X CNY + Y THB")
   * - chip 行主币种 (session.primary_currency) = indigo 玻璃, 副币种 = teal 玻璃
   *   (一眼分主次)
   * - chip 行用 flex-wrap: nowrap + overflow:hidden + text-overflow:ellipsis,
   *   320px 极窄屏下双币自动 ellipsis, 不再换行成第 4 行
   * - "+" toggle 改 22×22 圆形 indigo 0.10 bg (跟 v0.3.17 #19 圆形按钮族一致),
   *   不用 absolute 定位 (放在 row-1 flex 头)
   *
   * 沿用 v0.1.4:
   * - <details> 顺滑折叠动画 + share_amount 独立一行
   *
   * 沿用 v0.1.3 Sprint 2:
   * - T6 千分位: formatMoney + formatDate
   * - T7 折叠默认: 最新 occurred_at 当天默认展开
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token
   *
   * 沿用:
   * - v0.3.17 #20 sticky header 浮起 + 列表展开动画卡 stagger 取消
   * - v0.3.17 #21 swipe drag rubber band spring damping + sticky iPhone Safari
   * - v0.3.18 #50 全站极透明化 (section bg 0.04 + hairline 0.18)
   * - v0.3.18 #62 #64 SessionCard C + Member section A (玻璃化延续)
   */
  import { onMount, tick } from 'svelte';
  import { writable, get, type Writable } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { fly, fade } from "svelte/transition";
  import { Pencil, Trash2 } from 'lucide-svelte';
  import { formatMoney, formatDate } from '$lib/utils/format';
  import { currencySymbol } from '$lib/utils/currency';
  // v0.3.0728-3 #7 (PO msg 2026-07-28 batch 新批 #7) — reverse v0.3.0728-2 #13: 重新 import currencySymbol,
  // 跟 v0.3.20 #96 bill-share 算法重提取同步, 简化 module 依赖.
  // v0.3.20 #96 (PO msg 02:41 #7467): extracted the per-bill "分摊" and
  // per-day "人均" math out of this component so the algorithm can be
  // unit-tested without spinning up Svelte. Bug: previous implementation
  // did ``b.amount / n`` which ignored ``exclusive_amount`` and produced
  // the wrong per-person share for any bill with an exclusive portion.
  // See bill-share.test.ts for the regression cases (bill #95 PO example).
  import { yourShare, computePerCapitaBreakdown } from '$lib/utils/bill-share';
  import type { Bill } from '$api/bills';
  import SkeletonBill from './SkeletonBill.svelte';
  import CategoryIcon from './CategoryIcon.svelte';

  export let bills: Bill[];

  /** v0.3.22 #119 (PO msg 11:35 #7838 Bug 4 续): caller 传原始总账单数,
   *  让空态 placeholder 区分：
   *    - totalBills === 0 → "还没有账单" (无数据) (历史)
   *    - totalBills > 0 && filteredBills === 0 → "没有匹配" (有数据但 filter 没出)
   *  默认 -1 → caller 未传 (e.g. 老 caller) → 走原 "还没有账单" fallback,
   *  维持兼容. */
  export let totalBills: number = -1;

  // v0.3.22 #119 (PO msg 11:35 #7838 Bug 4 续): min-height 维持 list 高度不变.
  // 反 #150 — 之前主要修法是 #118 scrollSearchToSticky onfocus + #layout.svelte
  // overflow-anchor: always, 但 chromium scroll anchoring 算法不选 sticky
  // .bills-search 作为 anchor — 当 filteredBills 变化让 list 缩短, main.scrollHeight
  // 减少 → main.scrollTop 自动 clamp 到新 max (=scrollHeight - clientHeight),
  // search sticky element 视觉上从 sticky top:8 掉到 list 上方 (Bug 4 "乱跳").
  // 实际复现: scrollTop=771 (after focus) → input 'a' → 539 → 'ab' → 325
  //   (max = 989 - 664 = 325). search 从 viewport top:92 掉到 top:454,
  //   list 完全空了才稳定 (后续字符无变化).
  // 完整修法: .bill-grouped 加 min-height = initial-bills total height.
  // 用户输入减少 list 时, actual 高度 = min-height (留白空 spacing), 但
  // main.scrollHeight 不再减少 → main.scrollTop 不 clamp → search sticky 位稳.
  // min-height 用 $-state 在 mount capture 一次 (initial bills height), 后续
  // 保持该值不变 — user 滚动 / re-mount 不重设.
  let listMinHeight = 0;
  /** v0.3.22 #119: mount 时 capture `.bill-grouped` 实际高度作为 min-height.
   *  后续 filteredBills 缩短时 actual height >= min-height, main.scrollHeight
   *  维持在 initial 水平, scrollTop 不 clamp, search sticky 位稳. */
  onMount(() => {
    // 等首帧 layout 完成
    requestAnimationFrame(() => {
      const list = document.querySelector('.bill-grouped');
      if (list instanceof HTMLElement) {
        listMinHeight = list.offsetHeight;
      }
    });
  });
  export let sessionId: number;
  export let memberIdToName: Record<number, string> = {};
  export let currentUserMemberId: number | null = null;
  export let onDelete: ((billId: number) => void | Promise<void>) | null = null;
  /** Sprint 3 T13: true 时显示 N 个 SkeletonBill 骨架 */
  export let loading: boolean = false;
  /** v0.3.20 #95 Fix 3 (PO msg 02:41 #7459): payer 头像位置在 session.members
     数组里的 index 用于查 AVATAR_COLORS[5 色循环]. 父页面 (sessions/[id]/+page.svelte)
     传 session.members 完整数组 (含 id + display_name), BillListGrouped 用
     payer_id → member index → 颜色. 头像本身的渲染仍归 SessionMemberList
     (共享 5 色循环), 此处只取颜色不画头像。 */
  export let members: Array<{ id: number; display_name: string }> = [];
  /**
   * v0.3.18 #68: 主币种 (session.primary_currency)。
   * - 提供时, 该币种的 chip 用 indigo 玻璃 (主币种视觉).
   * - 其他币种 chip 用 teal 玻璃 (副币种视觉).
   * - 不提供时 (undefined / null), currencyTotals 第一个 chip 视为主币种
   *   (向后兼容旧调用方 + 反 #121 自决排版细节).
   * 路由 +page.svelte 已传 session.primary_currency (从 SessionDetail.primary_currency).
   */
  export let primaryCurrency: string | null = null;
  /**
   * v0.3.18 #69: 该 session 的全部币种 (session.currencies), 用于行 2/3 循环。
   */
  export let currencies: string[] = [];

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

  // v0.3.20 #96: computePerCapitaBreakdown moved to $lib/utils/bill-share
  // (was duplicating ``b.amount / n`` here, which ignored exclusive
  // portions and gave the wrong per-person share for bills like #95).

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
        // v0.3.23 #135 (UAT bug #10): 天内按时间倒序 — 新发生在前.
        // 旧实现 ta - tb (升序, 最早在前) → 改 tb - ta (降序).
        if (ta !== tb) return tb - ta;
        return b.id - a.id;
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

  // v0.3.20 #95 Fix 3 (PO msg 02:41 #7459): payer 文字颜色 = 头像主色.
  // 跟 SessionMemberList.svelte AVATAR_GRADIENTS 共享同一 5 色循环, 此处只取
  // 实色用于 "xx 付" inline color. 反: #144 不要碰 avatar 渲染本身, 此处只
  // 改文字; avatar 仍由 SessionMemberList 用 linear-gradient 渲染.
  const AVATAR_COLORS = [
    '#6366f1', // indigo (#6366f1 → #a855f7 第 1 色)
    '#ec4899', // pink (#ec4899 → #f43f5e 第 1 色)
    '#10b981', // emerald (#10b981 → #14b8a6 第 1 色)
    '#f59e0b', // amber (#f59e0b → #eab308 第 1 色)
    '#3b82f6', // blue (#3b82f6 → #06b6d4 第 1 色)
  ];
  function payerColor(b: Bill): string {
    // 找 payer_id 在 members 数组里的 index (顺序跟 SessionMemberList 头像一致)
    // 找不到 (members 没传 / payer_id 是孤儿) fallback 到默认第一色 indigo.
    const idx = members.findIndex((m) => m.id === b.payer_id);
    if (idx < 0) return AVATAR_COLORS[0];
    return AVATAR_COLORS[idx % AVATAR_COLORS.length];
  }

  // v0.3.20 #96: yourShare moved to $lib/utils/bill-share (now takes
  // currentMemberId as a parameter so the algorithm is testable in
  // isolation). Local callsite updated below to pass currentUserMemberId.

  // v0.3.20 #92 (PO msg 07:13 #7409): 聚合 bill.participants 中所有 is_exclusive 的 exclusive_amount.
  // 仅在该 bill 有独占消费时返回 > 0, 用于决定 .bill-row-exclusive 行是否渲染.
  function billExclusiveTotal(b: Bill): number {
    return (b.participants ?? [])
      .filter((p) => p.is_exclusive && Number(p.exclusive_amount) > 0)
      .reduce((sum, p) => sum + Number(p.exclusive_amount), 0);
  }

  // v0.3.17 #36fix3 (PO msg 14:53): session-member-level ownership
  // predicate. Drives whether the swipe action buttons render as
  // enabled (full opacity, click triggers edit/delete) or visually
  // disabled (opacity 0.4 + cursor: not-allowed + pointer-events: none
  // so click does NOT fire onSwipeEdit / onSwipeDelete). The swipe
  // gesture itself is intentionally NOT disabled — PO wants users to
  // see the buttons appear and understand why they're inert.
  function billCanEdit(b: Bill): boolean {
    if (currentUserMemberId === null || currentUserMemberId === undefined) return false;
    return b.created_by_session_member_id === currentUserMemberId;
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
    // v0.3.17 #36fix3 (PO msg 14:53): defense-in-depth — even though
    // the disabled button has ``pointer-events: none`` (CSS), if a
    // future browser bug or programmatic click reaches here we still
    // refuse to navigate. The owner check is the same one the BE
    // uses; comparing on the FE avoids the wasted network round trip.
    const bill = (bills ?? []).find((b) => b.id === billId);
    if (!bill || !billCanEdit(bill)) return;
    swipeOffsetStore.update((o) => ({ ...o, [billId]: 0 }));
    if (get(openSwipeBillIdStore) === billId) openSwipeBillIdStore.set(null);
    await tick();
    goto(`/sessions/${sessionId}/bills/${billId}/edit`);
  }
  async function onSwipeDelete(billId: number, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // v0.3.17 #36fix3 (PO msg 14:53): see onSwipeEdit. Same guard.
    const bill = (bills ?? []).find((b) => b.id === billId);
    if (!bill || !billCanEdit(bill)) return;
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
    // Svelte 5 的 class:open={isOpen(g.date)} 被 untrack 包住 → 不反应 collapsed 更新。
    // 手动切 chevron DOM class 确保视觉同步 (native details toggle 此时已完成)。
    const chevron = el.querySelector('.day-chevron');
    if (chevron) chevron.classList.toggle('open', isOpenNow);
    collapsed = { ...collapsed, [date]: !isOpenNow };
    saveCollapsedState();
  }

  onMount(() => {
    // T7: freeze defaultOpenDates(在 onMount 后不再重算,切 session 也不会动)。
    defaultOpenDates = computeDefaultOpenDates(bills);

    // 尝试加载用户已保存的 state。
    const saved = loadCollapsedState();
    const userTouched = Object.keys(saved).length > 0;

    // v0.3.18 #69 fix2 (PO #6918): isOpen(date) 的优先级:
    //   date in collapsed → return !collapsed[date] (用户显式设置)
    //   else → return defaultOpenDates[date] (T7 默认)
    // 之前 collapsed = { ...defaultOpenDates } 让 collapsed 有全部 date key,
    // 导致 isOpen 返回 !collapsed[date] — 把 T7 "今天展开" 反转成折叠。
    // 修复: 不复制 defaultOpenDates 到 collapsed,让 isOpen 走 fallback。
    if (userTouched) {
      // 用户手动 toggle 过 → localStorage 优先
      collapsed = { ...collapsed, ...saved };
    }
    // else: collapsed 保持 {} → isOpen 会 fallback 到 defaultOpenDates
    // 不写 localStorage,等用户真正 toggle 时再写。

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

<div class="bill-grouped" style="min-height: {listMinHeight}px;">
  {#if loading}
    <ul class="skeleton-list" aria-busy="true" aria-label="加载中">
      <li><SkeletonBill /></li>
      <li><SkeletonBill /></li>
      <li><SkeletonBill /></li>
    </ul>
  {:else if !bills || bills.length === 0}
    {#if totalBills === 0}
      <p class="muted">
        还没有账单,<a href="/sessions/{sessionId}/bills/new">点"+ 新建账单"开始</a>。
      </p>
    {:else}
      <!-- v0.3.22 #119: filter 没匹配项 placeholder (跟“没有账单”区别,
            让用户知道是输入问题不是没数据). -->
      <p class="muted bill-list-empty">
        没有匹配的账单,换个关键词试试。
      </p>
    {/if}
  {:else}
    <!-- v0.3.0728-2 #15 (PO msg 2026-07-28 21:17 解冻 "继续0728-2其他"):
         账单列表页右侧上方小字标注 "左划以删除账本, 右划以编辑账本".
         跟 v0.3.0728-2 #14 (session card per-item hint) 形成对比:
         #14 是 per-bill-item 小字 (swipe 提示放在每个 item), #15 是整个 bill list 顶部 1 个 hint
         (跟 0728-3 #3 sessions list 顶部 hint 模式对齐, 视觉一致).
         玻璃感跟 .swipe-hint-delete 同源 (indigo alpha 0.10/0.18), 但放顶层而不是 per-item,
         右对齐 (align-self: flex-end), 12.5px font, 6px padding, 8px radius.
         pointer-events: none (不抢 click, swipe 仍能透过触发 delete/edit).
         aria-label: 账单列表左右划手势提示 (屏幕阅读器可读). -->
    <!-- v0.3.0729-2 UAT #2: 文案改「账单」+ 样式跟 sessions .list-top-hint 一致; 删除红/编辑蓝. -->
    <div class="bill-swipe-hint" data-testid="bill-swipe-hint" aria-label="左滑以删除账单，右滑以编辑账单">
      <span class="swipe-arrow" aria-hidden="true">←</span>
      <span>
        左滑以<span class="hint-delete">删除</span>账单，右滑以<span class="hint-edit">编辑</span>账单
      </span>
    </div>
    <ul class="day-list" style="list-style: none; padding: 0; margin: 0;">
      {#each groups as g, gi (g.date)}
        <li class="day-group" in:fly={{ y: 8, duration: 220, delay: Math.min(gi * 40, 240) }}>
          <details open={isOpen(g.date)} ontoggle={(e) => onGroupToggle(g.date, e)}>
            <!-- v0.3.18 #68 (PO #6899 ★★★ A): 固定 3 行布局 —
                 单币/双币 group 高度 100% 一致, 滚动节奏齐.
                 Row 1 = [+ toggle] [日期] ... [总笔数 badge]
                 Row 2 = 货币玻璃 chip 行 (1-2 个 chip, inline-flex + nowrap)
                 Row 3 = 人均行 -->
            <summary class="day-header section-header">
              <div class="day-row-1">
                <span class="day-date" data-testid="day-date">{formatDate(g.date, { weekday: true })}</span>
                <span class="day-row-1-right">
                  <span class="day-count" data-testid="day-count">{g.bills.length} 笔</span>
                  <!-- v0.3.20 #93 (PO msg 00:04 #7450, Fix 5): chevron text moved to CSS ::before so details[open] can swap character (collapsed SINGLE-RIGHT-CHEVRON / expanded DOWN-CHEVRON) -->
                  <span class="day-chevron" data-testid="day-chevron" aria-hidden="true"></span>
                </span>
              </div>
              <div class="day-row-2">
                {#if currencies && currencies.length > 0}
                  {#each currencies as ccy}
                    {@const total = g.currencyTotals.find(t => t.ccy === ccy)}
                    {@const isPrimary = (primaryCurrency !== null && primaryCurrency !== undefined)
                      ? ccy === primaryCurrency
                      : false}
                    <span
                      class="cc-chip"
                      class:cc-chip-secondary={!isPrimary}
                      class:cc-chip-empty={!total}
                      data-testid="cc-chip"
                    >
                      <span class="cc-code">{ccy}</span>
                      <span class="cc-amt">{total ? fmtAmount(total.amount) : '—'}</span>
                    </span>
                  {/each}
                {:else}
                  {#each g.currencyTotals as t, ti (t.ccy)}
                    {@const isPrimary = (primaryCurrency !== null && primaryCurrency !== undefined)
                      ? t.ccy === primaryCurrency
                      : ti === 0}
                    <span
                      class="cc-chip"
                      class:cc-chip-secondary={!isPrimary}
                      data-testid="cc-chip"
                    >
                      <span class="cc-code">{t.ccy}</span>
                      <span class="cc-amt">{fmtAmount(t.amount)}</span>
                    </span>
                  {/each}
                {/if}</div>
              <div class="day-row-3">
                {#if g.perCapitaBreakdown.length === 1}
                  {@const pc = g.perCapitaBreakdown[0]}
                  <!-- v0.3.20 #92 (PO msg 07:13 #7409): 单币场景 (1 个 perCapitaBreakdown entry) —
                       "人均 X CNY". 无论 session currencies 是 1 还是 2, 都按实际账单数据展示. -->
                  <span class="muted">
                    人均 <strong>{fmtAmount(pc.amount) + ' ' + pc.ccy}</strong>
                  </span>
                {:else if g.perCapitaBreakdown.length > 1}
                  <!-- v0.3.20 #92 (PO msg 07:13 #7409): 双币/多币 dedupe — 单一 "人均" label,
                       多币种值合并到同一 <strong> (用 " · " 分隔).
                       迭代 g.perCapitaBreakdown (实际有账单数据的币种) 而不是 session currencies,
                       避免空币种渲染为 "—". -->
                  <span class="muted">
                    人均 <strong>{#each g.perCapitaBreakdown as pc, i (pc.ccy)}{#if i > 0} · {/if}{fmtAmount(pc.amount) + ' ' + pc.ccy}{/each}</strong>
                  </span>
                {:else}
                  <!-- v0.3.18 #68: 没有 per-capita 数据时 fallback -->
                  <span class="muted">人均 <strong>—</strong></span>
                {/if}
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
                    {@const share = yourShare(b, currentUserMemberId)}
                    <!-- v0.3.0728-2 #12: 分摊 0 总显 (跟 #8 同模式). displayShare = share ?? 0,
                         isOnlyExclusive = billExclusiveTotal(b) >= b.amount (硬护 wrap 个人消费全额独占场景).
                         两个 const 在 each 顶级 (跟 share = yourShare(...), rowOffset = ... 同源), 模板内可访问. -->
                    {@const displayShare = share ?? 0}
                    {@const isOnlyExclusive = billExclusiveTotal(b) >= Number(b.amount)}
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
                    <!-- v0.3.17 #36fix3 (PO msg 14:53): session-member-level
                         ownership predicate. Drives the .disabled modifier
                         on both swipe action buttons: when false, the CSS
                         ``pointer-events: none`` rule kicks in and the
                         click handlers short-circuit (see onSwipeEdit /
                         onSwipeDelete). PO 字面 wants the buttons to still
                         APPEAR (so users understand "this bill belongs to
                         someone else") but be visually greyed out. -->
                    {@const canEdit = billCanEdit(b)}
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
                          class:disabled={!canEdit}
                          style="--swipe-progress: {rightProgress}"
                          tabindex={rightProgress >= 1 && canEdit ? 0 : -1}
                          aria-hidden={rightProgress <= 0}
                          aria-disabled={!canEdit}
                          aria-label={canEdit
                            ? `删除账单 (圆形按钮): ${b.description || '(无说明)'}`
                            : `账单由他人创建, 不可删除: ${b.description || '(无说明)'}`}
                          onclick={(e) => onSwipeDelete(b.id, e)}
                        >
                          <!-- v0.3.17 #18 hotfix (PO msg 06:18): 圆形 icon-only 按钮。
                               size 14→22: 圆形按钮直径 56px, icon 14 在圆里偏小不协调,
                               22 视觉占圆形约 40%, 跟全站 landing/settle 大圆形 FAB 同语言。
                               删文字「删除」: 圆形 + 2 字塞不下 (iOS Mail 也是 icon-only 圆)。
                               aria-label 屏幕阅读器仍告知 "删除账单", 视觉只是 icon。 -->
                          <Trash2 size={22} strokeWidth={2} aria-hidden="true" />
                        </button>
                      {/if}
                      <!-- v0.3.18 #52 (PO msg 00:53 #6533 "右滑置灰的编辑不见了"):
                           跟删除按钮对称 — 不再用 {#if canEdit} 完全隐藏,
                           改成永远渲染 + class:disabled={!canEdit} 视觉置灰.
                           这样非 owner 账单右滑时也能看到灰色编辑按钮,
                           用户能理解"这账单是别人创建的, 不能编辑".
                           JS onSwipeEdit 已有 billCanEdit guard (defense-in-depth).
                           aria-label disabled variant 走"账单由他人创建, 不可编辑"文案. -->
                      <button
                        type="button"
                        class="bill-swipe-action bill-swipe-action-left glass-pill glass-pill--edit"
                        class:disabled={!canEdit}
                        style="--swipe-progress: {leftProgress}"
                        tabindex={leftProgress >= 1 && canEdit ? 0 : -1}
                        aria-hidden={leftProgress <= 0}
                        aria-disabled={!canEdit}
                        aria-label={canEdit
                          ? `编辑账单 (圆形按钮): ${b.description || '(无说明)'}`
                          : `账单由他人创建, 不可编辑: ${b.description || '(无说明)'}`}
                        onclick={(e) => onSwipeEdit(b.id, e)}
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
                        ontouchstart={(e) => onTouchStart(b.id, e)}
                        ontouchmove={(e) => onTouchMove(b.id, e)}
                        ontouchend={(e) => onTouchEnd(b.id, e)}
                        ontouchcancel={(e) => onTouchCancel(b.id, e)}
                        onmousedown={(e) => onMouseDown(b.id, e)}
                        onclick={onRowTap}
                      >
                        <div class="bill-row1">
                          <CategoryIcon description={b.description ?? ''} size={18} />
                          <span class="bill-desc">{b.description || '(无说明)'}</span>
                          <span class="bill-amount">
                            {fmtAmount(b.amount)}<span class="unit">{b.currency}</span>
                          </span>
                        </div>
                        <!-- v0.3.20 #92 (PO msg 07:13 #7409): 新增 .bill-row-exclusive —
                             独占金额行. 仅当 b.participants 里有任意 is_exclusive && exclusive_amount > 0 时渲染.
                             单币独占金额聚合 (双币独占场景后端暂不支持, 但代码防御性 sum 一下).
                             v0.3.36 #8 — UAT 0728-1 #8 (PO 字面 "个人消费金额 0 时显示 ¥0.00"):
                             0 不可隐藏, 总是展示 个人消费 ¥0.00 行 (跟 v0.3.33 #1 descriptionError 同模式
                             "0 不可隐藏"). 改: 删 {#if billExclusiveTotal(b) > 0} 条件, 总是渲染.
                             billExclusiveTotal(b) === 0 时 fmtAmount(0) 返 "0.00", 视觉 = "个人消费 ¥0.00 CNY".
                             scope: 仅 billListGrouped item 行; 其他地方 (settle 页面) 不变. -->
                        <!-- v0.3.0728-2 #13 (UAT 0728-2 #13 个人消费只显 cny thb 不显 ¥) 改 amount 后跟 CNY / THB currency code.
                             v0.3.0728-3 #7 (PO msg 2026-07-28 batch 新批 #7) reverse: amount 后跟 ¥ currency symbol (简洁货币符号).
                             v0.3.36 #8 仍保留 (0 显示 "0.00"). -->
                        <div class="bill-row-exclusive muted">
                          个人消费 {currencySymbol(b.currency)}{fmtAmount(billExclusiveTotal(b))}
                        </div>
                        <div class="bill-row3 muted">
                          <span class="bill-meta-left">
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
                            <!-- v0.3.20 #95 Fix 3 (PO msg 02:41 #7459): "xx 付"
                                 文字颜色 = 该 payer 的头像主色 (5 色循环, 跟 SessionMemberList 共享).
                                 时间部分保持灰色 (默认 .bill-meta-text color). 拆成两个 span 让颜色
                                 仅作用在 "xx 付" 这 2 字符上. -->
                            <span class="bill-meta-text">{fmtBillTime(b.occurred_at)} · </span><span class="bill-meta-text" style="color: {payerColor(b)};">{payerName(b)} 付</span>
                          </span>
                          <!-- v0.3.0728-2 #12 — UAT 0728-2 #12 bill item 没分摊时显 "分摊 0" (PO msg 16:50).
                               原 {#if share !== null} 条件限制只在 user 是 participant 时才显 — 但 own_share = 0 (user 是 participant 但 share_amount = 0)
                               也需展示. v0.3.36 #8 个人消费 0 总显 ("个人消费 0.00 CNY") 已实施, 但 分摊 0 在某些 edge case (user 是 participant + share = 0)
                               需同样总显.
                               修法: 不再用 {#if share !== null}, 改为总是渲染. own_share = 0 → fmtAmount(0) = "0.00" → "分摊 0.00 CNY".
                               share === null (user 不是 participant) 也补 0 — 跟 #8 同模式 "总显". -->
                          <span class="your-share">分摊 {fmtAmount(isOnlyExclusive ? 0 : displayShare)}<span class="unit">{b.currency}</span></span>
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
  /* v0.3.0728-2 #15 (PO msg 2026-07-28 21:17 解冻): 账单列表页右侧上方小字标注
     "左划以删除账本, 右划以编辑账本". 跟 v0.3.0728-2 #14 .swipe-hint-delete 视觉同源
     (indigo alpha 0.10/0.18 glass), 但放顶层而不是 per-bill-item.
     .bill-grouped 用 flex column 让 hint 自然垂直排在 day-list 之上,
     gap: var(--space-2) = 8px 视觉呼吸. hint 自己 align-self: flex-end 右对齐.
     pointer-events: none (不抢 click, swipe 仍能透过触发 delete/edit). */
  .bill-grouped {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  /* v0.3.0729-2 UAT #2: 跟 sessions/+page .list-top-hint 同款灰色描边弱化样式. */
  .bill-swipe-hint {
    align-self: flex-end;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: transparent;
    border: 1px solid rgba(15, 23, 42, 0.14);
    padding: 2px 8px;
    font-size: 11px;
    border-radius: 9999px;
    pointer-events: none;
    color: var(--gray-500, #737373);
    font-weight: 400;
    line-height: 1.4;
    letter-spacing: -0.005em;
    white-space: nowrap;
    /* v0.3.20 #93 兼容: hint 排在 .bills-search 之下, day-header sticky 之上,
       sticky top: var(--bills-search-h, 50px) + .bills-search ~46px = ~96px,
       hint 在这区间内 ~visible, 不被 sticky header 盖 */
  }
  .bill-swipe-hint .swipe-arrow {
    font-weight: 500;
    font-size: 11px;
    color: var(--gray-400, #a3a3a3);
  }
  .bill-swipe-hint .hint-delete {
    color: var(--error-700, #be123c);
    font-weight: 500;
  }
  .bill-swipe-hint .hint-edit {
    color: var(--accent-700, #4338ca);
    font-weight: 500;
  }
  /* v0.3.24 #18 (PO msg 16:35 UAT line #18 字面 "账单列表搜索框，当无搜索结果时，提示的 没有匹配的账单，换个关键词试试 ，出现的位置不对，被搜索框挡住了。应下移一些"):
     原 .muted (app.css 全局类, 仅 color: gray-500) 无 padding, placeholder 紧贴 .bills-search bottom (跟 day-group 头一行同 y 位置), 视觉跟 search box "拼"在一起 — 用户感受是 "被搜索框挡".
     第一版尝试 padding-top (顶部空间推进 placeholder box 内): 验证发现 placeholder BOX 整体 y 位置不变 (margin 不动) — 仅 text 下移到 box 底部 23px, 反而看着更 "底部被压" 不像 "下移".
     第二版改 margin-top: var(--space-6) (~24px, 全站 spacing token 一致) — placeholder BOX 整体下移 24px, 跟 search box 有视觉呼吸空隙. text-align center 维持 (跟全站 muted 提示文一致).
     .bill-list-empty 跟 .muted 通用类配合: 颜色走 .muted (gray-500), 间距走 .bill-list-empty (24px top margin).
     不影响 "还没账单" placeholder (它用别的 p.muted, 没 .bill-list-empty class).
  */
  .bill-list-empty {
    margin: var(--space-6) 0 0;
    text-align: center;
  }
  /* v0.3.18 #46-A (PO msg 18:15 拍板): sheet 玻璃感加强 (方案 B + 玻璃感更强)
     — sheet bg 0.32 → 0.55 (明显玻璃边缘)
     — saturate 150% → 180%, blur 16 → 22px (更糊)
     — border-radius 12px → 14px
     — 1px 白色 inset highlight 边 (玻璃边缘隐形)
     — 双层 shadow (外阴影 + inset highlight)
     反 #121 自决 (没问 PO 颜色值), PO 拍板"玻璃感要更明显一点"
     ===
     v0.3.18 #48 (PO msg 19:10 #6489 全站透明化 sweep): bg 0.55 → 0.25 (× 0.45)
     让 peach→rose→lavender 背景图透过来. border 0.4 → 0.55 (边缘补偿).
     inset highlight 0.6 → 0.7 (玻璃上沿高光微加强). 外阴影 indigo 0.06 → 0.10.
     saturate/blur/radius 保留 #46-A 已加强值 (不破坏 #46-A 已落地的玻璃感).
     ===
     v0.3.18 #49 (PO msg 21:16 #6508 极透明化 sweep, 账单 section 也要更透明):
     bg 0.25 → 0.10 (跟 .glass-sheet 同透度, day group 几乎全透).
     border 0.55 → 0.65 (白边更明显). inset highlight 0.7 → 0.95 (玻璃上沿更明显).
     外阴影 indigo 0.10 → 0.16 (玻璃感更强). */
  /* === v0.3.18 #50 (PO msg 22:12 #6523 极透明化 v2): #49 边缘补偿过头,
     section 还是看起来"白纸+文字", 再降一档几乎全透 ===
     - bg 0.10 → 0.04 (几乎完全透明, 只剩 4% 白底提示"这块是 section")
     - border 0.65 → 0.18 (白边几乎消失)
     - inset highlight 0.95 → 0.20 (玻璃上沿大幅淡化, 不再像"白框卡片")
     - 外阴影 indigo 0.16 → 0.04 + black 0.03 → 0.02 (section 不再像"浮起的卡片")
     - bg image 透出来极其明显 (跟 .member-chip / .glass-sheet / .glass-chip 同语言)
     - text-shadow 由 chip 内文字继承 / day header 文字留给 0.30 inset 同款 1px 高光 */
  .day-group {
    /* 反馈修 6 项目 3: day group 用 surface 背景,bill row 默认透明继承,
       共享同一背景色,消除原灰色边框的"两层卡片"视觉 */
    border: 1px solid rgba(255, 255, 255, 0.18);  /* v0.3.18 #50: 0.65 → 0.18 白边几乎消失 */
    border-radius: 14px;  /* was 8px */
    /* overflow:hidden removed: T10 sticky backdrop-blur needs visible overflow */
    background: rgba(255, 255, 255, 0.04);  /* v0.3.18 #50: 0.10 → 0.04 极透 (靠文字 + hairline 提示 section 边界) */
    backdrop-filter: saturate(180%) blur(22px);  /* was none on day-group */
    -webkit-backdrop-filter: saturate(180%) blur(22px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.20),  /* v0.3.18 #50: inset high light 0.95 → 0.20 大幅淡化 */
      0 1px 4px rgba(99, 102, 241, 0.04),  /* v0.3.18 #50: 外阴影 0.16 → 0.04 section 不再"浮起" */
      0 1px 1px rgba(0, 0, 0, 0.02);  /* v0.3.18 #50: 黑色阴影 0.03 → 0.02 */
  }
  .day-group details {
    width: 100%;
  }

  /* === day header 排版 === v0.3.18 #68 (PO #6899 ★★★ A):
     固定 3 行布局 — 单币/双币 group 高度 100% 一致, 滚动节奏齐.
     Sticky 浮起时 .section-header glass 接管, scroll-under 内容有 blur 遮罩. */
  .day-header {
    display: flex;
    flex-direction: column;
    gap: 8px;
    cursor: pointer;
    list-style: none;
    padding: 12px 16px 14px;
    background: transparent;
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

  /* T10: Sticky section header with glassmorphism
     v0.3.18 #48 (PO msg 19:10 #6489): bg 0.85 → 0.50 (× 0.59 透明化)
     sticky 浮起时仍透背景图, 但够浓液保证文字可读. 保留 blur 12px (iOS27 standard)
     v0.3.18 #49 (PO msg 21:16 #6508 极透明化 sweep): bg 0.50 → 0.30
     sticky 浮起时仍透背景图, 但够浓液保证文字可读.
     v0.3.18 #54 (PO msg 18:10 #6569): 加重模糊 — 0.30 太透, 账单列表 row
     滚过 sticky header 时几乎贴脸穿透. bg 0.30 → 0.65 (× 2.17 浓液化),
     blur 12 → 20 (+67%), sticky 浮起时 row 内容被遮蔽更彻底, 文字可读性
     提升. saturate 180% 保留 (玻璃质感).
     v0.3.18 #68: 保留 sticky 行为 + mask-image 16px opaque (v0.3.17 #20),
     header 高度固定 = 3 行后滚动节奏绝对一致. */
  /* v0.3.20 #93 (PO msg 00:04 #7450, Fix 7): day-header sticky top 改成 var(--bills-search-h, 50px),
     让出 .bills-search (sticky top:0, ~46px 高) 给搜索框常驻.
     z-index 从 10 -> 9 (低于 .bills-search 的 20, 让搜索框视觉浮在 day-header 上). */
  .section-header {
    position: sticky;
    top: var(--bills-search-h, 50px);
    z-index: 9;
    /* UAT: 与 .bills-search 玻璃同浓度, 滚过 bill row 时不穿透 */
    background: var(--bills-sticky-glass-bg, rgba(255, 255, 255, 0.68));
    backdrop-filter: var(--bills-sticky-glass-filter, saturate(200%) blur(24px));
    -webkit-backdrop-filter: var(--bills-sticky-glass-filter, saturate(200%) blur(24px));
    border-bottom: 1px solid rgba(255, 255, 255, 0.35);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45);
  }
  @supports not (backdrop-filter: blur(1px)) {
    .section-header {
      background: rgba(249, 250, 251, 0.95);
    }
  }

  /* === v0.3.18 #68: Row 1 = [+ toggle] [日期] ... [总笔数 badge] === */
  .day-row-1 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 22px;
  }
  /* v0.3.18 #68: "+" toggle 改 22×22 圆形 indigo 0.10 bg (跟 v0.3.17 #19
     圆形按钮族保持一致, 不用 absolute 定位 — 放在 row-1 flex 头) */
  .day-toggle {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(99, 102, 241, 0.10);
    color: #4338ca;
    font-size: 15px;
    font-weight: 400;
    line-height: 1;
    transition: background 200ms ease, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .day-date {
    font-weight: 700;
    font-size: 15.5px;
    color: var(--gray-900);
    letter-spacing: -0.2px;
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
    /* v0.3.18 #49: 日期白色微晕 (防止透明化后文字对比度降低) */
    text-shadow: 0 1px 3px rgba(255, 255, 255, 0.8);
  }
  /* v0.3.18 #68: 总笔数 badge — 跟 chip 行视觉平行, slate bg + slate-500 text */
  .day-count {
    font-size: 12px;
    color: #64748b;
    font-weight: 600;
    background: rgba(15, 23, 42, 0.04);
    padding: 3px 9px;
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    flex-shrink: 0;
    text-shadow: 0 1px 3px rgba(255, 255, 255, 0.8);
  }

  /* === v0.3.18 #68: Row 2 = 货币玻璃 chip 行 ===
     v0.3.20 #92 (PO msg 07:13 #7409): 右对齐 (justify-content: flex-end), 跟 row1 chevron 右侧对齐,
     单/双币统一右对齐. 仍 nowrap + overflow:hidden, 极窄屏 320px 自动 ellipsis (永不换行到第 4 行). */
  .day-row-2 {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    flex-wrap: nowrap;
    overflow: hidden;
    min-height: 30px;
  }
  .cc-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.20) 0%, rgba(59, 130, 246, 0.12) 100%);
    backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    border: 1px solid rgba(99, 102, 241, 0.28);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      0 1px 3px rgba(99, 102, 241, 0.10);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    flex-shrink: 1;
    min-width: 0;
  }
  .cc-chip .cc-code {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #4338ca;
    flex-shrink: 0;
  }
  .cc-chip .cc-amt {
    font-size: 13.5px;
    font-weight: 700;
    color: #0f172a;
    letter-spacing: -0.2px;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  /* 副币种 chip: teal 玻璃 (一眼分主次) */
  .cc-chip.cc-chip-secondary {
    background: linear-gradient(135deg, rgba(20, 184, 166, 0.16) 0%, rgba(99, 102, 241, 0.10) 100%);
    border-color: rgba(20, 184, 166, 0.30);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      0 1px 3px rgba(20, 184, 166, 0.10);
  }
  .cc-chip.cc-chip-secondary .cc-code { color: #0f766e; }

  /* === v0.3.18 #68: Row 3 = 人均行 ===
     v0.3.20 #92 (PO msg 07:13 #7409): 右对齐 (justify-content: flex-end), 跟 row2 chips 右侧对齐.
     双币场景 Fix 4 也合并到单一 "人均" label, 这里右对齐让 values 视觉聚合. */
  .day-row-3 {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    font-size: 12px;
    color: #64748b;
    font-weight: 500;
  }
  .day-row-3 .muted strong {
    color: #334155;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* === v0.3.18 #68 续: 320px 极窄屏 chip 缩号 === */
  @media (max-width: 360px) {
    .day-header { padding: 10px 12px 12px; gap: 6px; }
    .day-row-1 { gap: 8px; min-height: 20px; }
    .day-toggle { width: 20px; height: 20px; font-size: 13px; }
    .day-date { font-size: 14px; }
    .day-count { font-size: 11px; padding: 2px 7px; }
    .day-row-2 { gap: 4px; min-height: 26px; }
    .cc-chip { padding: 4px 8px; gap: 4px; }
    .cc-chip .cc-code { font-size: 10px; }
    .cc-chip .cc-amt { font-size: 12px; }
    .day-row-3 { font-size: 11px; }
  }
  /* === v0.3.18 #68 续: 768px tablet chip 微放大 === */
  @media (min-width: 720px) {
    .day-header { padding: 14px 22px 16px; gap: 10px; }
    .day-row-1 { min-height: 26px; }
    .day-toggle { width: 26px; height: 26px; font-size: 17px; }
    .day-date { font-size: 17px; }
    .day-count { font-size: 13px; padding: 4px 11px; }
    .day-row-2 { gap: 8px; min-height: 34px; }
    .cc-chip { padding: 6px 14px; }
    .cc-chip .cc-code { font-size: 11.5px; }
    .cc-chip .cc-amt { font-size: 15px; }
    .day-row-3 { font-size: 13.5px; }
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

  /* === v0.3.18 #46-A (PO msg 18:15 拍板): 玻璃 hairline 分隔 (方案 B) ===
     - 完全透明 row (继承 sheet glass)
     - 取消 dashed border-bottom (灰色边线视觉脱节 sheet 玻璃)
     - 1px 玻璃 hairline ::after: 水平方向 indigo 渐变
       (rgba 0.18 → 0.24 → 0.18, 比 Designer 方案 B 略深,
        跟 sheet 玻璃边缘呼应 + PO 要求"玻璃感要更明显")
     - 加 backdrop-filter: blur(2px) (iOS separator 风格)
     - 加 box-shadow 0 1px 1px rgba(99,102,241,0.06) (凸起感)
     - :last-child 隐藏最后一行 hairline
     - row padding 8px → 10px (给 hairline 视觉呼吸感)
     ===
     v0.3.18 #48 (PO msg 19:10 #6489): hairline alpha 微调 0.18→0.20/0.24→0.26/0.18→0.20
     (sheet bg 0.55→0.25 后 hairline 需要更显一点才能在透明 sheet 上看出,
     跟新 glass 边缘呼应). shadow 0.06 → 0.08 (凸起感保留). */
  .bill-swipe-wrap {
    position: relative;
    overflow: hidden;
    border-radius: var(--radius-md);
    background: transparent;
  }
  .bill-swipe-wrap::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    background: linear-gradient(
      90deg,
      transparent 0%,
      rgba(99, 102, 241, 0.20) 20%,
      rgba(99, 102, 241, 0.26) 50%,
      rgba(99, 102, 241, 0.20) 80%,
      transparent 100%
    );
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
    box-shadow: 0 1px 1px rgba(99, 102, 241, 0.08);
    pointer-events: none;
  }
  .bill-swipe-wrap:last-child::after {
    display: none;
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
     - 基类 .glass-pill 的玻璃背景/边框/blur 全部保留 (跟全站其它玻璃按钮同语� ��),
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
       transform 仍 fixed 时不抖动。
       v0.3.28 (UAT 0723-3 #8): width 100ms ease-out → 220ms cubic-bezier(0.34, 1.56, 0.64, 1).
       PO 报“左滑 / 右滑 出現或消失不夠順滑, 速度曲線很硬”. 改成跟全站 .fab / .glass-pill 同款
       spring overshoot (cubic-bezier 0.34/1.56) + 拉长 duration 到 220ms 给曲线呼吸空间 — 出来瞬间
       overshoot 轻微 bounce, 消失时跟 rubberBand snap 同步 — iOS Mail 同款体验。
       width spring overshoot 也让圆按钮临时宽于 56px (border-radius 50% + aspect-ratio 1 仍保持
       真圆), 收尾 settle 到 56px 稳定状态。*/
    transition:
      width 220ms cubic-bezier(0.34, 1.56, 0.64, 1),
      opacity 180ms ease-out,
      background 180ms ease,
      border-color 180ms ease,
      color 180ms ease;
    pointer-events: none;
    overflow: hidden;
    white-space: nowrap;
    box-sizing: border-box;
  }
  /* 阈值 (≥ 1) 才允许点击, 避免 0~80px 之间误触 */
  .bill-swipe-action[aria-hidden="false"] {
    pointer-events: auto;
  }
  /* v0.3.29 (UAT 0725-1 #10, PO msg 12:43): 按下时按钮位置变化 bug 真修.
     根因: 全局 .glass-pill:active { transform: scale(0.97); } (app.css:357) 覆盖了基类
     的 transform: translateY(-50%) — 失去垂直居中 + 缩放, 按钮从 row 中央跳到顶部
     (translateY 变成 0) + 微缩 (scale 0.97), 视觉上"位置变化" / "漂走".
     修法: specificity (0,1,1) 高于 .glass-pill:active (0,1,0),
     transform: translateY(-50%) scale(0.97) — 复合 transform 顺序 (translateY
     在前 scale 在后), transform-origin: center 让 scale 围绕按钮中心, 不会"漂走".
     保持按下反馈 (scale 0.97 跟全站 .glass-pill:active 一致) + 保持垂直居中. */
  .bill-swipe-action:active {
    transform: translateY(-50%) scale(0.97);
    transform-origin: center;
  }
  /* v0.3.17 #36fix3 (PO msg 14:53): owner-only swipe actions. The
     .disabled class is applied when the bill's
     ``created_by_session_member_id`` does NOT match the current
     route's ``currentUserMemberId``. PO wants the buttons to still
     appear (so users understand "this is someone else's bill") but
     be visually inert: opacity 0.4 + cursor not-allowed + click
     events suppressed at the CSS layer. The JS click handlers ALSO
     short-circuit as defense-in-depth (see onSwipeEdit / onSwipeDelete).
     specificity: (0,2,0) for .bill-swipe-action.disabled — matches
     the glass-pill--delete/--edit modifiers (0,2,1) cleanly so the
     modifier rules don't override opacity/pointer-events.

     v0.3.18 #51 (PO msg 23:17 #6526 截图红线 #2): 上面实现有 bug —
     opacity: 0.4 !important 强行覆盖了基类 opacity: var(--swipe-progress)
     的默认值 0, 结果非 owner 账单**默认状态下删除按钮就显示在屏幕上
     (opacity 0.4 visible)**, 违背"滑动时才显示"的需求 (commit 752e3d3
     #46-B 的初衷).
     修法:
       - opacity 改为 calc(var(--swipe-progress, 0) * 0.4), 跟 progress
         联动: progress=0 (默认) → opacity 0 (隐形), progress=1 (滑动到位)
         → opacity 0.4 (灰色, 视觉提示"能滑出但不能点").
       - calc() 表达式 specificity (0,4,0) 高于基类 (0,2,1) 的 var(...),
         自然胜出, !important 不再需要.
       - pointer-events / cursor / filter 保持不变 (交互层仍 inert). */
  .bill-swipe-action.disabled {
    opacity: calc(var(--swipe-progress, 0) * 0.4);
    cursor: not-allowed;
    pointer-events: none;
    filter: grayscale(40%);
  }
  /* 同样禁掉 hover/focus 反馈,避免误导用户以为能点。
     v0.3.18 #51: 仍保留 !important — glass-pill--delete/--edit 自己的
     :hover rule (line 953/973) specificity (0,2,1) 高于这里 (0,2,0),
     不加 !important 会被那两个 modifier 覆盖回来, 误导用户以为能点.
     想完全干掉 hover 反馈必须 !important. */
  .bill-swipe-action.disabled:hover {
    background: linear-gradient(
      135deg,
      rgba(220, 38, 38, 0.10) 0%,
      rgba(239, 68, 68, 0.08) 100%
    ) !important;
    border-color: rgba(220, 38, 38, 0.22) !important;
    color: var(--error-700, #be123c) !important;
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
       跟 .day-group 共享同一 surface 背景色 ===
       v0.3.18 #46-A: padding vertical 8px → 10px (给玻璃 hairline 视觉呼吸感) */
  .bill-row {
    position: relative;
    z-index: 1;
    /* 删除 background: white — 让 day-group 背景透出 */
    padding: 10px var(--space-4);
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

  /* v0.3.20 #92 (PO msg 07:13 #7409): bill-row2 拆成 .bill-row-exclusive + .bill-row3 —
     - .bill-row-exclusive: 独占金额行 (可选, 仅 billExclusiveTotal(b) > 0 时渲染)
     - .bill-row3: 人数 + 时间 + 谁付款 (左) + 分摊 (右, space-between)
     两行都跟 .bill-row1 同 font-size, muted 颜色, 视觉连贯. */
  .bill-row-exclusive {
    margin-top: 2px;
    font-size: var(--font-size-sm);
    color: #94a3b8;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .bill-row-exclusive .unit {
    margin-left: 2px;
    font-size: var(--font-size-xs, 12px);
    color: #94a3b8;
    font-weight: 500;
    letter-spacing: 0.04em;
  }
  .bill-row3 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 2px;
    font-size: var(--font-size-sm);
  }
  .bill-meta-left {
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 0 1 auto;
  }
  .bill-meta-text {
    min-width: 0;
    flex: 0 1 auto;
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
    /* UAT v0.3.23 #129: color black (was blue accent-500) per PO */  
    /* v0.3.28 UAT 0724-2 #9: 600→400, 分摊文字和金额不加粗 */  
    font-weight: 400;
    color: var(--gray-900); /* UAT v0.3.23 #129 */  
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  /* v0.3.20 #93 (PO msg 00:04 #7450, Fix 5): chevron collapse/expand flip.
     Collapsed (default): single right chevron (matches existing).
     Expanded (details[open]): down chevron.
     Text content of .day-chevron is empty; pseudo-element renders the char. */
  .day-chevron {
    position: relative;
    display: inline-block;
    width: 14px;
    height: 14px;
    line-height: 14px;
    text-align: center;
    font-size: 14px;
    font-weight: 600;
    color: var(--gray-500, #737373);
    flex-shrink: 0;
  }
  .day-chevron::before {
    content: "\203A"; /* single right chevron, collapsed state */
  }
  /* v0.3.20 #93 (Fix 5 v2): dropped .day-chevron.open::before fallback
     (Svelte flags as unused since open class only set via runtime JS classList.toggle,
     but parent's details[open] selector covers same use case visually). */
  details[open] .day-chevron::before {
    content: "\2304"; /* down chevron, expanded state */
  }
</style>
