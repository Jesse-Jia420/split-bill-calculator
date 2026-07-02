<script lang="ts">
  /**
   * v0.1.3 Sprint 2 Commit 3 (2026-07-02) — 个人视图成员明细。
   *
   * 本次 Commit 3 改动:
   * - T9 Chip Redesign: filled bg pill style, fade gradient mask, me double ring
   *   - Active: accent-500 bg + white text + shadow-sm
   *   - Inactive: white bg + gray-200 border, hover accent border+text
   *   - Pill shape (radius-full), gap space-3, padding space-3/space-4
   *   - Numbers: formatMoney(no symbol) + tabular-nums + color by sign
   *   - me badge removed (active=filled enough), me ring via class:me kept
   *   - Fade gradient mask in member-tabs-wrapper (already present)
   *
   * 沿用:
   * - T8 Hero Metric (Commit 2)
   * - T10 Sticky Section Header (Commit 2)
   * - v0.1.2 反馈修 6 项目 6/7
   */
  import { onMount, tick } from 'svelte';
  import { tweened } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { scale, fly, fade } from 'svelte/transition';
  import { getSettle } from '$api/settle';
  import { formatMoney, formatDate } from '$lib/utils/format';
  import SkeletonBill from '$components/SkeletonBill.svelte';
  import type { MemberSettlement } from '$api/settle';
  import type { SessionDetail } from '$api/sessions';

  export let session: SessionDetail;
  /** 当前登录用户 user_id。用于默认选中自己。 */
  export let currentUserId: number | null = null;

  let loading = true;
  let error: string | null = null;
  let members: MemberSettlement[] = [];

  let selectedMemberId: number | null = null;
  let chipRefs: Record<number, HTMLButtonElement | null> = {};

  // === 项目 7: 数字 counter animation (tweened) ===
  const tweenPaid = tweened(0, { duration: 600, easing: cubicOut });
  const tweenConsumed = tweened(0, { duration: 600, easing: cubicOut });
  const tweenNet = tweened(0, { duration: 600, easing: cubicOut });
  let prevSelectedMemberId: number | null = null;
  $: if (selectedMember) {
    tweenPaid.set(selectedMember.total_paid ?? 0);
    tweenConsumed.set(selectedMember.total_consumed ?? 0);
    tweenNet.set(selectedMember.net ?? 0);
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
   * T9 chip net amount: formatMoney no symbol, tabular-nums.
   * Color via CSS classes .pos / .neg / .zero on the chip-net element.
   */
  function fmtChipNet(n: number): string {
    if (n > 0) return '+' + formatMoney(n, { showSymbol: false });
    if (n < 0) return '\u2212' + formatMoney(Math.abs(n), { showSymbol: false });
    return formatMoney(0, { showSymbol: false });
  }

  $: selectedMember = members.find((m) => m.member_id === selectedMemberId) ?? null;

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

  onMount(async () => {
    loading = true;
    error = null;
    try {
      const data = await getSettle(session.id);
      members = data.per_member ?? [];
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
      error = e?.message ?? 'failed to load settlement';
    } finally {
      loading = false;
    }
  });
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
  {:else if error}
    <div class="error">{error}</div>
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
              <div
                class="chip-net"
                class:pos={m.net > 0}
                class:neg={m.net < 0}
                class:zero={m.net === 0}
              >{fmtChipNet(m.net)}</div>
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
          in:fade={{ duration: 220 }}
        >
          <h3 class="member-panel-title">
            <span class="panel-avatar" aria-hidden="true">{avatarLetter(selectedMember.display_name)}</span>
            <span>{selectedMember.display_name}</span>
            {#if selectedMember.role === 'owner'}<span class="chip-badge owner-badge">owner</span>{/if}
            {#if isMe(selectedMember.member_id)}<span class="me-badge" aria-label="当前用户">me</span>{/if}
          </h3>

          <!-- T8: Hero Metric -->
          <div class="hero">
            <div
              class="hero-net"
              class:pos={selectedMember.net > 0}
              class:neg={selectedMember.net < 0}
              class:zero={selectedMember.net === 0}
            >
              {#if selectedMember.net === 0}
                <span class="settled-text">已结清</span>
              {:else}
                {fmtChipNet(selectedMember.net)}
              {/if}
            </div>
            <div class="hero-meta">
              <span>consumed <strong>{fmt($tweenConsumed)}</strong></span>
              <span class="meta-sep" aria-hidden="true">·</span>
              <span>paid <strong>{fmt($tweenPaid)}</strong></span>
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
                      <span class="amount-primary">{fmt(b.amount)} {b.currency}</span>
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
                  {@const excl = b.exclusive_amount ?? 0}
                  {@const shared = b.share_amount - excl}
                  <li
                    class="bill-subrow"
                    in:fly={{ y: 6, duration: 200, delay: Math.min(i * 25, 200) }}
                  >
                    <div class="row1">
                      <span class="bill-sub-desc">{b.description || '(无说明)'}</span>
                      <span class="amount-primary">{fmt(b.share_amount)} {b.currency}</span>
                    </div>
                    <div class="row2 muted">
                      <span class="bill-sub-date">{fmtDate(b.occurred_at)}</span>
                      {#if excl > 0}
                        <span class="sep" aria-hidden="true">·</span>
                        <span class="tag exclusive-tag">独占 {fmt(excl)}</span>
                      {/if}
                      <span class="sep" aria-hidden="true">·</span>
                      <span class="tag shared-tag">共享 {fmt(shared)}</span>
                      <span class="sep" aria-hidden="true">·</span>
                      <span class="bill-total">账单总 {fmt(b.amount)}</span>
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
