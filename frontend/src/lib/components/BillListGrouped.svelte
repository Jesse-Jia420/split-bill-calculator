<script lang="ts">
  /**
   * v0.1.2 (T20+T21): grouped bill list.
   *
   * v0.1.2 (PO 2026-07-01 fix #1+#2):
   * - Collapse: now uses native <details>/<summary> + a one-line `on:toggle`
   *   sync, mirroring the pattern in SettleMemberBreakdown. The previous
   *   version called `isCollapsed(date)` from a function and relied on
   *   Svelte 5 reactive tracking to update the DOM, but the JSX expression
   *   `{#if !isCollapsed(g.date)}` only re-evaluated when the *function
   *   reference* changed, not when the underlying `collapsed[date]` value
   *   changed. Native <details> flips the `open` attribute for free.
   * - Typography (fix #2): total spend and per-capita now share the
   *   smaller secondary text size. Date stays slightly larger as the
   *   visual anchor. Layout: date · total · "·" · per-capita — single
   *   horizontal row, dot-separated, with the date slightly larger to
   *   lead the eye.
   *
   * Original notes (T20+T21):
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
  import { goto } from '$app/navigation';
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

  /**
   * v0.1.2 fix #1: now the <details> `open` attribute is the single
   * source of truth for the DOM, and we sync it to localStorage via
   * `on:toggle`. This avoids the Svelte 5 reactivity quirk where
   * `isCollapsed(date)` (a regular function call) didn't trigger a
   * re-render of the `{#if !isCollapsed(...)}` block when only
   * `collapsed[date]` changed.
   */
  function isOpen(date: string): boolean {
    return !collapsed[date];
  }

  function onGroupToggle(date: string, e: Event) {
    const el = e.currentTarget as HTMLDetailsElement;
    const isOpenNow = el.open;
    collapsed = { ...collapsed, [date]: !isOpenNow };
    saveCollapsedState();
  }

  /**
   * v0.1.2 (PO 2026-07-01 fix #3): clicking a bill row opens the
   * edit page. Delete button stops propagation so its handler
   * doesn't double as a row click.
   */
  function openBillEdit(billId: number) {
    goto(`/sessions/${sessionId}/bills/${billId}/edit`);
  }

  function onDeleteClick(billId: number, e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    if (onDelete) {
      // onDelete is async; intentionally not awaited.
      void onDelete(billId);
    }
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
          <details open={isOpen(g.date)} on:toggle={(e) => onGroupToggle(g.date, e)}>
            <summary class="day-header">
              <span class="day-toggle" aria-hidden="true">▸</span>
              <span class="day-date">{g.date}</span>
              <span class="day-sep" aria-hidden="true">·</span>
              <span class="day-capita">
                <span class="muted">人均</span> {fmtAmount(g.perCapita)} {g.currency}
              </span>
              <span class="day-sep" aria-hidden="true">·</span>
              <span class="day-total">
                <span class="muted">总</span> {fmtAmount(g.total)} {g.currency}
              </span>
            </summary>

            <ul class="day-bills" style="list-style: none; padding: 0; margin: 0;">
              {#each g.bills as b (b.id)}
                <li class="bill-row">
                  <div class="row between" style="flex-wrap: wrap; gap: var(--space-2);">
                    <button
                      type="button"
                      class="bill-link"
                      on:click={() => openBillEdit(b.id)}
                    >
                      <span class="bill-desc">{b.description || '(无说明)'}</span>
                      <span class="muted bill-meta">
                        <span class="bill-time">{fmtBillTime(b.occurred_at)}</span>
                        <span class="muted"> · </span>
                        <span>{payerName(b)} 付</span>
                        <span class="muted"> · </span>
                        <span>{b.participants.length} 人</span>
                      </span>
                    </button>
                    <div class="row" style="gap: var(--space-2);">
                      <span class="amount">{fmtAmount(b.amount)} {b.currency}</span>
                      {#if onDelete}
                        <button
                          type="button"
                          class="ghost btn-sm"
                          on:click={(e) => onDeleteClick(b.id, e)}
                        >
                          删除
                        </button>
                      {/if}
                    </div>
                  </div>
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
  .day-header {
    /* Typography (v0.1.2 fix #2): date is the visual anchor (slightly
       larger, base size, weight 600); total + per-capita share the
       same smaller secondary text size so they read as a pair. */
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    cursor: pointer;
    list-style: none;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface, #fff);
    min-height: var(--touch-target, 44px);
    flex-wrap: wrap;
  }
  .day-header::-webkit-details-marker {
    display: none;
  }
  .day-header:focus-visible {
    outline: 2px solid var(--color-accent, #3b82f6);
    outline-offset: -2px;
  }
  .day-toggle {
    font-size: 14px;
    color: var(--color-text-muted, #666);
    flex: 0 0 auto;
    line-height: 1;
    transition: transform 0.15s ease;
    align-self: center;
  }
  details[open] .day-toggle {
    transform: rotate(90deg);
  }
  .day-date {
    font-weight: 600;
    font-size: 1rem; /* base — visual anchor */
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
  }
  .day-sep {
    color: var(--color-text-muted, #999);
    flex: 0 0 auto;
    font-size: var(--font-size-sm, 13px);
  }
  .day-capita,
  .day-total {
    /* Same size + weight for total and per-capita (fix #2). Both read
       as secondary information underneath the date anchor. */
    font-size: var(--font-size-sm, 13px);
    color: var(--color-text-muted, #666);
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
  }
  .day-total {
    margin-left: auto;
    text-align: right;
  }
  .day-bills {
    padding: 0 var(--space-3);
    border-top: 1px solid var(--color-border);
  }
  .bill-row {
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-border);
  }
  .bill-link {
    /* The whole left side of the row is a real <button> so the row
       is keyboard-accessible. The amount + delete button on the
       right sit outside this button. */
    appearance: none;
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .bill-link:hover .bill-desc {
    text-decoration: underline;
  }
  .bill-link:focus-visible {
    outline: 2px solid var(--color-accent, #3b82f6);
    outline-offset: 2px;
    border-radius: 2px;
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
