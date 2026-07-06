<script lang="ts">
  /**
   * v0.1.3 Sprint 2 Commit 1 (2026-07-02) — settle 视图。
   *
   * 本次 Commit 1 改动:
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token。
   *
   * 注:
   * - 该页本身没有金额 / 日期 format 调用 (SettleTransferPath / SettleMemberBreakdown
   *   已分别在子组件迁移)。
   * - T8 (settle hero) / T10 (sticky) / T11 (transfer card) 在 Commit 2。
   *
   * 沿用:
   * - v0.1.2 反馈修 6 项目 4 (返回按钮纯文本,无 ← Unicode arrow)。
   * - v0.1.2 反馈修 5 (跨页面动画)。
   */
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { getSession } from '$api/sessions';
  import type { SessionDetail } from '$api/sessions';
  import SettleTransferPath from '$components/SettleTransferPath.svelte';
  import SettleMemberBreakdown from '$components/SettleMemberBreakdown.svelte';
  import { user } from '$stores/user';

  let session: SessionDetail | null = null;
  let loading = true;
  let error: string | null = null;

  $: sessionId = Number(page.params.id);

  let memberIdToName: Record<number, string> = {};
  let memberIdToRole: Record<number, string> = {};

  // v0.2.2 (T11): settle view mode. 'primary' = all in primary
  // currency (default); 'split' = source currency per bill, primary
  // only for the totals. Pushed down to the child components which
  // re-fetch on the fly.
  type ViewMode = 'primary' | 'split';
  let viewMode: ViewMode = 'primary';

  type Tab = 'overview' | 'personal';
  let activeTab: Tab = 'overview';

  onMount(async () => {
    if (page.url.hash === '#personal') {
      activeTab = 'personal';
    }
    try {
      session = await getSession(sessionId);
      for (const m of session.members) {
        memberIdToName[m.id] = m.display_name;
        memberIdToRole[m.id] = m.role;
      }
    } catch (e: any) {
      // v0.3.1: 非成员 → 重定向到 join 页 claim nickname。
      if (e?.code === 'not a session member' || e?.status === 403) {
        await goto('/sessions/' + sessionId + '/join', { replaceState: true });
        return;
      }
      error = e?.message ?? '加载失败';
    } finally {
      loading = false;
    }
  });
</script>

<section>
  <div class="row" style="margin-bottom: var(--space-3);">
    <a class="btn ghost back-btn" href="/sessions/{sessionId}">返回 session</a>
  </div>

  {#if loading}
    <p class="muted">加载中…</p>
  {:else if error}
    <div class="error">{error}</div>
  {:else if session}
    <h2>{session.name} · 结算</h2>
    <p class="muted">谁付给谁多少,一目了然</p>

    <div class="tab-bar" role="tablist" aria-label="结算视图">
      <button
        type="button"
        role="tab"
        class="tab"
        class:active={activeTab === 'overview'}
        aria-selected={activeTab === 'overview'}
        on:click={() => (activeTab = 'overview')}
      >
        概览
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

    <div class="view-switch" role="radiogroup" aria-label="结算视图">
      <button
        type="button"
        role="radio"
        class="view-switch-btn"
        class:active={viewMode === 'primary'}
        aria-checked={viewMode === 'primary'}
        on:click={() => (viewMode = 'primary')}
      >
        主币种汇总 ({session.primary_currency})
      </button>
      <button
        type="button"
        role="radio"
        class="view-switch-btn"
        class:active={viewMode === 'split'}
        aria-checked={viewMode === 'split'}
        disabled={!session.currencies || session.currencies.length < 2}
        title={
          session.currencies && session.currencies.length < 2
            ? '该 session 只有一种币种'
            : ''
        }
        on:click={() => (viewMode = 'split')}
      >
        源币种分列
      </button>
    </div>

    <div class="card">
      {#if activeTab === 'overview'}
        <div in:slide={{ duration: 200 }}>
          <SettleTransferPath {session} {memberIdToName} {viewMode} />
        </div>
      {:else}
        <div in:slide={{ duration: 200 }}>
          <SettleMemberBreakdown {session} currentUserId={$user?.user_id ?? null} {viewMode} />
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .back-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 36px;
    padding: 4px 12px;
    font-size: var(--font-size-sm, 14px);
  }

  /* v0.2.2 (T11): view-mode toggle above the tab bar */
  .view-switch {
    display: inline-flex;
    gap: 0.25rem;
    background: var(--gray-100, #f3f4f6);
    border-radius: 999px;
    padding: 0.25rem;
    margin: var(--space-2) 0;
  }
  .view-switch-btn {
    background: transparent;
    border: none;
    padding: 0.4rem 0.9rem;
    border-radius: 999px;
    font-size: 0.875rem;
    cursor: pointer;
    color: var(--gray-700, #374151);
    font-weight: 500;
    transition: background 0.15s ease;
  }
  .view-switch-btn:hover:not(:disabled) {
    background: rgba(99, 102, 241, 0.08);
  }
  .view-switch-btn.active {
    background: white;
    color: var(--color-text);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  }
  .view-switch-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .tab-bar {
    display: flex;
    gap: var(--space-2);
    border-bottom: 1px solid var(--gray-200);
    margin: var(--space-3) 0;
  }
  .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    padding: var(--space-2) var(--space-3);
    min-height: var(--touch-target);
    cursor: pointer;
    color: var(--gray-500);
    font-weight: 500;
    transition: color 180ms ease, border-bottom-color 180ms ease, background-color 150ms ease;
  }
  .tab:hover:not(.active) {
    color: var(--gray-900);
    background: rgba(0, 0, 0, 0.025);
  }
  .tab.active {
    color: var(--gray-900);
    border-bottom-color: var(--accent-500);
  }
  .tab:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
    border-radius: var(--radius-sm, 4px);
  }

  .muted {
    color: var(--gray-500);
  }
  .error {
    color: var(--error-500);
  }
</style>
