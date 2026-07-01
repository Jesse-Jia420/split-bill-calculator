<script lang="ts">
  /**
   * v0.1.2 反馈修3 (PO 2026-07-01 20:30 UX 改写) — 个人视图成员明细。
   *
   * 本次完全重写 (333 → ~200 行):
   * - T14: 横向 chip row (role=tablist) + 每个 member 一个 chip
   *   - 圆角 8px + 边框 + 选中态 (accent bg + border)
   *   - 高度 64px + 宽度按内容,最少 4 个可见,移动端 7+ 横滑
   *   - scroll-snap + 切换时 scrollIntoView 平滑滚动
   * - 下方: 单成员明细 (title + 3-col stats + 付款 list + 消费 list)
   * - props 改: `{ session, currentUserId }`
   * - 默认 selectedMemberId: members.find(m => m.user_id === currentUserId)?.member_id ?? members[0]?.member_id
   *
   * 历史 v0.1.2:
   * - T18 (`835952d`): list-of-cards 嵌套 details,每 member 一个折叠 card
   * - T4-T6 反馈修 (`4a648f7`): exclusive_amount + 优先级 + 2-row breakdown
   *
   * 反模式预防:
   * - 切换 selected 之后没 scrollIntoView → 用户切到列表右侧看不到自己的 chip。
   *   用 smooth scroll + scroll-snap + 初始 selected 也对齐到 center
   * - 不要把 animate 放在 onMount 后,因为 onMount 时 chip 还没 render。
   *   等 tick 后再 scroll (setTimeout 0)
   */
  import { onMount, tick } from 'svelte';
  import { getSettle } from '$api/settle';
  import type { MemberSettlement } from '$api/settle';
  import type { SessionDetail } from '$api/sessions';

  export let session: SessionDetail;
  /** T14: 当前登录用户 user_id (从 user store 传过来)。用于选中默认自己。 */
  export let currentUserId: number | null = null;

  let loading = true;
  let error: string | null = null;
  let members: MemberSettlement[] = [];

  // T14: 当前选中的 member_id (chip state)
  let selectedMemberId: number | null = null;
  /** chip refs map for scrollIntoView。Svelte bind:this 需要可写 id 表达式,
   * 所以用 Record<number, HTMLButtonElement | null> (Map 类型不行)。 */
  let chipRefs: Record<number, HTMLButtonElement | null> = {};

  function fmt(n: number): string {
    return n.toFixed(2);
  }

  function fmtDate(iso: string): string {
    try {
      const d = new Date(iso);
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      return `${month}-${day} ${hours}:${minutes}`;
    } catch {
      return iso;
    }
  }

  function avatarLetter(name: string): string {
    const trimmed = (name ?? '').trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  /** T14: 净金额展示 (+/- prefix) — user-friendly compact label */
  function fmtChipNet(n: number): string {
    if (n > 0) return '+' + fmt(n);
    if (n < 0) return '−' + fmt(Math.abs(n)); // U+2212 true minus (vs hyphen-minus)
    return fmt(0);
  }

  $: selectedMember = members.find((m) => m.member_id === selectedMemberId) ?? null;

  /** T14: chip 选中时把 chip 滚到可见区域 */
  async function selectMember(memberId: number) {
    selectedMemberId = memberId;
    await tick();
    const el = chipRefs[memberId];
    if (el) {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } catch {
        // 老浏览器可能不支持 behavior smooth → fallback 直接对齐
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
      // T14: 默认选中当前用户,没找到就第一 member
      const me = members.find((m) => {
        const sm = session.members.find((sm) => sm.id === m.member_id);
        return sm && sm.user_id === currentUserId;
      });
      selectedMemberId = me?.member_id ?? members[0]?.member_id ?? null;
      // 初始滚到自己(等 chip 渲染完)
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
    <p class="muted">正在加载个人视图…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if members.length === 0}
    <p class="muted">这个 session 还没有成员。</p>
  {:else}
    <!-- T14: 横向 chip 行 (role=tablist) -->
    <div
      class="member-tabs"
      role="tablist"
      aria-label="成员选择"
    >
      {#each members as m (m.member_id)}
        <button
          type="button"
          class="member-chip"
          class:active={selectedMemberId === m.member_id}
          role="tab"
          aria-selected={selectedMemberId === m.member_id}
          aria-controls="member-panel-{m.member_id}"
          bind:this={chipRefs[m.member_id]}
          on:click={() => selectMember(m.member_id)}
        >
          <div class="chip-avatar" aria-hidden="true">{avatarLetter(m.display_name)}</div>
          <div class="chip-info">
            <div class="chip-name">{m.display_name}{#if m.role === 'owner'}<span class="chip-badge">owner</span>{/if}</div>
            <div class="chip-net" class:pos={m.net > 0} class:neg={m.net < 0}>{fmtChipNet(m.net)}</div>
          </div>
        </button>
      {/each}
    </div>

    <!-- T14: 单成员明细面板 -->
    {#if selectedMember}
      <div
        class="member-panel"
        id="member-panel-{selectedMember.member_id}"
        role="tabpanel"
        aria-label="{selectedMember.display_name} 明细"
      >
        <h3 class="member-panel-title">
          <span class="panel-avatar" aria-hidden="true">{avatarLetter(selectedMember.display_name)}</span>
          <span>{selectedMember.display_name}</span>
          {#if selectedMember.role === 'owner'}<span class="chip-badge owner-badge">owner</span>{/if}
        </h3>

        <!-- 3-col stats (付款 / 消费 / 净) -->
        <div class="stats-grid">
          <div class="stat-cell">
            <div class="stat-label muted">付款</div>
            <div class="stat-value">{fmt(selectedMember.total_paid)}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label muted">消费</div>
            <div class="stat-value">{fmt(selectedMember.total_consumed)}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label muted">净</div>
            <div
              class="stat-value"
              class:pos={selectedMember.net > 0}
              class:neg={selectedMember.net < 0}
            >
              {#if selectedMember.net > 0}
                +{fmt(selectedMember.net)}
              {:else if selectedMember.net < 0}
                −{fmt(Math.abs(selectedMember.net))}
              {:else}
                0.00
              {/if}
            </div>
          </div>
        </div>

        <!-- 付款明细 (复用 row1/row2 风格) -->
        <h4 class="section-h">付款明细 ({selectedMember.paid_bills.length})</h4>
        {#if selectedMember.paid_bills.length === 0}
          <p class="muted">没有付过账单</p>
        {:else}
          <ul class="bill-sublist" style="list-style: none; padding: 0; margin: 0;">
            {#each selectedMember.paid_bills as b (b.bill_id)}
              <li class="bill-subrow">
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

        <!-- 消费明细 (复用 row1/row2 风格) -->
        <h4 class="section-h">消费明细 ({selectedMember.consumed_bills.length})</h4>
        {#if selectedMember.consumed_bills.length === 0}
          <p class="muted">没有被分摊的账单</p>
        {:else}
          <ul class="bill-sublist" style="list-style: none; padding: 0; margin: 0;">
            {#each selectedMember.consumed_bills as b (b.bill_id)}
              {@const excl = b.exclusive_amount ?? 0}
              {@const shared = b.share_amount - excl}
              <li class="bill-subrow">
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
    {/if}
  {/if}
</div>

<style>
  /* === T14: chip row === */
  .member-tabs {
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    display: flex;
    gap: var(--space-2, 8px);
    padding: var(--space-2, 8px) 0;
    margin-bottom: var(--space-3, 12px);
    /* 隐藏滚动条但保留可滚动 */
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;
  }
  .member-tabs::-webkit-scrollbar {
    height: 4px;
  }
  .member-chip {
    scroll-snap-align: start;
    flex: 0 0 auto;
    appearance: none;
    background: var(--color-surface, #fff);
    border: 1.5px solid var(--color-border, #e5e5e5);
    border-radius: 8px;
    padding: var(--space-2, 8px) 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    min-height: 64px;
    min-width: 110px;
    max-width: 180px;
    text-align: left;
    color: inherit;
    font: inherit;
    transition: border-color 0.15s, background-color 0.15s, box-shadow 0.15s;
  }
  .member-chip:hover {
    border-color: var(--color-accent, #3b82f6);
  }
  .member-chip:focus-visible {
    outline: 2px solid var(--color-accent, #3b82f6);
    outline-offset: 2px;
  }
  .member-chip.active {
    border-color: var(--color-accent, #3b82f6);
    background: rgba(59, 130, 246, 0.1);
    box-shadow: 0 0 0 1px var(--color-accent, #3b82f6);
  }

  .chip-avatar {
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--color-accent, #3b82f6);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
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
  .chip-net {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--color-text-muted, #666);
    font-size: var(--font-size-sm, 14px);
  }
  .chip-net.pos {
    color: var(--color-success, #10b981);
  }
  .chip-net.neg {
    color: var(--color-error, #ef4444);
  }
  .chip-badge {
    display: inline-block;
    background: var(--color-accent, #3b82f6);
    color: #fff;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 999px;
    font-weight: 500;
    margin-left: 4px;
    vertical-align: middle;
  }

  /* === T14: member panel === */
  .member-panel {
    border-top: 1px solid var(--color-border, #e5e5e5);
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
    background: var(--color-accent, #3b82f6);
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
  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: var(--space-2, 8px);
    margin-bottom: var(--space-4, 16px);
  }
  .stat-cell {
    background: var(--color-bg, #fafafa);
    border: 1px solid var(--color-border, #e5e5e5);
    border-radius: 8px;
    padding: var(--space-2, 8px) 12px;
    text-align: center;
  }
  .stat-label {
    font-size: var(--font-size-sm, 14px);
    margin-bottom: 2px;
  }
  .stat-value {
    font-size: 1rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .stat-value.pos {
    color: var(--color-success, #10b981);
  }
  .stat-value.neg {
    color: var(--color-error, #ef4444);
  }

  .section-h {
    margin: var(--space-3, 12px) 0 var(--space-2, 8px);
    font-size: var(--font-size-sm, 14px);
    color: var(--color-text-muted, #666);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  /* 复用 row1/row2 风格 (沿用 T6 Coder 4) */
  .bill-sublist {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 4px);
  }
  .bill-subrow {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2, 8px) 0;
    border-bottom: 1px dashed var(--color-border, #e5e5e5);
  }
  .bill-subrow:last-child {
    border-bottom: none;
  }
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
  .bill-sub-date {
    font-variant-numeric: tabular-nums;
  }
  .exclusive-tag {
    color: var(--color-accent, #3b82f6);
    font-weight: 500;
  }
  .shared-tag {
    color: var(--color-text-muted, #666);
  }
  .bill-total {
    color: var(--color-text-muted, #999);
  }
  .sep {
    color: var(--color-text-muted, #999);
  }
</style>
