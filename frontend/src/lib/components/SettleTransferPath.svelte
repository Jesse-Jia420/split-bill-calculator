<script lang="ts">
  /**
   * v0.1.3 Sprint 2 Commit 2 (2026-07-02) — Transfer path 转账建议。
   *
   * 本次 Commit 2 改动:
   * - T11 转账路径卡片化: 每笔转账独立 card,付款方→收款方头像+名字,金额居中
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token (已在 Commit 1 完成)
   *
   * 沿用:
   * - v0.1.2 反馈修 6 项目 5 (用户名不加粗,转帐箭头克制)
   */
  import { onMount } from 'svelte';
  import { getSettle } from '$api/settle';
  import { formatMoney, formatDate } from '$lib/utils/format';
  import type { SettleResponse } from '$api/settle';
  import type { SessionDetail } from '$api/sessions';

  export let session: SessionDetail;
  /** map SessionMember.id -> display_name for friendly output */
  export let memberIdToName: Record<number, string> = {};
  /** v0.2.2 (T11): re-fetch when the user toggles primary/split. */
  export let viewMode: 'primary' | 'split' = 'primary';

  let loading = true;
  let error: string | null = null;
  let data: SettleResponse | null = null;
  // Track the current view so we don't show stale data after a toggle.
  let loadedView: 'primary' | 'split' = viewMode;

  /** T6: 金额显示用 formatMoney (千分位)。 */
  function fmt(n: number): string {
    return formatMoney(n, { showSymbol: false });
  }

  // v0.2.2 (T11): refetch whenever viewMode flips so the primary / split
  // representation stays in sync with what the user selected.
  async function fetchSettle(targetView: 'primary' | 'split') {
    loading = true;
    error = null;
    try {
      data = await getSettle(session.id, targetView);
      loadedView = targetView;
    } catch (e: any) {
      error = e?.message ?? 'failed to load settlement';
    } finally {
      loading = false;
    }
  }

  onMount(() => fetchSettle(viewMode));

  $: if (!loading && loadedView !== viewMode) {
    fetchSettle(viewMode);
  }

  function displayName(memberId: number | string): string {
    const id = Number(memberId);
    return memberIdToName[id] ?? ('#' + id);
  }

  function avatarLetter(name: string): string {
    const trimmed = (name ?? '').trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  /** T6: 生成时间走 formatDate({ full: true })。 */
  function fmtGenerated(iso: string): string {
    return formatDate(iso, { full: true });
  }
</script>

<div>
  {#if loading}
    <p class="muted">正在计算结算…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if data}
    <h3>每人净收/净付</h3>
    <ul class="list balances" style="list-style: none; padding: 0; margin: 0 0 var(--space-4);">
      {#each Object.entries(data.balances) as [mid, net], i (mid)}
        <li class="bal-row row between">
          <span class="member-name">{displayName(mid)}</span>
          <span class:pos={net > 0} class:neg={net < 0} class="amount">
            {net > 0 ? '+' : ''}{fmt(net)}
          </span>
        </li>
      {/each}
    </ul>

    <h3>建议转账</h3>
    {#if data.transfers.length === 0}
      <p class="muted settled-emoji">所有人都已结清 🎉</p>
    {:else}
      <ul class="transfers-list" style="list-style: none; padding: 0; margin: 0;">
        {#each data.transfers as t, i (i)}
          {@const fromName = displayName(t.from_member_id)}
          {@const toName = displayName(t.to_member_id)}
          <li class="transfer-li">
            <!--
              v0.2.1 T06 (PRD §3.6.6) — 2026-07-03 12:40 PO 拍板 **砍掉**.
              转账卡片保持静态展示 (无 click 行为). 理由:
              (a) settle _greedy_pair 算法无 bill attribution, 1 transfer != 1 bill;
              (b) query 参数跳转 session 页**未**实现 highlight/filter, click = reload 噪声;
              (c) 用户极少反向追溯 transfer 明细 (信任 settle 数学).
              v0.3 AI 大版本再考虑: 让 AI 解释 transfer ('Q 为啥欠 Jesse 2091.97').
            -->
            <div
              class="transfer-card"
              role="group"
              aria-label="转账 {fromName} → {toName} {fmt(t.amount)}"
            >
              <!-- 付款方 -->
              <div class="transfer-party">
                <div class="avatar" aria-hidden="true">{avatarLetter(fromName)}</div>
                <span class="transfer-name">{fromName}</span>
              </div>

              <!-- 金额 + 箭头 -->
              <div class="transfer-center">
                <span class="transfer-amount">{fmt(t.amount)}</span>
                <span class="transfer-arrow" aria-hidden="true">→</span>
              </div>

              <!-- 收款方 -->
              <div class="transfer-party">
                <div class="avatar" aria-hidden="true">{avatarLetter(toName)}</div>
                <span class="transfer-name">{toName}</span>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <!-- v0.3.14.1 (Bug B): currency breakdown in split view -->
    {#if viewMode === 'split' && data.currency_breakdown}
      <h3>按源币种</h3>
      <ul class="currency-breakdown" style="list-style: none; padding: 0; margin: 0 0 var(--space-4);">
        {#each Object.entries(data.currency_breakdown).sort((a, b) => (b[1].paid || 0) - (a[1].paid || 0)) as [ccy, breakdown] (ccy)}
          <li class="currency-row row between">
            <span class="ccy-name">{ccy}</span>
            <span class="ccy-detail">
              paid {fmt(breakdown.paid)} / consumed {fmt(breakdown.consumed)} / net
              <span class:pos={breakdown.net > 0} class:neg={breakdown.net < 0}>
                {breakdown.net > 0 ? '+' : ''}{fmt(breakdown.net)}
              </span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="hint" style="margin-top: var(--space-3);">
      生成时间: {fmtGenerated(data.generated_at)}
    </p>
  {/if}
</div>

<style>
  .bal-row {
    padding: var(--space-3) 0;
  }
  .amount {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }
  .amount.pos {
    color: var(--success-500);
  }
  .amount.neg {
    color: var(--error-500);
  }
  .currency-row {
    padding: var(--space-2) 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .ccy-name {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .ccy-detail {
    font-size: 0.85rem;
    color: var(--gray-500);
  }
  /* 反馈修 6 项目 5: 用户名 normal 字体 (不加粗) */
  .member-name {
    font-weight: 400;
    color: var(--gray-900);
  }
  .muted {
    color: var(--gray-500);
  }
  .hint {
    color: var(--gray-500);
    font-size: var(--font-size-sm);
  }
  .error {
    color: var(--error-500);
  }
  .settled-emoji {
    font-size: var(--font-size-base);
  }

  /* v0.2.1 T06: Transfer cards — click-through to session bills (see note at href). */
  .transfers-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .transfer-li {
    list-style: none;
  }
  .transfer-card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: white;
    border: 1px solid var(--gray-200);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    box-shadow: var(--shadow-sm);
    /* v0.2.1 T06 砍掉 (2026-07-03) — 转账卡片静态展示, 无 click / hover / press */
  }
  /* `.transfer-li` items are spaced by gap on .transfers-list — no extra
     per-card margin needed. */
  .transfer-party {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .avatar {
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
    font-size: 13px;
  }
  .transfer-name {
    font-weight: 400;
    color: var(--gray-700);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .transfer-center {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 0 var(--space-2);
  }
  .transfer-amount {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    font-size: 1rem;
    color: var(--gray-900);
  }
  .transfer-arrow {
    color: var(--gray-400);
    font-size: 18px;
    line-height: 1;
  }
</style>
