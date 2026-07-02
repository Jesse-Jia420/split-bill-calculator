<script lang="ts">
  /**
   * v0.1.3 Sprint 2 Commit 1 (2026-07-02) — Transfer path 转账建议。
   *
   * 本次 Commit 1 改动:
   * - T6 千分位: 删除手写数字格式化,统一切到 $lib/utils/format.formatMoney。
   *   - 日期生成时间也走 formatDate({ full: true }) → "2026年7月2日 17:42"
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token。
   *
   * T11 (转账路径卡片化) 在 Commit 2。
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

  let loading = true;
  let error: string | null = null;
  let data: SettleResponse | null = null;

  /** T6: 金额显示用 formatMoney (千分位)。 */
  function fmt(n: number): string {
    return formatMoney(n, { showSymbol: false });
  }

  onMount(async () => {
    loading = true;
    error = null;
    try {
      data = await getSettle(session.id);
    } catch (e: any) {
      error = e?.message ?? 'failed to load settlement';
    } finally {
      loading = false;
    }
  });

  function displayName(memberId: number | string): string {
    const id = Number(memberId);
    return memberIdToName[id] ?? ('#' + id);
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
      <p class="muted">所有人都已结清 🎉</p>
    {:else}
      <ul class="list transfers" style="list-style: none; padding: 0; margin: 0;">
        {#each data.transfers as t, i (i)}
          <li class="t-row row between">
            <span class="transfer-pair">
              <!-- 反馈修 6 项目 5: 用户名不再加粗,用 normal font-weight -->
              <span class="member-name">{displayName(t.from_member_id)}</span>
              <span class="muted arrow" aria-hidden="true">→</span>
              <span class="member-name">{displayName(t.to_member_id)}</span>
            </span>
            <span class="amount">{fmt(t.amount)}</span>
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
  .bal-row,
  .t-row {
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
  /* 反馈修 6 项目 5: 用户名 normal 字体 (不加粗) */
  .member-name {
    font-weight: 400;
    color: var(--gray-900);
  }
  .transfer-pair {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .arrow {
    font-weight: 400;
    font-size: 0.9em;
    opacity: 0.7;
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
</style>
