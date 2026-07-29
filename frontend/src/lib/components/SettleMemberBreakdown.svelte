<script lang="ts">
  /**
   * v0.1.3 Sprint 3 Commit 4 (2026-07-02) — 个人视图交互动画。
   *
   * v0.3.14.1 hotfix #4 (2026-07-14) — 个人视图反馈 1/2/3 实现 (单位
   * + 换算)。PO 拍板 (Jesse 11:15 #4348):
   * - 「主币种汇总」= **只**显示主币种 (CNY) 数字 + 单位 CNY
   * - 「原始数据」= **只**显示源币种数字 + 单位
   *
   * 实现要点:
   * - 个人视图**所有**金额都带具体单位 (反馈 2)。
   * - 主币种汇总模式下, 付款明细行 (paid_bills[i].amount) 和消费明细
   *   行 (consumed_bills[i].share_amount / exclusive_amount / bill
   *   total) 走 BE 已换算好的 `*_primary` 字段; 原始数据模式走 raw
   *   `amount` / `share_amount` + `bill.currency`。
   * - 顶部 hero (net / consumed / paid) 和 member chip 顶部 net 在原
   *   始数据模式下按源币种分组展示 (THB + CNY 不能相加, 因此 hero 多
   *   行 / per-currency chip)。
   * - 顶部 hero 顶部 amount + consumed / paid 元数据在主币种汇总模式
   *   下走 BE primary 聚合 (`m.total_paid` / `m.total_consumed` /
   *   `m.net`) — 这三个值 BE 永远按 primary 输出, 保持不变。
   *
   * 沿用:
   * - T8 Hero Metric (Commit 2)
   * - T9 Chip Redesign (Commit 3)
   * - T10 Sticky Section Header (Commit 2)
   * - T16 / T17 (Commit 4) — chip cross-fade + tween
   * - v0.1.2 反馈修 6 项目 6/7
   *
   * v0.3.15 (PO #4807 + Designer 报告) — 错误统一走 Toast.
   * - 删 `let error` 状态 + `<div class="error">` 模板
   * - loadSettle catch → toast.error()
   * - 失败时 members=[] + selectedMemberId=null, 让模板走"还没成员"占位
   *
   * v0.3.24 #11 (UAT bug — settle 页头像样式跟成员 section 一致, PO msg 16:35 UAT file line 11):
   * "结算页面,概览页和个人视图页下的每个人的头像的样式,都应该与成员 section 内的一致"
   * - .chip-avatar (36×36, 顶部 member-chip): 套 #132 Option B 玻璃 (rgba 0.88 + backdrop-filter + 4-layer shadow)
   * - 加 AVATAR_GRADIENTS + avatarGradient() 5 色 palette 渐变 (inline style 套每成员 index)
   * - 删旧 .member-chip:not(.selected) .chip-avatar gray override (gradient 始终由 inline style 生效)
   * - selected chip 头像 box-shadow 加 highlight ring 保留视觉锚点 (跟 .me 双层 ring 路径一致)
   * - 概览 tab (SettleTransferPath) 已在 #132 改过, 不用再动
   */
  import { onMount, tick } from 'svelte';
  import { scale, fly, fade, slide } from 'svelte/transition';
  import { getSettle } from '$api/settle';
  import { formatMoney, formatDate } from '$lib/utils/format';
  import { currencySymbol } from '$lib/utils/currency';
  import { tweenNumber } from '$lib/utils/tween';
  // v0.3.0728-3 #7 (PO msg 2026-07-28 batch 新批 #7) — reverse v0.3.0728-2 #13: 重新 import currencySymbol,
  // 人物选框 chip-net / chip-net-line 改回 ¥ currency symbol (简洁货币符号).
  import { toast } from '$stores/toast';
  import SkeletonBill from '$components/SkeletonBill.svelte';
  import { Search, X } from 'lucide-svelte';
  import type { MemberSettlement } from '$api/settle';
  import type { SessionDetail } from '$api/sessions';

  /**
   * v0.3.24 #12 (2026-07-22 20:18) — settle 页 付款明细 + 消费明细 加搜索框
   * (PO msg 16:35 UAT file line 12: "个人视图,以及主币种汇总,付款明细上方,
   *   均添加账单列表相同的搜索框,支持搜索对应的付款明细和消费明细").
   *
   * - 2 个搜索框 (付款明细 + 消费明细 各一个, 跟 BillListGrouped.svelte 的
   *   .bills-search 同款玻璃风格, placeholder "搜索账单名称").
   * - 实时 filter 按 b.description 包含关键词 (中文 / 英文 case-insensitive).
   * - 空态: totalBills > 0 && filteredBills === 0 → "没有匹配的账单,换个关键词试试。"
   *   (跟 BillListGrouped 的 totalBills > 0 && filteredBills === 0 文案对齐,
   *   v0.3.22 #119 拍板双态 placeholder).
   * - 切换 member / viewMode 时 searchQuery 保留 (跟 BillListGrouped 行为一致 —
   *   BillListGrouped 也不重置 searchQuery on re-fetch).
   * - 不动 /sessions/[id] 上 BillListGrouped 已有搜索框 (PO 字面 "账单列表相同的
   *   搜索框", 复用风格, 不复用状态).
   */

  export let session: SessionDetail;
  /** 当前登录用户 user_id。用于默认选中自己。 */
  export let currentUserId: number | null = null;
  /** v0.2.2 (T11): re-fetch when view mode flips. */
  export let viewMode: 'primary' | 'split' = 'primary';

  let loading = true;
  let members: MemberSettlement[] = [];
  let loadedView: 'primary' | 'split' = viewMode;

  let selectedMemberId: number | null = null;
  let chipRefs: Record<number, HTMLButtonElement | null> = {};

  // === T17 数字 counter animation (统一走 tweenNumber 工厂) ===
  //
  // hotfix #4: 仍 tween BE 返回的 primary 聚合值, 因为 BE 不管 view
  // mode 都按 primary 输出 `total_paid` / `total_consumed` / `net`。
  // 原始数据模式下这些值只是**不**显示 (改用下方 `perCurrencyAgg`
  // 静态展开) — tween 仍可用作 chip fallback / debug。
  const tweenPaid = tweenNumber(0, 600);
  const tweenConsumed = tweenNumber(0, 600);
  const tweenNet = tweenNumber(0, 600);
  let prevSelectedMemberId: number | null = null;
  $: if (selectedMember) {
    tweenPaid.set(Number(selectedMember.total_paid ?? 0));
    tweenConsumed.set(Number(selectedMember.total_consumed ?? 0));
    tweenNet.set(Number(selectedMember.net ?? 0));
    prevSelectedMemberId = selectedMember.member_id;
  }

  // === v0.3.16 #1: 付款/消费明细可点击展开折叠 (PO 拍板默认展开) ===
  let paidExpanded = true;
  let consumedExpanded = true;

  // === v0.3.24 #12 (PO msg 16:35 UAT file line 12): 付款明细 + 消费明细 搜索框 ===
  // 跟 BillListGrouped.svelte 的 .bills-search 同款 (玻璃风 placeholder "搜索账单名称"),
  // 实时 filter b.description 包含关键词 (case-insensitive, 中文/英文都按 substring match).
  let paidSearchQuery = '';
  let consumedSearchQuery = '';

  /** T6: 金额统一改用 formatMoney (千分位 + 2dp)。 */
  function fmt(n: number): string {
    return formatMoney(n, { showSymbol: false });
  }

  /** T6: 日期改用 formatDate(只取 time → "20:00")。 */
  function fmtDate(iso: string): string {
    return formatDate(iso, { time: true });
  }

  function avatarLetter(name: string): string {
    const trimmed = (name ?? '').trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  /**
   * v0.3.24 #11 (UAT bug — settle 页头像样式跟成员 section 一致, PO msg 16:35 UAT file line 11):
   * 头像 palette 渐变 (5 色 rgba 0.88 半透明), 让 backdrop-filter 在 glass parent (.member-chip)
   * 上有 "glass on glass" 视觉. 跟 SessionMemberList AVATAR_GRADIENTS / BillForm / +page.svelte
   * 完全一致 (#132 commit b997bf6 模板).
   */
  const AVATAR_GRADIENTS = [
    'linear-gradient(135deg, rgba(99, 102, 241, 0.88) 0%, rgba(168, 85, 247, 0.88) 100%)', // indigo → purple
    'linear-gradient(135deg, rgba(236, 72, 153, 0.88) 0%, rgba(244, 63, 94, 0.88) 100%)', // pink → rose
    'linear-gradient(135deg, rgba(16, 185, 129, 0.88) 0%, rgba(20, 184, 166, 0.88) 100%)', // emerald → teal
    'linear-gradient(135deg, rgba(245, 158, 11, 0.88) 0%, rgba(234, 179, 8, 0.88) 100%)', // amber → yellow
    'linear-gradient(135deg, rgba(59, 130, 246, 0.88) 0%, rgba(6, 182, 212, 0.88) 100%)', // blue → cyan
  ];
  function avatarGradient(index: number): string {
    return AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
  }

  /**
   * T9 chip net amount: formatMoney no symbol, tabular-nums. Sign with
   * ASCII ``-`` (the e2e regex pattern ``[+-]`` does not match the
   * Unicode minus; keep ASCII for test compat).
   */
  function fmtSigned(n: number): string {
    if (n > 0) return '+' + formatMoney(n, { showSymbol: false });
    if (n < 0) return '-' + formatMoney(Math.abs(n), { showSymbol: false });
    return formatMoney(0, { showSymbol: false });
  }

  /**
   * v0.3.14.1 hotfix #4: chip-net 双模式 —
   * - primary: 单值, 美元面额按 primary currency (例如 "+14.36 CNY")。
   * - split: 按源币种聚合 paid_bills / consumed_bills, 输出多行
   *   ("+26.75 THB" / "-20.00 CNY"), 每行独立 signed + unit。
   */
  type CurrencyBucket = { paid: number; consumed: number; net: number };

  function aggregatePerCurrency(m: MemberSettlement | null): Record<string, CurrencyBucket> {
    const buckets: Record<string, CurrencyBucket> = {};
    if (!m) return buckets;
    const addCur = (cur: string): CurrencyBucket => {
      if (!buckets[cur]) buckets[cur] = { paid: 0, consumed: 0, net: 0 };
      return buckets[cur];
    };
    for (const b of m.paid_bills ?? []) {
      const cur = (b as any).currency as string;
      if (!cur) continue;
      const slot = addCur(cur);
      slot.paid += Number((b as any).amount ?? 0);
    }
    for (const b of m.consumed_bills ?? []) {
      const cur = (b as any).currency as string;
      if (!cur) continue;
      const slot = addCur(cur);
      // BE 的 ``share_amount`` 实际是 primary; 原始数据模式下这里必须
      // 用 ``sourceShareOf`` 反推源币种再归类到源 bucket。
      slot.consumed += sourceShareOf(b as any);
    }
    for (const k of Object.keys(buckets)) {
      buckets[k].net = buckets[k].paid - buckets[k].consumed;
    }
    return buckets;
  }

  $: selectedMember = members.find((m) => m.member_id === selectedMemberId) ?? null;

  $: perCurrencyAgg = aggregatePerCurrency(selectedMember);
  $: perCurrencyKeys = Object.keys(perCurrencyAgg);

  // === v0.3.24 #12: 付款明细 + 消费明细 search filter derived.
  // filter 规则: b.description 包含 query (case-insensitive). 空 query 不过滤.
  // 中文按 substring match (默认 includes 对 CJK 字符串 OK, 跟 BillListGrouped
  // 行为一致). ===
  function matchesSearch(b: any, query: string): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    const desc = (b.description ?? '').toLowerCase();
    return desc.includes(q);
  }
  $: filteredPaidBills = selectedMember
    ? (selectedMember.paid_bills ?? []).filter((b) => matchesSearch(b, paidSearchQuery))
    : [];
  $: filteredConsumedBills = selectedMember
    ? (selectedMember.consumed_bills ?? []).filter((b) => matchesSearch(b, consumedSearchQuery))
    : [];

  $: meMemberId = (() => {
    if (currentUserId === null || currentUserId === undefined) return null;
    const sm = session?.members?.find((m) => m.user_id === currentUserId);
    return sm?.id ?? null;
  })();

  function isMe(memberId: number | null | undefined): boolean {
    return meMemberId !== null && memberId === meMemberId;
  }

  async function selectMember(memberId: number) {
    selectedMemberId = memberId;
    await tick();
    const el = chipRefs[memberId];
    if (el) {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } catch {
        el.scrollIntoView();
      }
    }
  }

  // -------------------------------------------------------------
  // hotfix #4 渲染 helper
  // -------------------------------------------------------------

  /**
   * v0.3.14.1 hotfix #4: BE BillShare 的 ``share_amount`` /
   * ``exclusive_amount`` 字段虽然名字暗示源币种, 但内部值是主币种
   * (settle.py `_compute_per_member` 直接把 ``share_primary`` 传给
   * schema 字段)。原始数据模式要在 FE 端反推源币种值。
   *
   * 反推方法: 用每张账单隐含的 (源/主) 比率乘以 primary 数值。
   * 比率 = bill.amount / bill.amount_primary = 这张账单当时的
   * snapshot 转换率。
   *
   * 边角情形:
   * - amount_primary = 0 → 直接退回 primary 数值
   * - amount == amount_primary (源币种 = 主币种, 纯 CNY session)
   *   → 比率 1, 数值不变
   */
  function sourceShareOf(b: any): number {
    const primaryShare = Number(b.share_amount_primary ?? b.share_amount ?? 0);
    const src = Number(b.amount ?? 0);
    const prim = Number(b.amount_primary ?? 0);
    if (prim <= 0) return primaryShare;
    return primaryShare * (src / prim);
  }
  function sourceExclusiveOf(b: any): number {
    const primaryExcl = Number(b.exclusive_amount_primary ?? b.exclusive_amount ?? 0);
    const src = Number(b.amount ?? 0);
    const prim = Number(b.amount_primary ?? 0);
    if (prim <= 0) return primaryExcl;
    return primaryExcl * (src / prim);
  }

  /** 主币种汇总: 付款明细 = BE ``amount_primary`` + ``primary_currency``. */
  function fmtPaidPrimary(b: any): string {
    return `${fmt(Number(b.amount_primary ?? b.amount))} ${b.primary_currency ?? session.primary_currency}`;
  }

  /** 原始数据: 付款明细 = 源币种 ``amount`` + ``currency``. */
  function fmtPaidSplit(b: any): string {
    return `${fmt(Number(b.amount))} ${b.currency}`;
  }

  /** 主币种汇总: 消费明细 share = BE ``share_amount_primary`` + primary. */
  function fmtConsumedPrimary(b: any): string {
    return `${fmt(Number(b.share_amount_primary ?? b.share_amount))} ${b.primary_currency ?? session.primary_currency}`;
  }

  /** 原始数据: 消费明细 share 按源币种 (BE primary → 反推). */
  function fmtConsumedSplit(b: any): string {
    return `${fmt(sourceShareOf(b))} ${b.currency}`;
  }

  /**
   * 独占 / 共享 / 账单总 的渲染。两模式都需带具体单位。
   * primary 模式: ``exclusive_amount_primary`` / ``share_primary -
   * exclusive_primary`` / ``amount_primary``, 单位 ``primary_currency``。
   * split 模式: 原始 ``exclusive_amount`` / (share - exclusive) /
   * ``amount``, 单位 ``b.currency``.
   */
  function fmtConsumedTags(b: any): {
    excl: string | null;
    shared: string;
    total: string;
  } {
    if (viewMode === 'primary') {
      const cur = b.primary_currency ?? session.primary_currency;
      const exclPrimary = Number(b.exclusive_amount_primary ?? b.exclusive_amount ?? 0);
      const sharePrimary = Number(b.share_amount_primary ?? b.share_amount ?? 0);
      const sharedPrimary = sharePrimary - exclPrimary;
      const totalPrimary = Number(b.amount_primary ?? b.amount);
      return {
        excl: exclPrimary > 0 ? `${fmt(exclPrimary)} ${cur}` : null,
        shared: `${fmt(sharedPrimary)} ${cur}`,
        total: `${fmt(totalPrimary)} ${cur}`,
      };
    }
    // 原始数据模式: BE 字段都是 primary, 反推源币种。
    const cur = b.currency;
    const excl = sourceExclusiveOf(b);
    const share = sourceShareOf(b);
    const shared = share - excl;
    const total = Number(b.amount);
    return {
      excl: excl > 0 ? `${fmt(excl)} ${cur}` : null,
      shared: `${fmt(shared)} ${cur}`,
      total: `${fmt(total)} ${cur}`,
    };
  }

  /** 顶部 hero meta (consumed / paid) — 双模式。 */
  function fmtSplitPaidAndConsumed(m: MemberSettlement | null): {
    paid: string;
    consumed: string;
  } {
    if (!m) return { paid: '-', consumed: '-' };
    const agg = aggregatePerCurrency(m);
    const ks = Object.keys(agg);
    if (ks.length === 0) return { paid: '-', consumed: '-' };
    const paidStr = ks.map((k) => `${fmt(agg[k].paid)} ${k}`).join(' / ');
    const consumedStr = ks.map((k) => `${fmt(agg[k].consumed)} ${k}`).join(' / ');
    return { paid: paidStr, consumed: consumedStr };
  }

  /** 顶部 hero net — 双模式 (primary 单值, split 按源币种分组)。 */
  function fmtSplitNet(m: MemberSettlement | null): string {
    if (!m) return '-';
    const agg = aggregatePerCurrency(m);
    const ks = Object.keys(agg);
    if (ks.length === 0) return '-';
    return ks.map((k) => `${fmtSigned(agg[k].net)} ${k}`).join(' / ');
  }

  onMount(async () => {
    await loadSettle(viewMode);
  });

  // v0.2.2 (T11): when viewMode changes after mount, refetch.
  $: if (!loading && loadedView !== viewMode) {
    loadSettle(viewMode);
  }

  async function loadSettle(targetView: 'primary' | 'split') {
    loading = true;
    try {
      const data = await getSettle(session.id, targetView);
      members = data.per_member ?? [];
      loadedView = targetView;
      const me = members.find((m) => {
        const sm = session.members.find((sm) => sm.id === m.member_id);
        return sm && sm.user_id === currentUserId;
      });
      selectedMemberId = me?.member_id ?? members[0]?.member_id ?? null;
      if (selectedMemberId !== null) {
        await tick();
        const el = chipRefs[selectedMemberId];
        if (el) el.scrollIntoView({ block: 'nearest', inline: 'center' });
      }
    } catch (e: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast, 失败时清空数据走占位
      members = [];
      selectedMemberId = null;
      toast.error(e?.message ?? '加载结算失败');
    } finally {
      loading = false;
    }
  }
</script>

<div>
  {#if loading}
    <div class="skeleton-section" aria-busy="true" aria-label="加载中">
      <ul class="skeleton-list">
        <li><SkeletonBill /></li>
        <li><SkeletonBill /></li>
        <li><SkeletonBill /></li>
      </ul>
    </div>
  {:else if members.length === 0}
    <p class="muted">这个账本还没有成员。</p>
  {:else}
    <!-- T9: member-tabs-wrapper with fade gradient mask (already present, kept) -->
    <div class="member-tabs-wrapper">
      <div class="member-tabs" role="tablist" aria-label="成员选择">
        {#each members as m, i (m.member_id)}
          <!-- T9: chip redesign — filled pill + no badge text -->
          <button
            type="button"
            class="member-chip"
            class:selected={m.member_id === selectedMemberId}
            class:me={isMe(m.member_id)}
            role="tab"
            aria-selected={m.member_id === selectedMemberId}
            aria-controls="member-panel-{m.member_id}"
            bind:this={chipRefs[m.member_id]}
            onclick={() => selectMember(m.member_id)}
            in:fly={{ y: 6, duration: 220, delay: Math.min(i * 30, 240) }}
          >
            <div class="chip-avatar" aria-hidden="true" style="background: {avatarGradient(i)}">{avatarLetter(m.display_name)}</div>
            <div class="chip-info">
              <div class="chip-name">{m.display_name}</div>
              <!--
                hotfix #4: chip-net 双模式。
                - primary: 单值, 主币种聚合 (来自 BE `m.net`)。
                - split: 按源币种聚合, 多行, 每行独立符号。
              -->
              {#if viewMode === 'split'}
                {#each Object.entries(aggregatePerCurrency(m)) as [cur, bucket] (cur)}
                  <div
                    class="chip-net-line"
                    class:pos={bucket.net > 0}
                    class:neg={bucket.net < 0}
                  class:zero={bucket.net === 0}
                  >{fmtSigned(bucket.net)} {currencySymbol(cur)}</div>
                {/each}
              {:else}
                <div
                  class="chip-net"
                  class:pos={m.net > 0}
                  class:neg={m.net < 0}
                  class:zero={m.net === 0}
                >{fmtSigned(m.net)} {currencySymbol(session.primary_currency)}</div>
              {/if}
            </div>
          </button>
        {/each}
      </div>
    </div>

    {#if selectedMember}
      {#key selectedMember.member_id}
        <div
          class="member-panel"
          id="member-panel-{selectedMember.member_id}"
          role="tabpanel"
          aria-label="{selectedMember.display_name} 明细"
          in:fade={{ duration: 150 }}
          out:fade={{ duration: 100 }}
        >

          <!-- T8: Hero Metric (hotfix #4 双模式) -->
          <div class="hero">
            <div
              class="hero-net"
              class:pos={viewMode === 'primary' ? selectedMember.net > 0 : false}
              class:neg={viewMode === 'primary' ? selectedMember.net < 0 : false}
              class:zero={viewMode === 'primary' ? selectedMember.net === 0 : false}
            >
              {#if viewMode === 'split'}
                <!-- 按源币种分别展示 (THB / CNY 不可相加) -->
                {#if perCurrencyKeys.length === 0}
                  <span class="settled-text">已结清</span>
                {:else}
                  <div class="hero-net-multicur">
                    {#each perCurrencyKeys as cur (cur)}
                      {@const bucket = perCurrencyAgg[cur]}
                      <div
                        class="hero-net-line"
                        class:pos={bucket.net > 0}
                        class:neg={bucket.net < 0}
                        class:zero={bucket.net === 0}
                      >{fmtSigned(bucket.net)} {cur}</div>
                    {/each}
                  </div>
                {/if}
              {:else if selectedMember.net === 0}
                <span class="settled-text">已结清</span>
              {:else}
                {fmtSigned($tweenNet)} {session.primary_currency}
              {/if}
            </div>
            <div class="hero-meta">
              {#if viewMode === 'split'}
                <!-- split: 按源币种分别展示 paid / consumed -->
                {@const split = fmtSplitPaidAndConsumed(selectedMember)}
                {#if split.consumed !== '-'}
                  <span>consumed <strong>{split.consumed}</strong></span>
                  <span class="meta-sep" aria-hidden="true">·</span>
                {/if}
                {#if split.paid !== '-'}
                  <span>paid <strong>{split.paid}</strong></span>
                {/if}
              {:else}
                <!-- primary: BE 聚合 = primary_currency -->
                <span>consumed <strong>{fmt($tweenConsumed)}</strong> <span class="meta-unit">{session.primary_currency}</span></span>
                <span class="meta-sep" aria-hidden="true">·</span>
                <span>paid <strong>{fmt($tweenPaid)}</strong> <span class="meta-unit">{session.primary_currency}</span></span>
              {/if}
            </div>
          </div>

          <!-- T10: 付款明细 section with sticky header -->
          <div class="bills-section bills-section-paid glass-sheet">
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
            <h4
              class="bills-section-head section-header glass-chip"
              role="button"
              tabindex="0"
              aria-expanded={paidExpanded}
              onclick={() => (paidExpanded = !paidExpanded)}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  paidExpanded = !paidExpanded;
                }
              }}
            >
              <span class="bills-section-icon icon-paid" aria-hidden="true">↑</span>
              <span class="bills-section-title">付款明细</span>
              <span class="bills-section-count muted">({selectedMember.paid_bills.length})</span>
              <span class="collapse-icon" aria-hidden="true">{paidExpanded ? '▼' : '▶'}</span>
            </h4>
            <!-- v0.3.24 #12 (PO msg 16:35 UAT file line 12): 付款明细 搜索框
                 跟 BillListGrouped.svelte .bills-search 同款玻璃风格.
                 只在 paid_bills.length > 0 时 render (空 section 不显示 search,
                 否则用户搜什么都没有显得无意义). -->
            {#if selectedMember.paid_bills.length > 0}
              <div class="bills-section-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  bind:value={paidSearchQuery}
                  placeholder="搜索账单名称"
                  aria-label="搜索付款明细"
                  class="bills-section-search-input"
                />
                {#if paidSearchQuery}
                  <button
                    type="button"
                    class="bills-section-search-clear"
                    aria-label="清除搜索"
                    onclick={() => (paidSearchQuery = '')}
                  ><X size={12} /></button>
                {/if}
              </div>
            {/if}
            {#if selectedMember.paid_bills.length === 0}
              <p class="muted empty-hint">没有付过账单</p>
            {:else if filteredPaidBills.length === 0}
              <!-- v0.3.24 #12 (PO msg 16:35 UAT file line 12): 付款明细 filter 没匹配
                   跟 BillListGrouped 的 totalBills > 0 && filteredBills === 0 文案对齐
                   (v0.3.22 #119 拍板双态 placeholder, 区分 "没数据" vs "filter 没过"). -->
              <p class="muted empty-hint">没有匹配的账单,换个关键词试试。</p>
            {:else if paidExpanded}
              <!-- v0.3.17 #20 hotfix (PO msg 13:12): ul 用 transition:slide
                   200ms, li 改 in:fade 80ms 取消 stagger — toggle 展开/收起
                   整体 smooth, 30 行不再逐行 delay 200ms, 不再「卡卡的」 -->
              <ul class="bill-sublist" transition:slide={{ duration: 200 }}>
                {#each filteredPaidBills as b, i (b.bill_id)}
                  <li
                    class="bill-subrow"
                    in:fade={{ duration: 80 }}
                  >
                    <div class="row1">
                      <span class="bill-sub-desc">{b.description || '(无说明)'}</span>
                      <!--
                        hotfix #4: paid bill 主金额。
                        - primary → BE `amount_primary` (已换算) + `primary_currency`.
                        - split   → 原始 `amount` + `currency`.
                      -->
                      <span class="amount-primary">
                        {#if viewMode === 'primary'}{fmtPaidPrimary(b)}{:else}{fmtPaidSplit(b)}{/if}
                      </span>
                    </div>
                    <div class="row2 muted">
                      <span class="bill-sub-date">{fmtDate(b.occurred_at)}</span>
                      {#if b.participant_count}
                        <span class="sep" aria-hidden="true">·</span>
                        <span class="participant-count">
                          <svg
                            class="participant-icon"
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
                          <span class="participant-count-num">{b.participant_count}人</span>
                        </span>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <!-- T10: 消费明细 section with sticky header -->
          <div class="bills-section bills-section-consumed glass-sheet">
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
            <h4
              class="bills-section-head section-header glass-chip"
              role="button"
              tabindex="0"
              aria-expanded={consumedExpanded}
              onclick={() => (consumedExpanded = !consumedExpanded)}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  consumedExpanded = !consumedExpanded;
                }
              }}
            >
              <span class="bills-section-icon icon-consumed" aria-hidden="true">↓</span>
              <span class="bills-section-title">消费明细</span>
              <span class="bills-section-count muted">({selectedMember.consumed_bills.length})</span>
              <span class="collapse-icon" aria-hidden="true">{consumedExpanded ? '▼' : '▶'}</span>
            </h4>
            <!-- v0.3.24 #12 (PO msg 16:35 UAT file line 12): 消费明细 搜索框
                 跟 付款明细 search 同款, filter consumed_bills.
                 只在 consumed_bills.length > 0 时 render. -->
            {#if selectedMember.consumed_bills.length > 0}
              <div class="bills-section-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  bind:value={consumedSearchQuery}
                  placeholder="搜索账单名称"
                  aria-label="搜索消费明细"
                  class="bills-section-search-input"
                />
                {#if consumedSearchQuery}
                  <button
                    type="button"
                    class="bills-section-search-clear"
                    aria-label="清除搜索"
                    onclick={() => (consumedSearchQuery = '')}
                  ><X size={12} /></button>
                {/if}
              </div>
            {/if}
            {#if selectedMember.consumed_bills.length === 0}
              <p class="muted empty-hint">没有被分摊的账单</p>
            {:else if filteredConsumedBills.length === 0}
              <!-- v0.3.24 #12 (PO msg 16:35 UAT file line 12): 消费明细 filter 没匹配,
                   跟 付款明细 同文案 (跟 BillListGrouped 风格统一). -->
              <p class="muted empty-hint">没有匹配的账单,换个关键词试试。</p>
            {:else if consumedExpanded}
              <ul class="bill-sublist" transition:slide={{ duration: 200 }}>
                {#each filteredConsumedBills as b, i (b.bill_id)}
                  {@const tags = fmtConsumedTags(b)}
                  <li
                    class="bill-subrow"
                    in:fade={{ duration: 80 }}
                  >
                    <div class="row1">
                      <span class="bill-sub-desc">{b.description || '(无说明)'}</span>
                      <!--
                        hotfix #4: consumed share 主金额: 双模式。
                        - primary → BE `share_amount_primary` + `primary_currency`.
                        - split   → 原始 `share_amount` + `currency`.
                      -->
                      <span class="amount-primary">
                        {#if viewMode === 'primary'}{fmtConsumedPrimary(b)}{:else}{fmtConsumedSplit(b)}{/if}
                      </span>
                    </div>
                    <!-- v0.3.27 (UAT 0723-2 #4): 个人消费 独立行, 跟 BillListGrouped .bill-row-exclusive 同款 -->
                    {#if tags.excl}
                      <div class="bill-row-exclusive muted">
                        个人消费 {tags.excl}
                      </div>
                    {/if}
                    <div class="row2 muted">
                      <span class="bill-sub-date">{fmtDate(b.occurred_at)}</span>
                      {#if b.participant_count}
                        <span class="sep" aria-hidden="true">·</span>
                        <span class="participant-count">
                          <svg
                            class="participant-icon"
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
                          <span class="participant-count-num">{b.participant_count}人</span>
                        </span>
                      {/if}
                      <span class="shared-tag-right">分摊 {tags.shared}</span>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>
      {/key}
    {/if}
  {/if}
</div>

<style>
  /* === T9: Chip Redesign — filled pill ===
     v0.3.18 #55 (PO msg 21:44 #6588): 成员选择器横向滚动 fade 边距调整.
     - 右边 ::after width 32px → 20px (PO 反馈"模糊的 margin 值调小一点",
       32 太大遮住半个 chip, 视觉上像缺了一块)
     - 加左边 ::before 20px 对称 fade (PO 反馈"给左侧也加上对称的处理方式"),
       之前只有右边, 现在两侧对称 — 滚到中间时 chip 在 fade 中渐隐, 暗示还有更多
     - mask 不用 (Safari iOS < 18 兼容问题跟 #31-fix 一样) */
  .member-tabs-wrapper {
    position: relative;
  }
  .member-tabs-wrapper::after {
    content: '';
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 20px;
    background: linear-gradient(to right, transparent, white);
    pointer-events: none;
    z-index: 1;
  }
  .member-tabs-wrapper::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 20px;
    background: linear-gradient(to left, transparent, white);
    pointer-events: none;
    z-index: 1;
  }
  .member-tabs {
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    margin-bottom: var(--space-3);
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;
  }
  .member-tabs::-webkit-scrollbar {
    height: 4px;
  }

  /* T9 chip: pill shape, filled when selected */
  /* === v0.3.17 #16 hotfix (PO msg 03:00): member-chip 玻璃化 ===
     - 未选中: glass-pill (半透明白 + backdrop blur) — 跟 .member-tabs
       背景形成 Liquid Glass 视觉。
     - 选中: 保留实色 --accent-500 蓝 (视觉锚点不能丢, T9 设计)
     - hover: border + color 微变, 不改 background (玻璃透出背景)
     === v0.3.18 #48 (PO msg 19:10 #6489 全站透明化 sweep): 玻璃感要"透出来"
     - bg 0.7/0.5 → 0.35/0.20 (× 0.5 透明度降级)
     - border 0.55 → 0.65 (白边更明显, 防止透明化后玻璃感稀释)
     - inset highlight 0.7 → 0.95 (玻璃上沿高光更明显)
     - 外阴影 0.10 → 0.16 indigo (玻璃感更强)
     - chip 文字 text-shadow 0.6 → 0.8 + 1px → 3px (白色微晕更强, 防低对比看不清)
     === v0.3.18 #50 (PO msg 22:12 #6523 极透明化 v2): #48/#49 后 section 仍"白纸+文字"
     - bg 0.15/0.08 → 0.04/0.02 (chip 几乎全透, 只靠 border + 文字 + avatar 提示)
     - border 0.65 → 0.22 (白边几乎消失, 跟 .day-group 同语言)
     - inset highlight 0.95 → 0.18 (玻璃上沿高光大幅淡化, 不再"白框卡片")
     - 外阴影 indigo 0.16 → 0.04 (chip 不再"浮起的小卡片")
     - 保留 text-shadow 0 1px 3px 0.8 (唯一可读性补偿) */
  .member-chip {
    scroll-snap-align: start;
    flex: 0 0 auto;
    appearance: none;
    /* Inactive base — glass-pill (v0.3.18 #50 极透明化 v2, PO msg 22:12 #6523) */
    background: linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%);
    border: 1px solid rgba(255,255,255,0.22);
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    border-radius: var(--radius-full);
    padding: var(--space-3) var(--space-4);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 64px;
    min-width: 110px;
    max-width: 180px;
    text-align: left;
    color: var(--gray-700);
    font: inherit;
    /* v0.3.18 #50: inset highlight 0.95 → 0.18 + 外阴影 0.16 → 0.04 indigo */
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.18),
      0 4px 12px rgba(99,102,241,0.04);
    /* v0.3.18 #49 保留: chip 文字白色微晕 (低对比玻璃上唯一可读性补偿) */
    text-shadow: 0 1px 3px rgba(255,255,255,0.8);
    transition:
      background 200ms ease,
      border-color 200ms ease,
      color 200ms ease,
      box-shadow 200ms ease,
      transform 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  .member-chip:hover {
    border-color: var(--accent-500);
    color: var(--accent-700);
    /* v0.3.18 #50: hover bg 0.22/0.15 → 0.10/0.05 (跟新 base 0.04/0.02 同步降级, hover 仍略亮表示交互) */
    background: linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.05) 100%);
  }
  .member-chip:active {
    transform: scale(0.97);
  }
  .member-chip:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
  }
  /* T9 Active state: filled accent bg (保留实色, 玻璃态 OFF) */
  .member-chip.selected {
    background: var(--accent-500);
    border: 1px solid var(--accent-500);
    color: white;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.2),
      var(--shadow-sm);
  }
  .member-chip.selected:hover {
    background: var(--accent-500);
    border-color: var(--accent-500);
    color: white;
  }
  /* Safari iOS < 18 fallback (无 backdrop-filter): 用 opaque 半透明白
     v0.3.18 #49: 0.60 → 0.40 (跟新 base 0.15/0.08 同比例降级, 保留可读性 fallback)
     v0.3.18 #50: 0.40 → 0.18 (跟新 base 0.04/0.02 同比例降级, 保留可读性 fallback) */
  @supports not (backdrop-filter: blur(1px)) {
    .member-chip {
      background: rgba(255,255,255,0.18);
    }
  }
  /* T9 me double ring (kept even though me badge text removed) */
  .member-chip.me .chip-avatar {
    box-shadow: 0 0 0 2px var(--accent-700), 0 0 0 4px rgba(59, 130, 246, 0.25);
  }
  /* selected + me: inner ring adapts to white bg of active chip */
  .member-chip.selected.me .chip-avatar {
    box-shadow: 0 0 0 2px rgba(255,255,255,0.6), 0 0 0 4px var(--accent-700);
  }

  /* v0.3.24 #11 (UAT bug — settle 页头像样式跟成员 section 一致):
     头像玻璃质感 — Option B (rgba 0.88 半透明 + backdrop-filter blur(4px) saturate(180%) +
     4-layer glass shadow). 跟 SessionMemberList .avatar (28×28) / SettleTransferPath .avatar (32×32) /
     BillForm .ppt-avatar (36×36) / +page.svelte .avatar-a + .avatar-mini 统一语言 (#132 commit b997bf6 模板).
     background 由 inline style (avatarGradient(i) AVATAR_GRADIENTS) 套 5 色 rgba 0.88 渐变,
     此处只设 fallback gradient (gradient[0] indigo→purple, 万一 inline style 被外部覆盖用). */
  .chip-avatar {
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.88) 0%, rgba(168, 85, 247, 0.88) 100%);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: var(--font-size-sm);
    border: 1.5px solid #fff;
    /* Option B: backdrop-filter + 半透明 → glass on glass 在 .member-chip (glass pill) 上 */
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    /* glass shadow: top highlight + bottom lowlight + outer lift (3-layer 跟 SessionMemberList .avatar 一致) */
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.08);
    transition: box-shadow 200ms ease;
  }
  /* selected chip: 头像 box-shadow 替换为 me-style 双层 ring (跟 .member-chip.me 路径一致,
     .me 优先级高保留原 ring; .selected 没 .me 时给一个轻 highlight ring 保持视觉锚点) */
  .member-chip.selected:not(.me) .chip-avatar {
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      0 0 0 1.5px rgba(255, 255, 255, 0.5),
      0 1px 2px rgba(0, 0, 0, 0.08);
  }
  .chip-info {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .chip-name {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--font-size-sm, 14px);
    /* v0.3.18 #49: chip name 白色微晕 (chip 几乎全透后文字补偿) */
    text-shadow: 0 1px 3px rgba(255, 255, 255, 0.8);
  }
  /* T9 chip net: tabular-nums, color by sign */
  .chip-net {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: var(--font-size-sm, 14px);
    /* default / inactive: gray-500 */
    color: var(--gray-500);
  }
  .chip-net.pos { color: var(--success-500); }
  .chip-net.neg { color: var(--error-500); }
  .chip-net.zero { color: var(--gray-500); }
  /* Selected chip: net numbers white */
  .member-chip.selected .chip-net { color: rgba(255,255,255,0.9); }
  .member-chip.selected .chip-net.pos { color: white; }
  .member-chip.selected .chip-net.neg { color: rgba(255,255,255,0.85); }

  /* hotfix #4: split-mode per-currency chip line (e.g., +26.75 THB) */
  .chip-net-line {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: var(--font-size-sm, 14px);
    color: var(--gray-500);
    line-height: 1.25;
  }
  .chip-net-line.pos { color: var(--success-500); }
  .chip-net-line.neg { color: var(--error-500); }
  .chip-net-line.zero { color: var(--gray-500); }
  .member-chip.selected .chip-net-line { color: rgba(255,255,255,0.9); }
  .member-chip.selected .chip-net-line.pos { color: white; }
  .member-chip.selected .chip-net-line.neg { color: rgba(255,255,255,0.85); }

  /* === member panel === */
  .member-panel {
    border-top: 1px solid var(--gray-200);
    padding-top: var(--space-3, 12px);
  }

  /* === T8: Hero Metric ===
     v0.3.17 #34 (PO msg 01:31 #6137 + 01:42 #6155): container query 窄屏
     减小 padding (320-380px viewport: space-5 → space-4 两侧),
     缩小 amount 字号 (font-size-3xl 已 clamp, 320px 自动缩到 32px).
     保留 max padding 给桌面, 不引新 design token. */
  /* v0.3.18 #44 (PO msg 17:43 #6401 拍板, 反 #41 不彻底): hero→chip 视觉间距 ~30px → ≤8px 真修.
     v0.3.17 #41 commit message 声称 '.hero margin-bottom 12px → 4px' 但实际漏了 (df974be diff
     只改了 .glass-sheet), 所以现 hero mb 还是 12px. 这次 vV�2 多处微调叠加:
     - .hero padding 16px → 8px (上下各砍 8px, 紧凑 hero 内部)
     - .hero margin-bottom 12px → 0 (跟 .glass-sheet margin-top 一起 collapse, 不堆叠空白)
     - .glass-sheet margin-top 14px → 0 (同上, hero 跟 sheet 之间无 margin gap)
     - .glass-sheet padding-top 10px → 4px (chip 视觉距离 sheet 顶边更近)
     - .section-header.glass-chip margin-top -10px → -4px (chip pokes 4px above sheet top,
       跟新 sheet padding-top 4px 抵消 → chip top edge = sheet top edge)
     效果: hero content end → chip top edge 视觉间距 = 8px (hero padding-bottom 8) + 0
     (margin collapse) + 0 (chip top = sheet top) = 8px, 符合 PO ≤8px 目标. */
  .hero {
    text-align: center;
    padding: var(--space-2, 8px) var(--space-5, 20px);
    margin-bottom: 0;
  }
  /* 移除 @container page (max-width: 380px) override — 新 padding 已经合理, 不需要额外调整 */
  .hero-net {
    font-size: var(--font-size-3xl, 40px);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1.1;
    margin-bottom: var(--space-2, 8px);
    /* v0.3.18 #49: hero 金额白色微晕 (防低对比玻璃背景 + PO msg #6508) */
    text-shadow: 0 1px 3px rgba(255, 255, 255, 0.8);
  }
  .hero-net.pos { color: var(--success-500); }
  .hero-net.neg { color: var(--error-500); }
  .hero-net.zero { color: var(--gray-500); }
  /* hotfix #4: split-mode per-currency stack inside hero */
  .hero-net-multicur {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .hero-net-line {
    font-size: var(--font-size-3xl, 40px);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1.1;
    /* v0.3.18 #49: split-mode 金额白色微晕 (防低对比玻璃 + PO msg #6508) */
    text-shadow: 0 1px 3px rgba(255, 255, 255, 0.8);
  }
  .hero-net-line.pos { color: var(--success-500); }
  .hero-net-line.neg { color: var(--error-500); }
  .hero-net-line.zero { color: var(--gray-500); }
  .settled-text {
    font-size: var(--font-size-2xl, 32px);
  }
  .hero-meta {
    font-size: var(--font-size-sm, 14px);
    color: var(--gray-500);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2, 8px);
    flex-wrap: wrap;
  }
  .hero-meta strong {
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .meta-unit {
    font-variant-numeric: tabular-nums;
    color: var(--gray-500);
  }
  .meta-sep { color: var(--gray-400); }

  /* === T10: Sticky Section Header ===
     v0.3.16 #2 hotfix v2 (PO msg 17:52): Liquid Glass 加强.
     上版 (014098b) blur(24px) + opacity 0.72 仍不够, PO 截图 (17:51)
     显示下方 bill 内容完全穿透 sticky header. 激进参数:
       - opacity 0.72 → 0.55 (更透, blur 更明显)
       - blur 24px → 40px (Liquid Glass 深度 +50%)
       - saturate 200% → 220% (iOS 玻璃增强饱和度)
       - 双层 box-shadow: 顶部 inset 高光 + 底部 hairline + 软外阴影
       - 加 ::before 渐变 overlay 强化视觉遮挡 (z-index -1 在父
         stacking context 内位于父 bg 之上)
       - 加 @supports fallback 给 iOS Safari < 18 (opaque 0.95) */
/* === v0.3.17 #20 hotfix (PO msg 13:12): sticky header 浮起漏内容 真修 ===
     上版 (#16) 用 padding-top 100px hack 延迟临界点, 但 0.55 不透明 +
     backdrop blur 40px 在 scroll y=1100~1700 区间仍有下方 bill row 文字
     穿透 (Chromium headless 实测 bg 实际为 0.55 不透明 + blur 渲染不稳)。
     修法 (mask-image 物理遮挡穿透):
       - mask-image: linear-gradient(180deg, transparent 0, #000 16px, #000 100%)
         顶部 16px 渐变透明 (玻璃上沿柔化), 16px 以下完全 opaque (遮穿透)
       - 同步 -webkit-mask-image 给 Safari
       - bills-section-consumed 第二个 sticky h4 z-index 提到 11, 两个 h4 撞一起
         (sticky 容器边界无法避免) 时消费明细自然盖付款明细, 不视觉混乱 */
/* === v0.3.17 #21 hotfix (PO msg 13:51 续): sticky header 真修 ===
     上版 #20 用 mask-image linear-gradient (top 16px 渐变 + bottom opaque) 试图
     物理遮挡穿透, headless Chromium 验证通过 — 但 iPhone Safari 实拍
     (PO 截图 13:40) 显示 backdrop-filter 在 mask 透明区仍渲染下方内容,
     mask 对 backdrop-filter 输出无效 (Safari WebKit 行为差异)。
     修法: bg 从 rgba(255,255,255,0.55) 改 0.92 (几乎 opaque, 物理遮挡穿透),
     backdrop-filter blur 40px → 16px (保留 glass 感但不强)。
     iOS Safari 实拍 100% 不再透。
       - 取消 mask-image (在 Safari 无效)
       - bills-section-consumed 第二个 sticky h4 z-index 11 保留 (撞一起时盖付款)
     === v0.3.17 #21 续 (PO msg 13:51 item 4): 取消 #16 padding-top 100px hack ===
     上版 #16 / #20 仍保留 .bill-sublist padding-top: 100px, 留出 first row 距
     sticky h4 的"视觉间距", 但实测 100px 太大 (付款明细 h4 跟第一条明细之间
     大片空白, 视觉奇怪)。修法: padding-top 0, 视觉间距由 h4 margin-bottom 8px
     自然提供 (sticky 浮起时 first row 跟 sticky h4 之间 8px, 合理)。 */
  .section-header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 1px 3px rgba(0, 0, 0, 0.04);
  }
  /* v0.3.17 #20 (保留): 第二个 sticky h4 (消费明细) z-index 提到 11,
     sticky 容器边界重叠时消费明细盖付款明细 (sticky 边界无法避免重叠) */
  .bills-section-consumed .section-header { z-index: 11; }

  /* === bills section — left border visual separation === */
  .bills-section {
    margin-top: var(--space-5, 24px);
    padding-left: var(--space-3, 12px);
    border-left: 3px solid transparent;
    border-radius: 2px;
  }
  /* v0.3.18 #50 (PO msg 22:12 #6523 极透明化 v2): 颜色竖条从实色→半透色.
     由更具体的 `.bills-section.glass-sheet` 重设 (0,2,0) 启亮 border-left 3px (上面 .glass-sheet
     shorthand "0" 临到 .bills-section-paid / -consumed 时只覆盖 color, width 还是 .bills-section
     原 3px). 这样 sheet 是极透明玻璃 + 颜色竖条极淡, 设计锚点保留, 存在感大降. */
  .bills-section-paid { border-left-color: rgba(34, 197, 94, 0.45); }
  .bills-section-consumed { border-left-color: rgba(99, 102, 241, 0.45); }
  .bills-section-head {
    margin: 0 0 var(--space-2, 8px);
    /* === v0.3.16 #2: extend sticky bg past container's padding-left (PO msg 14:54) === */
    /* margin-left: -12px pulls the head box left so the sticky bg covers the
       parent .bills-section's padding-left gap; padding-left: 12px restores
       inner content alignment with the bill rows below. */
    margin-left: calc(-1 * var(--space-3, 12px));
    padding: var(--space-2, 8px) 0 var(--space-2, 8px) var(--space-3, 12px);
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    font-size: var(--font-size-sm, 14px);
    font-weight: 600;
    color: var(--gray-900);
    /* v0.3.17 #21 (PO msg 13:51 续): 删 background 0.55 — 之前 .section-header 0.92
       被同 specificity 后定义的 .bills-section-head 0.55 覆盖, 导致 sticky bg
       仍是 0.55 透明, iPhone Safari 实拍仍穿透。现: .bills-section-head 不再
       单独设 bg, 继承 .section-header 0.92。border-radius + box-shadow 仍保留
       (capsule 形态 + 玻璃 inset highlight)。 */
    border-radius: 6px;
    border-bottom: 0;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 1px 3px rgba(0, 0, 0, 0.04);
  }

  /* === v0.3.16 #2 hotfix v2: ::before 渐变 overlay ===
     z-index -1 在父 stacking context (position: sticky + z-index 10)
     内渲染于父 bg 之上一层 (step 2 of painting order). 这样渐变
     强化 Liquid Glass 视觉遮挡而不破坏背景 blur 效果. */
  .section-header::before,
  .bills-section-head::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(180deg,
      rgba(255, 255, 255, 0.6) 0%,
      rgba(255, 255, 255, 0.4) 100%);
    border-radius: inherit;
    pointer-events: none;
  }

  /* === v0.3.17 #21: Safari iOS < 18 backdrop-filter bug fallback ===
     早期 iOS Safari 对 backdrop-filter 支持不稳, fallback 到几乎全 opaque.
     .section-header 已 0.92, fallback 0.95 让 iOS < 18 也物理遮挡穿透。
     .bills-section-head 不再单独 fallback (继承 .section-header)。 */
  @supports not (backdrop-filter: blur(1px)) {
    .section-header {
      background: rgba(255, 255, 255, 0.95);
    }
  }
  /* === v0.3.16 #1: clickable section header + collapse icon === */
  .bills-section-head[role="button"] {
    cursor: pointer;
    user-select: none;
  }
  .bills-section-head[role="button"]:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
    /* Match the new capsule border-radius so focus ring doesn't pop */
    border-radius: 6px;
  }
  /* v0.3.17 #37 (PO msg 10:55 #6262): collapse-icon 配合 chip 加倍, 12px 跟 chip 视觉协调 */
  .collapse-icon {
    margin-left: auto;
    font-size: clamp(0.6875rem, 2.6vw, 0.75rem);
    color: var(--gray-400);
    line-height: 1;
  }

  /* v0.3.17 #37 (PO msg 10:55 #6262): icon 20×20 → 24×24, 跟加倍的 chip 高度视觉对位. font-size +2px (12 → 14). */
    .bills-section-icon {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: clamp(0.8125rem, 2.8vw, 0.875rem);
    font-weight: 700;
    line-height: 1;
    color: #fff;
  }
  .icon-paid { background: var(--success-500); }
  .icon-consumed { background: var(--accent-500); }
  .bills-section-title { flex: 0 0 auto; }
  /* v0.3.17 #37: count 显式 14px 跟 chip font-size-md 视觉对位 */
  .bills-section-count { flex: 0 0 auto; font-weight: 400; font-size: var(--font-size-sm, 14px); }
  .empty-hint { margin: 0; padding: var(--space-2, 8px) 0; }

  /* === bill list rows === */
  /* === v0.3.17 #16 hotfix (PO msg 03:00 续): settle 页 sticky header 浮起漏内容 真修 ===
     上版 (#15) 40px padding-top 不够, 上版 (#16 试 56) 也不够 — 实测数据:
       - sticky h4 height = 36, h4 自然 bottom = h4 自然 top + 36
       - h4 margin-bottom = 8, sublist 自然 top = h4 自然 top + 44
       - padding-top 决定 first row top 距 sublist top
       - 当 h4 sticky 在 top:0, sublist top = (h4 自然 + 44) - scroll
         first row top = sublist top + padding-top = (h4 自然 + 44 - scroll) + padding-top
         gap (first row 距 h4 bottom 36) = padding-top - scroll + h4 自然 + 8
       - "0 gap" 临界: scroll = padding-top + h4 自然 + 8
         (e.g. padding-top=40 → scroll=711.8; padding-top=100 → scroll=771.8)
     修法: padding-top = 100px (h4 height 36 + h4 margin 8 + 视觉 buffer 56)
     - h4 刚 sticky 时 (scroll = h4 自然): gap = padding-top + 8 = 108px (充足视觉间距)
     - 用户 scroll 到 770 之前 first row 始终在 h4 下方
     - scroll > 770 之后 first row 进入 h4 后面 (设计接受: 旧账单滚出视野, 用户已看新账单)
     - 上版 #15 报告「0px 完全贴合」是因为 padding-top 太小, 临界 scroll 太靠近 h4 自然
     CSS var --settle-sticky-height 默认 100, 可微调 */
  /* v0.3.17 #21 (PO msg 13:51 item 4): padding-top 从 100px 改 0
     (取消 #16 padding hack)。视觉间距由 h4 margin-bottom 8px 自然提供。 */
  .bill-sublist {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 4px);
  }
  .bill-subrow {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2, 8px) 0;
    border-bottom: 1px dashed var(--gray-200);
  }
  .bill-subrow:last-child { border-bottom: none; }
  .row1 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2, 8px);
  }
  .row2 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1, 4px);
    font-size: var(--font-size-sm, 14px);
  }
  /* v0.3.27 (UAT 0723-2 #4): 分摊 走右, 跟 BillListGrouped .your-share 同款 */
  .shared-tag-right {
    margin-left: auto;
    color: var(--gray-900, #171717);
    /* v0.3.28 UAT 0724-2 #11: 500→400, 分摊文字和金额不用加粗 */
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  /* v0.3.27 (UAT 0723-2 #4): 跟 BillListGrouped .bill-row-exclusive 同款  */
  .bill-row-exclusive {
    color: var(--gray-500, #6b7280);
    font-size: var(--font-size-sm, 14px);
    font-weight: 400;
  }
  .bill-sub-desc {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .amount-primary {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: var(--font-size-base);
    white-space: nowrap; /* v0.3.17 #34: PO 反馈 +4,555.70 THB 折行, nowrap 防止换行 */
  }
  .bill-sub-date { font-variant-numeric: tabular-nums; }
  /* v0.3.16 #3: 人数 chip in row2 */
  .participant-icon {
    display: inline-block;
    vertical-align: -2px;
    margin-right: 3px;
    color: currentColor;
  }
  .participant-count {
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
    color: var(--gray-500);
    font-size: var(--font-size-sm, 14px); /* v0.3.28 UAT 0724-2 #12: 跟时间字号一致 (14px) */
  }
  .participant-icon {
    vertical-align: middle;
  }
  .participant-count-num {
    /* inherit muted color */
  }
  .sep { color: var(--gray-400); }

  /* === Sprint 3 T13: loading 骨架样式 === */
  .skeleton-section {
    padding: var(--space-3, 12px) 0;
  }
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

  /* === v0.3.17 #31 (PO msg 23:13 #6027): settle sticky header chip-on-sheet liquid glass ===
     iOS 27 liquid glass 母体: 浓液 chip (.glass-chip) 浮在稀液 sheet (.glass-sheet) 上方 8px.
     sheet 是 sticky 容器 (取代旧 sticky h4), chip 是 sheet 顶部的浮起 label.
     仅 apply 在个人视图 tab 的 bills-section, 不改概览 tab (settle/+page.svelte 内的 transfers 区
     是另一 view, 不在本次范围).
     - .glass-sheet: 稀液 32% opacity + saturate 150% + blur 16px + inset highlight, position: sticky 容器
     - .glass-chip: 浓液 62% opacity + saturate 200% + blur 20px + 1px specular + 双层 indigo drop shadow
     - chip 浮在 sheet 上方: margin-bottom: -8px (拉 list 上 8px) + z-index 命名空间 (chip > sheet)
     === v0.3.17 #31-fix (PO msg 23:44 #6063): settle sticky head 滑动 list 渐消失于 head 真修 ===
     上版 #31 加的 chip z-index 2 / sheet z-index 5 跟 #20/#21 设计意图反了 (#20 sticky h4 z=10,
     list 在 .bills-section z=auto=0; 头在上, 明细在下). PO 反馈上滑时明细 list 越过 head —
     实测 chip 0.62 透明 + sticky 容器边界 list 滚动到 chip 区域时 38% 穿透 (chip bg 半透明 + 
     z-index 命名空间反了 — chip z=2 < sheet z=5 跟 "chip 浮在 sheet 上" 母体设计反了, sheet 内
     list 跟 chip 同 stacking context 但 chip z=2 < sheet z=5 让人误读成 list 优先).
     修法 (chip 命名空间 z > sheet 命名空间 z, 跟原 .section-header z=10 / .bills-section
     z=auto 语义一致):
     - .glass-sheet z-index: 5 → 1 (sheet 在 stacking 下方, list 自然在 head 下方)
     - .bills-section-consumed.glass-sheet z-index: 6 → 2 (consumed sheet 仍略高于 paid sheet,
       sticky 容器边界重叠时消费明细自然盖付款明细)
     - .section-header.glass-chip z-index: 2 → 10 (chip 在 stacking 上方, head 自然盖 list)
     - **不**给消费明细 (`.bills-section-consumed`) 特殊 z-index 11 — 两个 section (paid +
       consumed) 同层并列, 都用 `.glass-chip` z-index 10 (PO msg 23:44 #6065 拍补)
     - 可选: .glass-chip mask-image 顶部 16px fade 给视觉柔化 (避免 head/list 边界 sharp).
       chip bg 0.62 + mask 顶部透明 → list 进入 chip 区域时, 顶部 16px 完全露出 (mask 透明),
       16px 以下 chip bg 物理遮挡 (mask opaque + chip bg 0.62 实际显示 38% 透明, list 文字仍
       隐约可见但 chip 视觉主导). 整体 "list 渐消失于 head 中" (跟 #20 当时设计意图一致, 但
       chip 仍保留 #31 浓液 0.62 liquid glass 美学). mask 同时给 webkit 前缀覆盖 Safari. */
  .glass-sheet {
    /* v0.3.17 #31fix-3 (PO msg 01:48 #6160 + 01:59 #6178; 详见 SPEC §11 #31fix-3):
       sheet 自身不再 sticky. 原 sticky top:0 让两个 sheet (paid + consumed) 都吸顶,
       视觉堆叠. 改 position: relative (正常 flow), 由 .section-header.glass-chip
       接管 sticky 行为 (iOS Mail inbox 模式: 只有当前 section header sticky 在
       viewport 顶部, 其它 section 自然随内容滚出).
       ===
       v0.3.17 #41 (PO msg 16:24): 付款明细上方空白太多真修.
       - margin-top 24px → 14px (上面 hero 跟 sheet 之间 10px 间隔, 跟 #38 hero
         padding-bottom 16px 自然呼应, 不再堆叠 24+12=36 大空白).
       - padding-top 16px → 10px (chip 拉上去 negative -10px, 留 0 给 chip,
         chip 视觉上"贴在 sheet 顶边", 取代原 "chip 浮在 sheet 10px 上" 留白).
       效果: hero end → chip start gap 从 ~26px 减到 ~14px, chip end → first row
       gap 从 ~6px 减到 ~0px (chip 跟 first row 视觉相邻, 不再"隔着 16px 空白").
       ===
       v0.3.18 #49 (PO msg 21:16 #6508 极透明化 sweep): bg 0.18 → 0.10
       跟 day-group (.bill 列表) 同透度, 整站玻璃 sheet 几乎全透.
       inset highlight 0.7 → 0.95 (玻璃上沿补偿).
       ===
       v0.3.18 #50 (PO msg 22:12 #6523 极透明化 v2): #49 sheet 仍"白纸+文字",
       再降一档极透. bg 0.10 → 0.05, inset 0.95 → 0.20.
       .bills-section-paid / .bills-section-consumed 的 border-left
       (success-500 / accent-500 实色) 同改: alpha 0.4-0.5, 保留颜色降存在感. */
    position: relative;
    z-index: 1;
    background: rgba(255, 255, 255, 0.05);
    backdrop-filter: saturate(150%) blur(16px);
    -webkit-backdrop-filter: saturate(150%) blur(16px);
    border-radius: 16px;
    /* v0.3.18 #44: margin-top 14 → 0 + padding-top 10 → 4 (跟 .hero mb 0 一起 collapse) */
    padding: 4px var(--space-3, 12px) var(--space-3, 12px);
    /* v0.3.18 #50 (PO msg 22:12 #6523 极透明化 v2): 删 border-left: 0, 让 .bills-section
       原 3px border-left + .bills-section-paid/-consumed 的半透 color (0.45 alpha) 重新
       生效. 设计补点: 付款/消费 sheet 左侧有 3px 半透色彩条作为语义区别 (绿/蓝紫), sheet 本身
       几乎全透. 设计锚点保留, 存在敢路 0.45 alpha 减陆. */
    margin-top: 0;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.20),
      inset 0 -1px 0 rgba(0, 0, 0, 0.015);
  }

  /* glass-chip: 浓液浮在 sheet 顶, 取代旧 .section-header 的 sticky + 0.92 bg.
     compound selector 提升 specificity (0,2,0) 覆盖旧 .bills-section-head (0,1,0).
     z-index: 10 (跟原 #20 .section-header z=10 一致, head 在 list 之上).
     两个 section (paid + consumed) 都用这个 z-index 10 同层并列 (PO msg 23:44 #6065
     拍补 — 消费明细和付款明细是同层级, 不分层级).
     mask-image 顶部 16px 渐变透明: list 进入 chip 区域时, 顶部 16px mask 透明 → list 文字
     可见 (跟 sticky 边界外的 list 视觉一致), 16px 以下 mask opaque → chip bg 0.62 物理遮挡
     list 38% 透明. 整体 "list 渐消失于 head 中" (PO msg 23:44 #6063 设计意图).
     ::before 渐变 overlay 取消 — chip 自带 bg + 双层阴影 + mask, 不再需要旧 hack 强化遮挡. */
  .section-header.glass-chip {
    /* v0.3.18 #49 (PO msg 21:16 #6508 极透明化 sweep): bg 0.35 → 0.20
       跟成员 chip (0.15/0.08) 同步, 整站 section header chip 几乎全透.
       ===
       v0.3.18 #50 (PO msg 22:12 #6523 极透明化 v2): #49 chip 仍"白边+浮起", 再降一档
       - bg 0.20 → 0.10 (chip 几乎全透, 只靠文字 + inset highlight 提示有 label)
       - inset highlight 1.0 → 0.30 (玻璃上沿大幅淡化, 不再"白框胶囊")
       - 外阴影 indigo: 0.14/0.20/0.14 → 0.04/0.06/0.04 (后两层浓阴影同降一档)
       - 保留 text-shadow (重要文字仍然可读)
       ===
       v0.3.18 #54 (PO msg 18:10 #6569): 加重模糊 — 0.10 太透, 付款/消费明细 row
       滚过 chip 时几乎贴脸穿透. bg 0.10 → 0.55 (× 5.5 浓液化),
       blur 20 → 24 (+20%), 保留 saturate 200% (玻璃质感).
       inset highlight / 外阴影同步略提 (玻璃感保留). */
    background: rgba(255, 255, 255, 0.42);
    backdrop-filter: saturate(200%) blur(24px);
    -webkit-backdrop-filter: saturate(200%) blur(24px);
    border-radius: 9999px;
    /* v0.3.17 #37 (PO msg 10:55 #6262): 加倍 chip 垂直高度 ~36px → ~64-72px, 跟 row 高度 52-72px 视觉对位. padding 上下 8px → 20px (× 2.5, 原 brief 12px 写小改 20px 补足 SPEC 目标); 左右 12px → 16px (× 1.3); margin 同步 -8px → -10px 让 overlap 视觉协调. font-size sm (14px) → md (16px) +1 档. min-height: 60px 保证最小 320px viewport 也 ≥60. 保留 pill border-radius 9999px (PO 没要求改); 保留 sticky + mask-image + z-index + iOS27 玻璃参数. */
    padding: var(--space-5, 20px) var(--space-4, 16px);
    /* v0.3.18 #44: margin-top -10 → -4 (跟新 .glass-sheet padding-top 4px 抵消,
       chip top edge = sheet top edge, 视觉上 chip "贴在" sheet 顶边) */
    margin: -4px calc(-1 * var(--space-3, 12px)) -10px calc(-1 * var(--space-3, 12px));
    min-height: 60px;
    z-index: 10;
    /* v0.3.17 #31fix-3 (PO msg 01:48 #6160 + 01:59 #6178; 详见 SPEC §11 #31fix-3):
       chip 改 sticky top 0. 原 position: relative 跟 sheet 一起堆叠, 失去 sticky
       语义. 现 sheet 改 relative 后, chip sticky within sheet — 只有当前 section
       的 chip 吸顶, 其它 section chip 自然随内容滚出 (iOS Mail inbox 行为).
       关键不变量: z-index: 10 > sheet z-index: 1, chip 浮在 sheet 之上, list 滚
       到 chip 下方时被 chip bg 物理遮挡 (顶部 16px mask 透明渐变保留视觉柔化). */
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    /* v0.3.17 #37: sm (14px) → md (16px) +1 档 (跟加倍 chip 高度配套) */
    font-size: var(--font-size-md, 16px);
    font-weight: 600;
    color: var(--gray-900);
    border-bottom: 0;
    /* #31-fix: mask-image top 16px fade — list 进 chip 区域时顶部 16px 透明露出, 16px 以下
       chip bg 物理遮挡. 视觉 "list 渐消失于 head 中" (PO msg 23:44 #6063 设计意图) */
    mask-image: linear-gradient(180deg, transparent 0, #000 16px, #000 100%);
    -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 16px, #000 100%);
    /* v0.3.18 #50: chip inset highlight 1.0 → 0.30 + 外阴影大幅降级. */
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.30),
      0 1px 2px rgba(99, 102, 241, 0.04),
      0 4px 12px rgba(99, 102, 241, 0.06),
      0 8px 24px rgba(99, 102, 241, 0.04);
    /* v0.3.18 #49 保留: 文字白色微晕 (低对比玻璃上唯一可读性补偿) */
    text-shadow: 0 1px 3px rgba(255, 255, 255, 0.85);
  }
  /* #31-fix (PO msg 23:44 #6065 拍补): 两个 section (paid + consumed) 同层并列,
     都用 `.section-header.glass-chip { z-index: 10 }`, **不**给消费明细特殊 z-index 11.
     原 #31-fix commit 误加 .bills-section-consumed .section-header.glass-chip { z-index: 11 }
     是错的 (跟 #32-fix brief 拍板一致), 已删. */
  .section-header.glass-chip::before,
  .bills-section-head.glass-chip::before {
    content: none;
  }
  /* glass-chip: Safari iOS < 18 backdrop-filter fallback.
   v0.3.18 #49: 0.50 → 0.32 (跟新 base 0.20 同比例降级, 仍提供 fallback opaque 可读性)
   v0.3.18 #50: 0.32 → 0.20 (跟新 base 0.10 同比例降级, 仍提供 fallback opaque 可读性) */
  @supports not (backdrop-filter: blur(1px)) {
    .section-header.glass-chip {
      background: rgba(255, 255, 255, 0.20);
    }
  }

  /* === v0.3.24 #12 (PO msg 16:35 UAT file line 12) + v0.3.0728-3 #6:
       付款明细 / 消费明细 搜索框 (跟 BillListGrouped.svelte 的 .bills-search 同款
       玻璃风, placeholder "搜索账单名称", bg rgba(255,255,255,0.55) +
       backdrop-filter blur saturate).
       v0.3.0728-3 #6 (PO msg 2026-07-28 batch 新批 #6): 搜索框应 sticky,
       用户滚动 bill 列表时搜索框常驻可见, 不用滚回去找. 之前设计 "不加 sticky
       避免叠层" 已不适用 — 改成 sticky + 显式 z-index 栈分层 + 注释说明堆叠顺序.
       堆叠 (从底到顶): bill items (z-index auto) → 搜索框 (z-index 9) → section h4
       sticky header (z-index 10). 搜索框 z-index 9 < h4 z-index 10, 滚到 h4 重叠时
       h4 视觉压在搜索框上方 (跟 iOS native section header 行为一致). */
  .bills-section-search {
    position: sticky;
    /* v0.3.0729-2 #9: top 跟 glass-chip 实际高度对齐.
       chip = padding 20+20 + 16px 字 + min-height 60 → 实测常 ~64-72px (含 gap/icon).
       旧 top:32/60 仍会被 header 挡住; 现 top:76px 保证 search 整条露在 chip 下沿之下. */
    top: 76px;
    /* search 在 header 之下 (z < header), 正确堆叠: items → search(9) → header(10). */
    z-index: 9;
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    /* margin-bottom 8px 保留 (跟下面 bill items 视觉间距), 但改成 sticky 后 margin-top 也归 0
       (避免跟 h4 视觉间距 8px + h4 margin-bottom 8px 叠加 16px). */
    margin: 0 0 var(--space-2, 8px);
    padding: 8px var(--space-2, 8px);
    /* v0.3.0729-4 #12: 与账单列表日期 header 同透明度 (0.42) */
    background: rgba(255, 255, 255, 0.42);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    color: var(--gray-500);
    /* 跟 .bills-section 共享 left border (颜色竖条) — search 缩进跟 ul 内容对齐 */
    margin-left: 0;
  }
  @supports not (backdrop-filter: blur(1px)) {
    .bills-section-search {
      background: var(--color-bg, #f9fafb);
    }
  }
  .bills-section-search-input {
    flex: 1;
    border: 0;
    background: transparent;
    font-size: var(--font-size-sm, 14px);
    color: var(--gray-900);
    padding: 0;
    min-width: 0;
    /* 跟 .bills-search-input 同款 (sessions/[id]/+page.svelte 1738-1748):
       height 22px + line-height 22px + -webkit-appearance: none + margin: 0
       + text-align: left. 在 settle section 内 search 比 bill list row 矮,
       22px 让 search 视觉不抢戏. */
    height: 22px;
    line-height: 22px;
    margin: 0;
    -webkit-appearance: none;
    appearance: none;
    text-align: left;
  }
  /* 跟 .bills-search-input 同款: webkit native X 隐藏 + 配套自定义 X. */
  :global(.bills-section-search-input::-webkit-search-cancel-button) {
    -webkit-appearance: none;
    appearance: none;
    display: none !important;
  }
  .bills-section-search-input:focus {
    outline: none;
  }
  .bills-section-search-clear {
    appearance: none;
    background: transparent;
    border: 0;
    cursor: pointer;
    color: var(--gray-500);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    /* 跟 .bills-search-clear 同款 22px 高 (sessions/[id]/+page.svelte 1752 行
       min-height: 22px), 不撑高整个 search container. */
    min-height: 22px;
  }
</style>
