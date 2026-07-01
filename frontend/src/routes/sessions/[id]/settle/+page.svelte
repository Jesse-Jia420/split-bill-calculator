<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { getSession } from '$api/sessions';
  import type { SessionDetail } from '$api/sessions';
  import SettleTransferPath from '$components/SettleTransferPath.svelte';
  import SettleMemberBreakdown from '$components/SettleMemberBreakdown.svelte';

  let session: SessionDetail | null = null;
  let loading = true;
  let error: string | null = null;

  $: sessionId = Number($page.params.id);

  // map SessionMember.id -> display_name (for friendly labels)
  let memberIdToName: Record<number, string> = {};
  let memberIdToRole: Record<number, string> = {};

  // v0.1.2 (T18): tab switcher for the settlement view.
  // 'overview' = existing balances + transfers; 'personal' = per-member breakdown.
  type Tab = 'overview' | 'personal';
  let activeTab: Tab = 'overview';

  onMount(async () => {
    try {
      session = await getSession(sessionId);
      for (const m of session.members) {
        memberIdToName[m.id] = m.display_name;
        memberIdToRole[m.id] = m.role;
      }
    } catch (e: any) {
      error = e?.message ?? '加载失败';
    } finally {
      loading = false;
    }
  });
</script>

<section>
  <div class="row" style="margin-bottom: var(--space-3);">
    <a class="btn ghost" href="/sessions/{sessionId}">← 返回</a>
  </div>

  {#if loading}
    <p class="muted">加载中…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if session}
    <h2>{session.name} · 结算</h2>
    <p class="muted">谁付给谁多少,一目了然</p>

    <!-- v0.1.2 (T18): tab bar -->
    <div class="tab-bar" role="tablist" aria-label="结算视图">
      <button
        type="button"
        role="tab"
        class="tab"
        class:active={activeTab === 'overview'}
        aria-selected={activeTab === 'overview'}
        on:click={() => (activeTab = 'overview')}
      >
        全 session
      </button>
      <button
        type="button"
        role="tab"
        class="tab"
        class:active={activeTab === 'personal'}
        aria-selected={activeTab === 'personal'}
        on:click={() => (activeTab = 'personal')}
      >
        个人视图
      </button>
    </div>

    <div class="card">
      {#if activeTab === 'overview'}
        <SettleTransferPath {session} {memberIdToName} />
      {:else}
        <SettleMemberBreakdown {session} />
      {/if}
    </div>
  {/if}
</section>

<style>
  .tab-bar {
    display: flex;
    gap: var(--space-2);
    border-bottom: 1px solid var(--color-border);
    margin: var(--space-3) 0;
  }
  .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    padding: var(--space-2) var(--space-3);
    min-height: var(--touch-target);
    cursor: pointer;
    color: var(--color-text-muted);
    font-weight: 500;
  }
  .tab.active {
    color: var(--color-text);
    border-bottom-color: var(--color-accent, #3b82f6);
  }
  .tab:focus-visible {
    outline: 2px solid var(--color-accent, #3b82f6);
    outline-offset: 2px;
    border-radius: var(--radius-sm, 4px);
  }
</style>