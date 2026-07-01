<script lang="ts">
  /**
   * v0.1.2 (T20+T21): grouped bill list.
   *
   * - Bills are grouped by the LOCAL date of `occurred_at` (Asia/Shanghai
   *   per the server / environment; `Intl.DateTimeFormat` with a fixed
   *   timezone gives deterministic "YYYY-MM-DD" labels).
   * - Groups are ordered newest date first.
   * - Within a group, bills are ordered earliest first (so the day's
   *   chronological order is natural).
   * - Each group header shows: date · total spend (Σ amount) · weighted
   *   per-capita (Σ amount_i / count_i, PO 2026-06-30).
   * - Group collapsed/expanded state is persisted in localStorage keyed
   *   by sessionId+date so users keep their preferences across reloads.
   */
  import { onMount } from 'svelte';
  import type { Bill } from '$api/bills';

  export let bills: Bill[];
  export let sessionId: number;
  /** map SessionMember.id -> display_name, used in the bill row meta. */
  export let memberIdToName: Record<number, string> = {};
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

  function toggleGroup(date: string) {
    collapsed = { ...collapsed, [date]: !collapsed[date] };
    saveCollapsedState();
  }

  function isCollapsed(date: string): boolean {
    // Default: expanded. The collapsed map only stores overrides (true).
    return collapsed[date] === true;
  }

  onMount(() => {
    loadCollapsedState();
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
          <button
            type="button"
            class="day-header"
            aria-expanded={!isCollapsed(g.date)}
            on:click={() => toggleGroup(g.date)}
          >
            <span class="day-toggle" aria-hidden="true">
              {isCollapsed(g.date) ? '▸' : '▾'}
            </span>
            <span class="day-date">{g.date}</span>
            <span class="day-total">{fmtAmount(g.total)} {g.currency}</span>
            <span class="day-capita">
              <span class="muted">人均</span> {fmtAmount(g.perCapita)} {g.currency}
            </span>
          </button>

          {#if !isCollapsed(g.date)}
            <ul class="day-bills" style="list-style: none; padding: 0; margin: 0;">
              {#each g.bills as b (b.id)}
                <li class="bill-row">
                  <div class="row between" style="flex-wrap: wrap; gap: var(--space-2);">
                    <div>
                      <div class="bill-desc">{b.description || '(无说明)'}</div>
                      <div class="muted bill-meta">
                        <span class="bill-time">{fmtBillTime(b.occurred_at)}</span>
                        <span class="muted"> · </span>
                        <span>{payerName(b)} 付</span>
                        <span class="muted"> · </span>
                        <span>{b.participants.length} 人</span>
                      </div>
                    </div>
                    <div class="row" style="gap: var(--space-2);">
                      <span class="amount">{fmtAmount(b.amount)} {b.currency}</span>
                      {#if onDelete}
                        <button
                          type="button"
                          class="ghost btn-sm"
                          on:click={() => onDelete?.(b.id)}
                        >
                          删除
                        </button>
                      {/if}
                    </div>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
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
  .day-header {
    width: 100%;
    background: var(--color-surface, #fff);
    border: none;
    border-bottom: 1px solid var(--color-border);
    padding: var(--space-2) var(--space-3);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    cursor: pointer;
    text-align: left;
    font-size: inherit;
    min-height: var(--touch-target, 44px);
    flex-wrap: wrap;
  }
  .day-header:focus-visible {
    outline: 2px solid var(--color-accent, #3b82f6);
    outline-offset: -2px;
  }
  .day-toggle {
    font-size: 16px;
    color: var(--color-text-muted, #666);
    flex: 0 0 auto;
  }
  .day-date {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
  }
  .day-total {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-text, #111);
    flex: 0 0 auto;
  }
  .day-capita {
    font-size: var(--font-size-sm, 13px);
    color: var(--color-text-muted, #666);
    flex: 0 1 auto;
    text-align: right;
    margin-left: auto;
  }
  .day-bills {
    padding: 0 var(--space-3);
  }
  .bill-row {
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-border);
  }
  .bill-row:last-child {
    border-bottom: none;
  }
  .bill-desc {
    font-weight: 500;
  }
  .bill-meta {
    font-size: var(--font-size-sm);
    margin-top: 2px;
  }
  .bill-time {
    font-variant-numeric: tabular-nums;
  }
  .amount {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .btn-sm {
    min-height: 36px;
    padding: 4px 10px;
    font-size: var(--font-size-sm);
  }
</style>