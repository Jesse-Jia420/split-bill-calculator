<script lang="ts">
  /**
   * v0.1.2 反馈修3 (PO 2026-07-01 20:30 UX 改写) — bills grouped list。
   *
   * 本次改写涉及 T10 + T11 (8 项 UX 改写中的 2+3):
   * - T10 (day header 排版): summary 内分 day-header-main (日期 / 合计金额 1rem 600) +
   *   day-header-sub (「人均 X · N 笔」 + (合计) 标签)。单位 THB 10px 紧跟数字。
   *   折叠箭头 +/- 字符(不用 ▸ rotate),flex-wrap 控制好 375px 不跳。
   * - T11 (bill item 排版): 每行 row1 (description + 金额 + ⋯ 菜单) + row2 (时间·付款人·人均 + 右侧「你分摊 X」若当前用户在 participants)。
   *   整行 hover/focus 背景 + cursor pointer + 键盘可达。
   *   props 加 currentUserMemberId: number | null。
   *
   * 历史 v0.1.2:
   * - T1+T2 (`73e5cb9`): <details>+<summary> 单 source of truth; total + per-capita 共享 font-size-sm
   * - 反馈修2 (`e77163a`): bill row click 跳编辑 + delete stopPropagation
   *
   * 反模式预防:
   * - T11 整行 button vs 内嵌 button — 不能嵌套 button。用 div + role=button + tabindex + keyboard handler
   *   或者外层 button + 内部 ⋯ 菜单 button 也用 stopPropagation 不嵌套。
   *   用外层 svelte 提供的 clickable row + 内部 stops propagation 的 ⋯ 按钮。
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { Bill } from '$api/bills';

  export let bills: Bill[];
  export let sessionId: number;
  /** map SessionMember.id -> display_name, used in the bill row meta. */
  export let memberIdToName: Record<number, string> = {};
  /** T11: 当前登录人在此 session 内的 member_id。用于「你分摊 X」高亮显示。
   *  null 表示当前用户不是 session member 或未登录。 */
  export let currentUserMemberId: number | null = null;
  /** Called when the user confirms deletion of a bill. */
  export let onDelete: ((billId: number) => void | Promise<void>) | null = null;

  type Group = {
    date: string;
    bills: Bill[];
    total: number;
    currency: string;
    perCapita: number;
  };

  let collapsed: Record<string, boolean> = {};
  /** T11: 当前打开 ⋯ 菜单的 bill id, 用于控制菜单 popover */
  let openMenuForBillId: number | null = null;

  function localDateKey(iso: string): string {
    // YYYY-MM-DD in Asia/Shanghai. We avoid `toISOString()` because that
    // forces UTC and would shift the bucket for late-evening entries.
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
    // Per-bill AA: Σ (bill.amount / bill.participants.length).
    // The spec calls out that this is NOT total / num_members -- it
    // weights each bill by the number of people who actually shared
    // that specific expense.
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
      // Within group: earliest first.
      const sorted = [...list].sort((a, b) => {
        const ta = new Date(a.occurred_at).getTime();
        const tb = new Date(b.occurred_at).getTime();
        if (ta !== tb) return ta - tb;
        return a.id - b.id;
      });
      const total = sorted.reduce((acc, b) => acc + b.amount, 0);
      // Currency: v0.1 simplification -- we assume single currency per
      // session (multi-currency is v0.2). Take the first bill's currency.
      const currency = sorted[0]?.currency ?? '';
      out.push({
        date,
        bills: sorted,
        total,
        currency,
        perCapita: computePerCapita(sorted),
      });
    }
    // Newest date first.
    out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return out;
  }

  // Reactive: recompute when bills prop changes.
  $: groups = buildGroups(bills);

  function fmtAmount(n: number): string {
    return n.toFixed(2);
  }

  function fmtBillTime(iso: string): string {
    try {
      const d = new Date(iso);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    } catch {
      return iso;
    }
  }

  function payerName(b: Bill): string {
    return memberIdToName[b.payer_id] ?? ('#' + b.payer_id);
  }

  /** T11: 当前用户的 share_amount (per-bill AA),如果当前用户在 participants 里。
   * PO 要求: AA = bill.amount / bill.participants.length,不考虑 exclusive 差异。
   * 不在 participants 内 → null (UI 不显示「你分摊」)。 */
  function yourShare(b: Bill): number | null {
    if (currentUserMemberId === null || currentUserMemberId === undefined) return null;
    const inPart = (b.participants ?? []).some((p) => p.member_id === currentUserMemberId);
    if (!inPart) return null;
    const n = b.participants?.length ?? 0;
    if (n <= 0) return null;
    return b.amount / n;
  }

  function storageKey(): string {
    return `sbc.billGroupCollapsed.${sessionId}`;
  }

  function loadCollapsedState() {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(storageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        collapsed = { ...collapsed, ...parsed };
      }
    } catch {
      // ignore corrupt localStorage
    }
  }

  function saveCollapsedState() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(collapsed));
    } catch {
      // localStorage might be full or disabled; non-fatal
    }
  }

  function isOpen(date: string): boolean {
    return !collapsed[date];
  }

  function onGroupToggle(date: string, e: Event) {
    const el = e.currentTarget as HTMLDetailsElement;
    const isOpenNow = el.open;
    collapsed = { ...collapsed, [date]: !isOpenNow };
    saveCollapsedState();
  }

  /** 跳转到 bill 编辑页 (T1 行为沿用) */
  function openBillEdit(billId: number) {
    goto(`/sessions/${sessionId}/bills/${billId}/edit`);
  }

  /** 整行点击/键盘触发编辑 (T11 增强: 整行可点 + 键盘可达) */
  function onBillRowClick(billId: number, e: MouseEvent | KeyboardEvent) {
    // 阻止内部 button (e.g. ⋯ 菜单) 触发表层跳转
    const t = e.target as HTMLElement;
    if (t.closest('button, a, .bill-menu-popover')) return;
    openBillEdit(billId);
  }

  function onBillRowKey(billId: number, e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      // 键盘触发时,焦点在内部 button 时不响应
      const t = e.target as HTMLElement;
      if (t !== e.currentTarget && t.closest('button')) return;
      e.preventDefault();
      openBillEdit(billId);
    } else if (e.key === 'Escape') {
      openMenuForBillId = null;
    }
  }

  /** T11: ⋯ 菜单 toggle */
  function toggleMenu(billId: number, e: MouseEvent) {
    e.stopPropagation();
    openMenuForBillId = openMenuForBillId === billId ? null : billId;
  }

  function closeMenu() {
    openMenuForBillId = null;
  }

  function onMenuEdit(billId: number, e: MouseEvent) {
    e.stopPropagation();
    closeMenu();
    openBillEdit(billId);
  }

  function onMenuDelete(billId: number, e: MouseEvent) {
    e.stopPropagation();
    closeMenu();
    if (onDelete) {
      // onDelete is async; intentionally not awaited.
      void onDelete(billId);
    }
  }

  /** 兼容: inline delete 按钮 (PO 允许保留作为兜底) */
  function onDeleteClick(billId: number, e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    if (onDelete) {
      void onDelete(billId);
    }
  }

  onMount(() => {
    loadCollapsedState();
    // outside-click 关闭 ⋯ 菜单
    const onDocClick = () => {
      if (openMenuForBillId !== null) openMenuForBillId = null;
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  });
</script>

<div class="bill-grouped">
  {#if !bills || bills.length === 0}
    <p class="muted">
      还没有账单,<a href="/sessions/{sessionId}/bills/new">点"+ 新建账单"开始</a>。
    </p>
  {:else}
    <ul class="day-list" style="list-style: none; padding: 0; margin: 0;">
      {#each groups as g (g.date)}
        <li class="day-group">
          <details open={isOpen(g.date)} on:toggle={(e) => onGroupToggle(g.date, e)}>
            <summary class="day-header">
              <span class="day-toggle" aria-hidden="true">{isOpen(g.date) ? '−' : '+'}</span>
              <!-- T10: 主行: 日期(左 1rem 600) + 合计金额(右 1rem 600 tabular-nums) -->
              <div class="day-header-main">
                <span class="day-date">{g.date}</span>
                <span class="day-total">
                  {fmtAmount(g.total)}<span class="unit">{g.currency}</span>
                </span>
              </div>
              <!-- T10: 副行: 人均 X · N 笔 + 右侧 (合计) muted -->
              <div class="day-header-sub">
                <span class="muted">人均 {fmtAmount(g.perCapita)}{g.currency} · {g.bills.length} 笔</span>
                <span class="muted">(合计)</span>
              </div>
            </summary>

            <ul class="day-bills" style="list-style: none; padding: 0; margin: 0;">
              {#each g.bills as b (b.id)}
                {@const share = yourShare(b)}
                <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                <li
                  class="bill-row"
                  role="button"
                  tabindex="0"
                  aria-label="打开账单: {b.description || '(无说明)'}"
                  on:click={(e) => onBillRowClick(b.id, e)}
                  on:keydown={(e) => onBillRowKey(b.id, e)}
                >
                  <!-- T11: row1 - description + 金额 + ⋯ 菜单 -->
                  <div class="bill-row1">
                    <span class="bill-desc">{b.description || '(无说明)'}</span>
                    <span class="bill-amount">
                      {fmtAmount(b.amount)}<span class="unit">{b.currency}</span>
                    </span>
                    {#if onDelete}
                      <button
                        type="button"
                        class="bill-menu-btn"
                        aria-label="账单菜单"
                        title="菜单"
                        aria-haspopup="menu"
                        aria-expanded={openMenuForBillId === b.id}
                        on:click={(e) => toggleMenu(b.id, e)}
                      >⋯</button>
                    {/if}
                  </div>
                  <!-- T11: row2 - 时间·付款人·人均 muted + 右侧 你分摊 X (accent) -->
                  <div class="bill-row2 muted">
                    <span class="bill-meta-line">
                      {fmtBillTime(b.occurred_at)} · {payerName(b)} 付 · {b.participants.length} 人均 {fmtAmount(b.amount / Math.max(1, b.participants.length))}{b.currency}
                    </span>
                    {#if share !== null}
                      <span class="your-share">你分摊 {fmtAmount(share)}<span class="unit">{b.currency}</span></span>
                    {/if}
                  </div>

                  {#if openMenuForBillId === b.id}
                    <!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
                    <!-- T11: ⋯ 菜单 popover -->
                    <div class="bill-menu-popover" role="menu" on:click|stopPropagation>
                      <button
                        type="button"
                        role="menuitem"
                        class="bill-menu-item"
                        on:click={(e) => onMenuEdit(b.id, e)}
                      >编辑</button>
                      {#if onDelete}
                        <button
                          type="button"
                          role="menuitem"
                          class="bill-menu-item danger"
                          on:click={(e) => onMenuDelete(b.id, e)}
                        >删除</button>
                      {/if}
                    </div>
                  {/if}

                  <!-- 兼容: inline delete 按钮 (PO 允许保留,移动端 ⋯ 菜单为主) -->
                  {#if onDelete}
                    <div class="bill-row-inline-delete">
                      <button
                        type="button"
                        class="ghost btn-sm"
                        on:click={(e) => onDeleteClick(b.id, e)}
                      >删除</button>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </details>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .day-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .day-group {
    border: 1px solid var(--color-border);
    border-radius: var(--radius, 8px);
    overflow: hidden;
    background: var(--color-bg, #fff);
  }
  .day-group details {
    width: 100%;
  }

  /* === T10: day header 排版 (主行 + 副行) === */
  .day-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
    list-style: none;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface, #fff);
    min-height: var(--touch-target, 44px);
    flex-wrap: wrap;
    position: relative;
  }
  .day-header::-webkit-details-marker {
    display: none;
  }
  .day-header:focus-visible {
    outline: 2px solid var(--color-accent, #3b82f6);
    outline-offset: -2px;
  }
  /* T10: 折叠箭头 +/− 字符,放左上 */
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
    color: var(--color-text-muted, #666);
    line-height: 1;
    font-weight: 400;
  }
  /* 让主行/副行有左 padding 给 toggle 留位 */
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
  }
  /* T10: 货币单位 10px, 紧跟数字 */
  .unit {
    font-size: 10px;
    font-weight: 400;
    margin-left: 2px;
    color: inherit;
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
  }

  .day-bills {
    padding: 0 var(--space-3);
    border-top: 1px solid var(--color-border);
  }

  /* === T11: bill row 2 行排版 (复用 Coder 7 的 .row1/.row2 风格) === */
  .bill-row {
    position: relative;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    transition: background-color 0.12s ease;
    outline: none;
  }
  .bill-row:last-child {
    border-bottom: none;
  }
  /* T11: 整行 hover/focus 背景高亮 (不依赖 underline) */
  .bill-row:hover {
    background: rgba(0, 0, 0, 0.04);
  }
  .bill-row:focus-visible {
    background: rgba(0, 0, 0, 0.06);
    box-shadow: inset 2px 0 0 var(--color-accent, #3b82f6);
  }

  .bill-row1 {
    display: flex;
    align-items: baseline;
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
    color: var(--color-text);
  }
  .bill-menu-btn {
    flex: 0 0 auto;
    appearance: none;
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted, #666);
    width: 32px;
    height: 32px;
    min-height: 32px;
    padding: 0;
    border-radius: 50%;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: var(--space-1);
  }
  .bill-menu-btn:hover {
    background: rgba(0, 0, 0, 0.06);
    color: var(--color-text);
    border-color: var(--color-accent, #3b82f6);
  }
  .bill-menu-btn[aria-expanded='true'] {
    background: var(--color-accent, #3b82f6);
    color: #fff;
    border-color: var(--color-accent, #3b82f6);
  }

  .bill-row2 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: 2px;
    font-size: var(--font-size-sm);
  }
  .bill-meta-line {
    flex: 1 1 auto;
    min-width: 0;
  }
  .your-share {
    flex: 0 0 auto;
    font-weight: 600;
    color: var(--color-accent, #3b82f6);
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-sm);
  }

  /* T11: ⋯ 菜单 popover */
  .bill-menu-popover {
    position: absolute;
    top: 36px;
    right: var(--space-3);
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border);
    border-radius: var(--radius, 8px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
    padding: var(--space-1);
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: 110px;
  }
  .bill-menu-item {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 8px 12px;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    font: inherit;
    color: var(--color-text);
    min-height: 32px;
  }
  .bill-menu-item:hover {
    background: rgba(0, 0, 0, 0.06);
  }
  .bill-menu-item.danger {
    color: var(--color-error, #dc2626);
  }
  .bill-menu-item.danger:hover {
    background: rgba(239, 68, 68, 0.08);
  }

  /* 兼容 inline delete (桌面端兜底) */
  .bill-row-inline-delete {
    display: none; /* 默认隐藏, ⋯ 菜单是主入口 */
  }
  /* 桌面端可保留 inline delete 作为备选(PO 明确「桌面端可保留」) */
  @media (min-width: 720px) {
    .bill-row-inline-delete {
      display: block;
      position: absolute;
      bottom: var(--space-3);
      right: 0;
    }
  }

  .btn-sm {
    min-height: 36px;
    padding: 4px 10px;
    font-size: var(--font-size-sm);
  }
</style>
