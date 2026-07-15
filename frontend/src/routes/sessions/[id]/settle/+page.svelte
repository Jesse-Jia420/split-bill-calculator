<script lang="ts">
  /**
   * v0.3.15 (2026-07-15) — PRD §3.15.2 #1: 删 "谁付给谁多少，一目了然" 文案 (PO 2026-07-15 04:25 拍板)。
   *
   * v0.1.3 Sprint 2 Commit 1 (2026-07-02) — settle 视图。
   *
   * 本次 Commit 1 改动:
   * - Token alias 迁移: var(--color-*) → var(--*) 主 token。
   *
   * v0.3.14.1 hotfix #4 (2026-07-14) — 个人视图反馈 1/2/3.
   * - 反馈 1 (UI 架构): 「主币种汇总 / 原始数据」radio 从 tab bar 下方
   *   整体外提, **只**在「个人视图」tab 显示; 概览 tab 隐藏。
   *   概览 tab (SettleTransferPath) 仍按 session primary 聚合显示,
   *   不需要 per-bill 原始数据, 故 radio 对概览无意义。
   * - 反馈 2/3 (单位 + 换算): SettleMemberBreakdown 现在所有金额都
   *   带具体单位, 主币种汇总模式下付款/消费明细行用 BE 已换算好的
   *   `*_primary` 字段。
   *
   * v0.3.15 §3.15.2 #6 v2 (PO msg #4772): settle 页面返回按钮
   * 改成左下圆形 FAB (Lucide ArrowLeft), 跟 bills/new + bills/edit
   * 同形态 (56×56 圆形 + indigo 渐变 + 阴影 + bottom 24px)。
   * 删除 inline BackButton.ghost 按钮用法; BackButton.svelte 组件
   * 保留 (最小改动原则, 反 #121)。
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
  import { slide, fly } from 'svelte/transition';
  import { getSessionWithSecret } from '$api/sessions';
  import type { SessionDetail } from '$api/sessions';
  import SettleTransferPath from '$components/SettleTransferPath.svelte';
  import SettleMemberBreakdown from '$components/SettleMemberBreakdown.svelte';
  import SessionCurrencyBadge from '$components/SessionCurrencyBadge.svelte';
  import { user } from '$stores/user';
  import { ArrowLeft } from 'lucide-svelte';
  import { toast } from '$stores/toast';

  let session: SessionDetail | null = null;
  let currentMember: { id: number } | null = null;
  let loading = true;

  $: sessionId = Number(page.params.id);

  let memberIdToName: Record<number, string> = {};
  let memberIdToRole: Record<number, string> = {};

  // v0.2.2 (T11): settle view mode. 'primary' = all in primary
  // currency (default); 'split' = source currency per bill, primary
  // only for the totals. Pushed down to the child components which
  // re-fetch on the fly.
  //
  // v0.3.14.1 hotfix #4: only consumed by SettleMemberBreakdown
  // (the "personal view" tab). SettleTransferPath always renders in
  // primary currency. Kept at the page level so the radio can live
  // next to the personal tab without round-tripping through props
  // from the breakdown component.
  type ViewMode = 'primary' | 'split';
  let viewMode: ViewMode = 'primary';

  type Tab = 'overview' | 'personal';
  let activeTab: Tab = 'overview';

  onMount(async () => {
    if (page.url.hash === '#personal') {
      activeTab = 'personal';
    }
    try {
      const result = await getSessionWithSecret(sessionId);
      session = result.session;
      currentMember = { id: result.actingAsMemberId ?? 0 };
      for (const m of session.members) {
        memberIdToName[m.id] = m.display_name;
        memberIdToRole[m.id] = m.role;
      }
    } catch (e: any) {
      // v0.3.1: 非成员 → 重定向到 join 页 claim nickname.
      if (e?.code === 'not a session member' || e?.status === 403) {
        await goto('/sessions/' + sessionId + '/join', { replaceState: true });
        return;
      }
      // v0.3.15 (PO #4807): 错误统一走 Toast. 父 onMount 失败时子组件
      // (SettleTransferPath / SettleMemberBreakdown) 不会渲染, 不会重複 toast.
      toast.error(e?.message ?? '加载失败');
    } finally {
      loading = false;
    }
  });
</script>

<section>
  {#if loading}
    <p class="muted">加载中…</p>
  {:else if session}
    <h2>{session.name} · 结算</h2>
    <SessionCurrencyBadge
      currencies={session.currencies ?? []}
      primary_currency={session.primary_currency}
      exchange_rates={session.exchange_rates ?? []}
      editable={memberIdToRole[currentMember?.id ?? 0] === 'owner'}
      variant="settle"
      onRateChange={() => window.location.reload()}
    />

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

    <div class="card">
      {#if activeTab === 'overview'}
        <!--
          v0.3.14.1 hotfix #4 反馈 1: 概览 tab 不显示
          「主币种汇总 / 原始数据」radio — SettleTransferPath 始终按
          session primary 聚合, 不需要 per-bill 原始货币视图。
        -->
        <div in:slide={{ duration: 200 }}>
          <SettleTransferPath {session} {memberIdToName} {viewMode} />
        </div>
      {:else}
        <!--
          个人视图 tab: radio 只在此处出现 (PO 拍板 C1+D1 — 主币种
          汇总 vs 原始数据 的切换对个人视图才有意义)。
        -->
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
            原始数据
          </button>
        </div>
        <div in:slide={{ duration: 200 }}>
          <SettleMemberBreakdown {session} currentUserId={$user?.user_id ?? null} {viewMode} />
        </div>
      {/if}
    </div>

    <!-- v0.3.15 §3.15.2 #6 v2 (PO msg #4772): 左下圆形 FAB 返回按钮 -->
    <a
      class="fab fab-left"
      href="/sessions/{sessionId}"
      aria-label="返回"
      in:fly={{ y: 60, duration: 400, delay: 200 }}
    >
      <ArrowLeft size={24} strokeWidth={2.4} />
    </a>
  {/if}
</section>

<style>
  /* v0.3.15 §3.15.2 #6 v2 (PO msg #4772): 左下圆形 FAB (跟 bills/new + bills/edit 同形态) */
  .fab {
    position: fixed;
    bottom: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent-500);
    color: #fff;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    z-index: 100;
    text-decoration: none;
    border: none;
    cursor: pointer;
    padding: 0;
    transition: transform 150ms ease, box-shadow 150ms ease, background-color 150ms ease;
  }
  .fab-left { left: 24px; }
  .fab:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
    background: var(--accent-700);
  }
  .fab:active { transform: scale(0.96); }
  .fab:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px #4f46e5;
  }
  @media (max-width: 600px) {
    .fab { bottom: 16px; }
    .fab-left { left: 16px; }
  }

  /* v0.2.2 (T11): view-mode toggle (hotfix #4 — only used by the
     personal view tab now, but kept as a page-level style for the
     shared pill design). */
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

</style>
