<script lang="ts">
  /**
   * v0.1.3 Sprint 2 Commit 2 (2026-07-02) — Transfer path 转账建议。
   *
   * 本次 Commit 2 改动:
   * - T11 转账路径卡片化: 每笔转账独立 card,付款方→收款方头像+名字,金额居中
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token (已在 Commit 1 完成)
   *
   * v0.3.15 (PRD §3.15.2 #2) — 金额前缀币种符号:
   * - balances / transfers 之前走 formatMoney({showSymbol:false}) 显示纯数字,
   *   没单位时容易跟"主币种"混淆。PO 拍板: 在数字前面拼币种符号, 让用户
   *   一眼读出"这是 ¥xxx 还是 ฿xxx"。session primary 用其符号;
   *   currency_breakdown (按源币种) 用每个币种各自的符号。
   * - 取符号走 `$lib/utils/currency` 的 currencySymbol() 函数, 跟 BillForm
   *   共用一个映射 (CNY ¥ / THB ฿ / JPY ¥ / USD $)。
   *
   * v0.3.15 (PO #4807 + Designer 报告) — 错误统一走 Toast.
   * - 删 `let error` 状态 + `<div class="error">` 模板
   * - fetchSettle catch → toast.error() (失败时主容器直接空, 用户能 retry)
   * - data 加载失败/无数据 → 用 `.muted` "暂无结算数据" 占位, 替代原 error 块
   *
   * 沿用:
   * - v0.1.2 反馈修 6 项目 5 (用户名不加粗,转帐箭头克制)
   */
  import { onMount } from 'svelte';
  import { getSettle } from '$api/settle';
  import { formatMoney, formatDate } from '$lib/utils/format';
  import { currencySymbol } from '$lib/utils/currency';
  import { toast } from '$stores/toast';
  import type { SettleResponse } from '$api/settle';
  import type { SessionDetail } from '$api/sessions';

  export let session: SessionDetail;
  /** map SessionMember.id -> display_name for friendly output */
  export let memberIdToName: Record<number, string> = {};
  /** v0.2.2 (T11): re-fetch when the user toggles primary/split. */
  export let viewMode: 'primary' | 'split' = 'primary';

  let loading = true;
  let data: SettleResponse | null = null;
  // Track the current view so we don't show stale data after a toggle.
  let loadedView: 'primary' | 'split' = viewMode;

  /** T6: 金额显示用 formatMoney (千分位)。 */
  function fmt(n: number): string {
    return formatMoney(n, { showSymbol: false });
  }

  /** v0.3.15 §3.15.2 #2 — 金额前缀币种符号.
   * `ccy` 留空时回退成无符号, 跟 fmt() 一致 (调试场景用)。 */
  function fmtWithSymbol(n: number, ccy: string): string {
    const sym = currencySymbol(ccy);
    const body = fmt(n);
    return sym ? sym + body : body;
  }

  // v0.2.2 (T11): refetch whenever viewMode flips so the primary / split
  // representation stays in sync with what the user selected.
  async function fetchSettle(targetView: 'primary' | 'split') {
    loading = true;
    try {
      data = await getSettle(session.id, targetView);
      loadedView = targetView;
    } catch (e: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast, 失败时把 data 清掉让模板走空态
      data = null;
      toast.error(e?.message ?? '加载结算失败');
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

</script>

<div>
  {#if loading}
    <p class="muted">正在计算结算…</p>
  {:else if data}
    <h3>每人净收/净付</h3>
    <ul class="list balances" style="list-style: none; padding: 0; margin: 0 0 var(--space-4);">
      {#each Object.entries(data.balances) as [mid, net], i (mid)}
        <li class="bal-row row between">
          <span class="member-name">{displayName(mid)}</span>
          <span class:pos={net > 0} class:neg={net < 0} class="amount">
            {net > 0 ? '+' : ''}{fmtWithSymbol(net, session.primary_currency)}
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
              aria-label="转账 {fromName} → {toName} {fmtWithSymbol(t.amount, session.primary_currency)}"
            >
              <!-- 付款方 -->
              <div class="transfer-party">
                <div class="avatar" aria-hidden="true">{avatarLetter(fromName)}</div>
                <span class="transfer-name">{fromName}</span>
              </div>

              <!-- 金额 + 箭头 -->
              <div class="transfer-center">
                <span class="transfer-amount">{fmtWithSymbol(t.amount, session.primary_currency)}</span>
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
              paid {fmtWithSymbol(breakdown.paid, ccy)} / consumed {fmtWithSymbol(breakdown.consumed, ccy)} / net
              <span class:pos={breakdown.net > 0} class:neg={breakdown.net < 0}>
                {breakdown.net > 0 ? '+' : ''}{fmtWithSymbol(breakdown.net, ccy)}
              </span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}

  {:else}
    <!-- v0.3.15 (PO #4807): 失败后 data=null, 显示"暂无数据"占位让用户能切 tab / 刷新重试 -->
    <p class="muted">暂无结算数据,请稍后再试。</p>
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
    font-size: var(--font-size-base);
  }
  .ccy-detail {
    font-size: var(--font-size-sm);
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
  /* v0.3.17 #21 (PO msg 13:51 item 3): transfer-card 玻璃化统一 (Liquid Glass)
     跟全站 member-chip / swipe button / fab / 登录按钮同语言 (iOS 27 glass-pill)。
     保留原有 static layout (无 click / hover), 只换 surface 视觉。
     ===
     v0.3.18 #48 (PO msg 19:10 #6489 全站透明化 sweep): bg 0.65/0.45 → 0.30/0.18
     (× 0.46 透明度降级, 让 peach→rose→lavender 背景图透过来).
     border indigo 0.10 → 0.15 (边缘补偿). inset highlight 0.7 → 0.85 (玻璃上沿加强).
     外阴影 indigo 0.06 → 0.10 (跟全站玻璃阴影同源).
     transfer-card 内 .transfer-amount / .transfer-name 加 text-shadow 防低对比. */
  .transfer-card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-lg, 12px);
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.30) 0%,
      rgba(255, 255, 255, 0.18) 100%
    );
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.85),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 4px rgba(99, 102, 241, 0.10);
    border: 1px solid rgba(99, 102, 241, 0.15);
  }
  @supports not (backdrop-filter: blur(1px)) {
    /* v0.3.18 #48: fallback 0.92 → 0.55 (跟新 base 同比例降级, 仍提供 fallback opaque 可读性) */
    .transfer-card { background: rgba(255, 255, 255, 0.55); }
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
  /* v0.3.23 #132 (UAT old #4): 玻璃质感增强 — Option B (rgba 0.88 半透明 + backdrop-filter + 4-layer glass shadow),
     跟 .avatar-a / .avatar-mini 统一语言. */
  .avatar {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    /* var(--accent-500) = #3b82f6, alpha 0.88 让 backdrop-filter 在 glass parent 上有 glass on glass 效果 */
    background: rgba(59, 130, 246, 0.88);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: var(--font-size-sm);
    border: 1.5px solid #fff;
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 1px 2px rgba(0, 0, 0, 0.08);
  }
  .transfer-name {
    font-weight: 400;
    color: var(--gray-700);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* v0.3.18 #48: transfer-card 玻璃变透后, 名字文字加白色微晕防低对比 */
    text-shadow: 0 0.5px 1px rgba(255, 255, 255, 0.7);
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
    font-size: var(--font-size-base);
    color: var(--gray-900);
    white-space: nowrap; /* v0.3.17 #34: PO 反馈 amount 折行 */
    /* v0.3.18 #48: 金额 (hero 数字) 加白色微晕, 数字 weight 600 已够粗, 微晕补偿玻璃透明度损失 */
    text-shadow: 0 1px 2px rgba(255, 255, 255, 0.7);
  }
  .transfer-arrow {
    color: var(--gray-400);
    font-size: var(--font-size-lg);
    line-height: 1;
  }
</style>
