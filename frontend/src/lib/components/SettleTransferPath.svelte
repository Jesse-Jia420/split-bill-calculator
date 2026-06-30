<script lang="ts">
  import { onMount } from 'svelte';
  import { getSettle } from '$api/settle';
  import type { SettleResponse } from '$api/settle';
  import type { SessionDetail } from '$api/sessions';

  export let session: SessionDetail;
  /** map SessionMember.id -> display_name for friendly output */
  export let memberIdToName: Record<number, string> = {};

  let loading = true;
  let error: string | null = null;
  let data: SettleResponse | null = null;

  function fmt(n: number): string {
    return n.toFixed(2);
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
</script>

<div>
  {#if loading}
    <p class="muted">正在计算结算…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if data}
    <h3>每人净收/净付</h3>
    <ul class="list balances" style="list-style: none; padding: 0; margin: 0 0 var(--space-4);">
      {#each Object.entries(data.balances) as [mid, net] (mid)}
        <li class="bal-row row between">
          <span>{displayName(mid)}</span>
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
            <span>
              <strong>{displayName(t.from_member_id)}</strong>
              <span class="muted"> → </span>
              <strong>{displayName(t.to_member_id)}</strong>
            </span>
            <span class="amount">{fmt(t.amount)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="hint" style="margin-top: var(--space-3);">
      生成时间: {new Date(data.generated_at).toLocaleString('zh-CN')}
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
    color: var(--color-success);
  }
  .amount.neg {
    color: var(--color-error);
  }
</style>