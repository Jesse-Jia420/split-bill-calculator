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
   */
  import { onMount, tick } from 'svelte';
  import { scale, fly, fade } from 'svelte/transition';
  import { getSettle } from '$api/settle';
  import { formatMoney, formatDate } from '$lib/utils/format';
  import { tweenNumber } from '$lib/utils/tween';
  import { currencySymbol } from '$lib/utils/currency';
  import { toast } from '$stores/toast';
  import SkeletonBill from '$components/SkeletonBill.svelte';
  import type { MemberSettlement } from '$api/settle';
  import type { SessionDetail } from '$api/sessions';

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
    <p class="muted">这个 session 还没有成员。</p>
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
            on:click={() => selectMember(m.member_id)}
            in:fly={{ y: 6, duration: 220, delay: Math.min(i * 30, 240) }}
          >
            <div class="chip-avatar" aria-hidden="true">{avatarLetter(m.display_name)}</div>
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
          <h3 class="member-panel-title">
            <span class="panel-avatar" aria-hidden="true">{avatarLetter(selectedMember.display_name)}</span>
            <span>{selectedMember.display_name}</span>
            {#if selectedMember.role === 'owner'}<span class="chip-badge owner-badge">owner</span>{/if}
            {#if isMe(selectedMember.member_id)}<span class="me-badge" aria-label="当前用户">me</span>{/if}
          </h3>

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
          <div class="bills-section bills-section-paid">
            <h4 class="bills-section-head section-header">
              <span class="bills-section-icon icon-paid" aria-hidden="true">↑</span>
              <span class="bills-section-title">付款明细</span>
              <span class="bills-section-count muted">({selectedMember.paid_bills.length})</span>
            </h4>
            {#if selectedMember.paid_bills.length === 0}
              <p class="muted empty-hint">没有付过账单</p>
            {:else}
              <ul class="bill-sublist">
                {#each selectedMember.paid_bills as b, i (b.bill_id)}
                  <li
                    class="bill-subrow"
                    in:fly={{ y: 6, duration: 200, delay: Math.min(i * 25, 200) }}
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
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <!-- T10: 消费明细 section with sticky header -->
          <div class="bills-section bills-section-consumed">
            <h4 class="bills-section-head section-header">
              <span class="bills-section-icon icon-consumed" aria-hidden="true">↓</span>
              <span class="bills-section-title">消费明细</span>
              <span class="bills-section-count muted">({selectedMember.consumed_bills.length})</span>
            </h4>
            {#if selectedMember.consumed_bills.length === 0}
              <p class="muted empty-hint">没有被分摊的账单</p>
            {:else}
              <ul class="bill-sublist">
                {#each selectedMember.consumed_bills as b, i (b.bill_id)}
                  {@const tags = fmtConsumedTags(b)}
                  <li
                    class="bill-subrow"
                    in:fly={{ y: 6, duration: 200, delay: Math.min(i * 25, 200) }}
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
                    <div class="row2 muted">
                      <span class="bill-sub-date">{fmtDate(b.occurred_at)}</span>
                      {#if tags.excl}
                        <span class="sep" aria-hidden="true">·</span>
                        <span class="tag exclusive-tag">独占 {tags.excl}</span>
                      {/if}
                      <span class="sep" aria-hidden="true">·</span>
                      <span class="tag shared-tag">共享 {tags.shared}</span>
                      <span class="sep" aria-hidden="true">·</span>
                      <span class="bill-total">账单总 {tags.total}</span>
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
  /* === T9: Chip Redesign — filled pill === */
  .member-tabs-wrapper {
    position: relative;
  }
  .member-tabs-wrapper::after {
    content: '';
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 32px;
    background: linear-gradient(to right, transparent, white);
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
  .member-chip {
    scroll-snap-align: start;
    flex: 0 0 auto;
    appearance: none;
    /* Inactive base */
    background: white;
    border: 1px solid var(--gray-200);
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
    transition:
      background-color 200ms ease,
      border-color 200ms ease,
      color 200ms ease,
      box-shadow 200ms ease,
      transform 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  .member-chip:hover {
    border-color: var(--accent-500);
    color: var(--accent-700);
  }
  .member-chip:active {
    transform: scale(0.97);
  }
  .member-chip:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
  }
  /* T9 Active state: filled accent bg */
  .member-chip.selected {
    background: var(--accent-500);
    border: 1px solid var(--accent-500);
    color: white;
    box-shadow: var(--shadow-sm);
  }
  .member-chip.selected:hover {
    background: var(--accent-500);
    border-color: var(--accent-500);
    color: white;
  }
  /* T9 me double ring (kept even though me badge text removed) */
  .member-chip.me .chip-avatar {
    box-shadow: 0 0 0 2px var(--accent-700), 0 0 0 4px rgba(59, 130, 246, 0.25);
  }
  /* selected + me: inner ring adapts to white bg of active chip */
  .member-chip.selected.me .chip-avatar {
    box-shadow: 0 0 0 2px rgba(255,255,255,0.6), 0 0 0 4px var(--accent-700);
  }

  .chip-avatar {
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--accent-500);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
    transition: background-color 200ms ease;
  }
  /* Inactive chip: avatar uses gray bg */
  .member-chip:not(.selected) .chip-avatar {
    background: var(--gray-400);
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

  .chip-badge {
    display: inline-block;
    background: var(--accent-500);
    color: #fff;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 999px;
    font-weight: 500;
    margin-left: 4px;
    vertical-align: middle;
  }
  .me-badge {
    display: inline-block;
    background: rgba(255, 255, 255, 0.25);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    margin-left: var(--space-2, 8px);
    letter-spacing: 0.02em;
    line-height: 1.2;
    vertical-align: middle;
    text-transform: lowercase;
    border: 1px solid rgba(255,255,255,0.4);
  }
  /* Selected chip: badge adapts to white text (chip-badge lives in panel-title, not chip) */

  /* === member panel === */
  .member-panel {
    border-top: 1px solid var(--gray-200);
    padding-top: var(--space-3, 12px);
  }
  .member-panel-title {
    margin: 0 0 var(--space-3, 12px);
    font-size: 1rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
  }
  .panel-avatar {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--accent-500);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
  }
  .owner-badge {
    margin-left: 0;
  }

  /* === T8: Hero Metric === */
  .hero {
    text-align: center;
    padding: var(--space-7, 48px) var(--space-5, 20px);
    margin-bottom: var(--space-4, 16px);
  }
  .hero-net {
    font-size: var(--font-size-3xl, 40px);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1.1;
    margin-bottom: var(--space-2, 8px);
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

  /* === T10: Sticky Section Header === */
  .section-header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    border-bottom: 1px solid var(--gray-200);
  }

  /* === bills section — left border visual separation === */
  .bills-section {
    margin-top: var(--space-5, 24px);
    padding-left: var(--space-3, 12px);
    border-left: 3px solid transparent;
    border-radius: 2px;
  }
  .bills-section-paid { border-left-color: var(--success-500); }
  .bills-section-consumed { border-left-color: var(--accent-500); }
  .bills-section-head {
    margin: 0 0 var(--space-2, 8px);
    padding: var(--space-2, 8px) 0;
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    font-size: var(--font-size-sm, 14px);
    font-weight: 600;
    color: var(--gray-900);
    background: transparent;
  }
  .bills-section-icon {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    color: #fff;
  }
  .icon-paid { background: var(--success-500); }
  .icon-consumed { background: var(--accent-500); }
  .bills-section-title { flex: 0 0 auto; }
  .bills-section-count { flex: 0 0 auto; font-weight: 400; }
  .empty-hint { margin: 0; padding: var(--space-2, 8px) 0; }

  /* === bill list rows === */
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
    font-size: 1rem;
  }
  .bill-sub-date { font-variant-numeric: tabular-nums; }
  .exclusive-tag { color: var(--accent-500); font-weight: 500; }
  .shared-tag { color: var(--gray-500); }
  .bill-total { color: var(--gray-400); }
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
</style>
