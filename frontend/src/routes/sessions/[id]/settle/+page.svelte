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
  import CurrencyAddModal from '$components/CurrencyAddModal.svelte';
  import IosSwitch from '$lib/components/IosSwitch.svelte';
  import { user } from '$stores/user';
  import { ArrowLeft } from 'lucide-svelte';
  import { toast } from '$stores/toast';

  let session: SessionDetail | null = null;
  let currentMember: { id: number } | null = null;
  let loading = true;
  // v0.3.18 #53: open/close state for the CurrencyAddModal (triggered by
  // SessionCurrencyBadge single-pill + icon when owner).
  let addCurrencyOpen = false;

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
      onAddCurrency={() => (addCurrencyOpen = true)}
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

          v0.3.17 #32-D-3 (PO msg 00:27 #6104): 升级为 iOS27 switch toggle,
          跟 wizard step 3 currency-mode-row 同一组件 (复用 app.css 全局
          .ios-switch utility, option 44px tap target / 15px font /
          padding 0.625rem 1.5rem). 行为不变 (主币种汇总 vs 原始数据),
          跨页面视觉一致 (wizard step 3 跟 settle 个人视图 同款 toggle).
        -->
        <!-- v0.3.17 #32-D-4 (PO msg 01:18 #6116): IosSwitch 组件 — thumb 动态宽度跟随 option 文字
             主币种汇总 (CNY) vs 原始数据 — thumb width 跟随 active option 实际宽度
             (主币种汇总 label 长 ~120-140px, 原始数据 label 短 ~60-80px, thumb 差异明显)
             跟 wizard step 3 currency-mode 同一组件, 跨页面视觉一致.
             单币种 session: "原始数据" disabled (locked, 不会切到 split state). -->
        <IosSwitch
          ariaLabel="结算视图"
          options={[
            { value: 'primary', label: `主币种汇总 (${session.primary_currency})` },
            { value: 'split', label: '原始数据', disabled: !session.currencies || session.currencies.length < 2 }
          ]}
          bind:value={viewMode}
        />
        <div in:slide={{ duration: 200 }}>
          <SettleMemberBreakdown {session} currentUserId={$user?.user_id ?? null} {viewMode} />
        </div>
      {/if}
    </div>

    <!-- v0.3.15 §3.15.2 #6 v2 (PO msg #4772): 左下圆形 FAB 返回按钮
         v0.3.16 #9 (PO msg 20:01): 加 .glass-pill 玻璃化 (跟 bills/new + bills/edit 同形态) -->
    <a
      class="fab fab-left glass-pill"
      href="/sessions/{sessionId}"
      aria-label="返回"
      in:fly={{ y: 60, duration: 400, delay: 200 }}
    >
      <ArrowLeft size={24} strokeWidth={2.4} />
    </a>
  {/if}

  <!-- v0.3.18 #53: owner-driven "add secondary currency" modal.
       Mounted only when addCurrencyOpen=true (controlled by SessionCurrencyBadge
       onAddCurrency click). onAdded reloads the page so the badge re-renders
       as dual-bar (modal also dispatches close after onAdded fires). -->
  {#if addCurrencyOpen && session}
    <CurrencyAddModal
      session_id={session.id}
      primary_currency={session.primary_currency}
      existing_currencies={session.currencies ?? []}
      onAdded={() => window.location.reload()}
      on:close={() => (addCurrencyOpen = false)}
    />
  {/if}
</section>

<style>
  /* v0.3.15 §3.15.2 #6 v2 (PO msg #4772): 左下圆形 FAB (跟 bills/new + bills/edit 同形态)
   * v0.3.16 #9 (PO msg 20:01): 加 .glass-pill 玻璃化 — bg/box-shadow/border/color/icon
   *   由 .glass-pill 提供 (全局 app.css)。.fab 保留 border-radius: 50% + position fixed。
   *   .fab 写在 .glass-pill 之后 → 同 specificity 时 .fab 后定义覆盖 .glass-pill。 */
  .fab {
    position: fixed;
    bottom: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    /* glass-pill 提供 bg / box-shadow / border / backdrop-filter / color (var(--accent-700, #4338ca))
       这里只补 z-index + position fixed + 圆形保持 + transition */
    z-index: 100;
    text-decoration: none;
    border: none;
    cursor: pointer;
    padding: 0;
    transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease, color 150ms ease;
  }
  .fab-left { left: 24px; }
  /* .fab:hover 不再写 background/box-shadow — 由 .glass-pill:hover 全局处理 */
  .fab:hover { transform: translateY(-2px); }
  .fab:active { transform: scale(0.96); }
  .fab:focus-visible {
    /* 玻璃上白色 outline + indigo 实心 ring, focus 状态显眼 */
    outline: 2px solid #fff;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px #4f46e5;
  }
  @media (max-width: 600px) {
    .fab { bottom: 16px; }
    .fab-left { left: 16px; }
  }

  /* v0.3.17 #32-D-4 (PO msg 01:18 #6116): .ios-switch 全套移到 IosSwitch.svelte
     scoped style (frontend/src/lib/components/IosSwitch.svelte).
     跨页面 (wizard step 3 + settle 个人视图) 共用同一组件, thumb 宽度跟随
     active option 实际宽度 (动态, 不再固定 50%). */


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
