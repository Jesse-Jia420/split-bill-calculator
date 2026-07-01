<script lang="ts">
  import { onMount } from 'svelte';
  import { getSettle } from '$api/settle';
  import type { MemberSettlement } from '$api/settle';
  import type { SessionDetail } from '$api/sessions';

  export let session: SessionDetail;

  let loading = true;
  let error: string | null = null;
  let members: MemberSettlement[] = [];

  function fmt(n: number): string {
    return n.toFixed(2);
  }

  function fmtDate(iso: string): string {
    try {
      // Strip tz/seconds for compact "MM-DD HH:MM" display.
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

  onMount(async () => {
    loading = true;
    error = null;
    try {
      const data = await getSettle(session.id);
      members = data.per_member ?? [];
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
    <p class="muted" style="margin-bottom: var(--space-3);">
      每个人付款多少、被分摊多少、净额多少、对应哪些账单。点击卡片展开明细。
    </p>
    <ul class="list member-list" style="list-style: none; padding: 0; margin: 0;">
      {#each members as m (m.member_id)}
        <li class="member-card">
          <details>
            <summary class="member-summary">
              <div class="avatar" aria-hidden="true">{avatarLetter(m.display_name)}</div>
              <div class="member-meta">
                <div class="row" style="gap: var(--space-2); align-items: baseline;">
                  <strong>{m.display_name}</strong>
                  {#if m.role === 'owner'}
                    <span class="badge">owner</span>
                  {/if}
                </div>
                <div class="member-stats">
                  <span class="stat paid">
                    付款 <strong>{fmt(m.total_paid)}</strong>
                  </span>
                  <span class="sep">·</span>
                  <span class="stat consumed">
                    消费 <strong>{fmt(m.total_consumed)}</strong>
                  </span>
                  <span class="sep">·</span>
                  <span class="stat net" class:pos={m.net > 0} class:neg={m.net < 0}>
                    {#if m.net > 0}
                      净 <strong>+{fmt(m.net)} (应收)</strong>
                    {:else if m.net < 0}
                      净 <strong>-{fmt(Math.abs(m.net))} (应付)</strong>
                    {:else}
                      净 <strong>0</strong>
                    {/if}
                  </span>
                </div>
              </div>
              <span class="toggle" aria-hidden="true">▸</span>
            </summary>

            <div class="member-detail">
              <h4>付款明细 ({m.paid_bills.length})</h4>
              {#if m.paid_bills.length === 0}
                <p class="muted">没有付过账单</p>
              {:else}
                <ul class="bill-sublist" style="list-style: none; padding: 0; margin: 0;">
                  {#each m.paid_bills as b (b.bill_id)}
                    <!--
                      v0.1.2 (PO 2026-07-01 fix #6): 2-row layout for bill
                      rows. Row 1: description (left, big-ish) + amount
                      (right, primary). Row 2: date + (独占/共享/账单总)
                      tags separated by "·". Mobile-safe (description
                      truncates, amount column doesn't shrink).
                    -->
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

              <h4 style="margin-top: var(--space-3);">消费明细 ({m.consumed_bills.length})</h4>
              {#if m.consumed_bills.length === 0}
                <p class="muted">没有被分摊的账单</p>
              {:else}
                <ul class="bill-sublist" style="list-style: none; padding: 0; margin: 0;">
                  {#each m.consumed_bills as b (b.bill_id)}
                    {@const excl = b.exclusive_amount ?? 0}
                    {@const shared = b.share_amount - excl}
                    <li class="bill-subrow">
                      <!--
                        v0.1.2 (fix #5+#6):
                        - Primary amount is the member's share
                          (b.share_amount), not the bill total. That's
                          what the user actually cares about.
                        - 独占 + 共享 tags only show when relevant:
                          独占 only when excl > 0 (avoid noise).
                        - 账单总 is muted secondary info at the end.
                      -->
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
          </details>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .member-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .member-card {
    border: 1px solid var(--color-border);
    border-radius: var(--radius, 8px);
    background: var(--color-bg, #fff);
    overflow: hidden;
  }
  .member-card details {
    width: 100%;
  }
  .member-summary {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
    cursor: pointer;
    list-style: none;
    min-height: var(--touch-target, 44px);
  }
  .member-summary::-webkit-details-marker {
    display: none;
  }
  .member-summary:focus-visible {
    outline: 2px solid var(--color-accent, #3b82f6);
    outline-offset: -2px;
  }
  .avatar {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--color-accent, #3b82f6);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 18px;
  }
  .member-meta {
    flex: 1 1 auto;
    min-width: 0;
  }
  .member-stats {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted, #666);
    margin-top: 2px;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    align-items: baseline;
  }
  .member-stats strong {
    color: var(--color-text, #111);
    font-variant-numeric: tabular-nums;
    margin-left: 2px;
  }
  .member-stats .sep {
    color: var(--color-text-muted, #999);
  }
  .member-stats .net.pos strong {
    color: var(--color-success, #16a34a);
  }
  .member-stats .net.neg strong {
    color: var(--color-error, #dc2626);
  }
  .toggle {
    flex: 0 0 auto;
    font-size: 18px;
    color: var(--color-text-muted, #666);
    transition: transform 0.15s ease;
  }
  details[open] .toggle {
    transform: rotate(90deg);
  }
  .member-detail {
    padding: 0 var(--space-3) var(--space-3);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
  }
  .member-detail h4 {
    margin: 0 0 var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--color-text-muted, #666);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .bill-sublist {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .bill-subrow {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) 0;
    border-bottom: 1px dashed var(--color-border);
  }
  .bill-subrow:last-child {
    border-bottom: none;
  }
  .row1 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .row2 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1);
    font-size: var(--font-size-sm);
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
    font-size: 1rem; /* primary: bigger than muted row 2 */
  }
  .bill-sub-date {
    font-variant-numeric: tabular-nums;
  }
  .tag {
    /* Small tag-like inline label for 独占 / 共享. */
    display: inline-block;
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
  .badge {
    display: inline-block;
    background: var(--color-accent, #3b82f6);
    color: #fff;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    font-weight: 500;
  }
</style>
