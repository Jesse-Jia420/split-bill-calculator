<script lang="ts">
  /**
   * v0.1.3 Sprint 3 (2026-07-02) — session 列表页。
   *
   * 本次 Commit 2 改动:
   * - T14 EmptyState: 0 sessions 时用 EmptyState (inbox icon) 替代原来的
   *   朴素 "card + 文字 + 按钮" 组合,视觉与 Linear / Wise 看齐。
   *
   * 沿用:
   * - Sprint 1: format tokens (千分位已迁到 SessionCard 内部)
   * - Sprint 2: 不动 /sessions/+page.svelte 本体
   * - Sprint 3 Commit 1: SkeletonCard 3 个 loading 占位
   */
  import { onMount } from 'svelte';
  import { loadSessions, sessions } from '$stores/sessions';
  import SessionCard from '$components/SessionCard.svelte';
  import SkeletonCard from '$components/SkeletonCard.svelte';
  import EmptyState from '$components/EmptyState.svelte';
  import { toast } from '$stores/toast';

  let loading = true;

  onMount(async () => {
    try {
      await loadSessions();
    } catch (e: any) {
      // v0.3.15 (PO #4807): 错误统一走 Toast
      toast.error(e?.message ?? '加载失败');
    } finally {
      loading = false;
    }
  });
</script>

<section style="padding-bottom: 120px;">
  <div class="row between" style="margin-bottom: var(--space-4);">
    <h2>我的账本</h2>
  </div>

  {#if loading}
    <div class="stack">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  {:else if $sessions.length === 0}
    <EmptyState
      icon="inbox"
      title="还没有任何账本"
      description="创建一个账本开始记账,或者接受朋友的邀请加入。"
    />
  {:else}
    <div class="stack">
      {#each $sessions as s (s.id)}
        <SessionCard session={s} />
      {/each}
    </div>
  {/if}

  <!-- v0.3.27 (UAT 0723-2 #10): 「新建账本」按钮改为 与「新建账单」按钮 同款 FAB,
       位置 bottom: 28px right: 28px (跟 /sessions/[id] .fab 一致).
       v0.3.27-#17 (PO 0723-3 续): FAB bg 条件化 - 0 sessions 时深色强调引导,
       有 sessions 时回到浅色 (原 v0.3.17 默认值). -->
  <a
    class="fab glass-pill"
    class:emphasized={!loading && $sessions.length === 0}
    href="/sessions/new"
    title="新建账本"
    aria-label="新建账本"
  >+</a>
</section>

<style>
  /* v0.3.27 (UAT 0723-2 #10): FAB 样式跟 /sessions/[id] .fab 完全一致 (复制独立一份,
     因为 Svelte scoped CSS 不能跨组件).
     v0.3.27-#17 (PO 0723-3 续): FAB bg 条件化 — 有 sessions 浅色 (默认, v0.3.17 原值),
     0 sessions 深色 (.emphasized 状态). 取消箭头改走颜色引导路径. */
  /* v0.3.33 — UAT 0725-3 #5 (PO msg 21:00 后 batch):
     FAB bg 之前 alpha 0.04/0.02 + font-weight 300 太淡, "+" 几乎看不见.
     还原 v0.3.27 #10 原意 (玻璃 + 显著 "+" icon).
     - bg alpha 0.04/0.02 → 0.18/0.14 (跟 .emphasized 同色, 跟全站 glass 同族)
     - border 1px 0.18 → 1.5px 0.35 (玻璃边缘补偿)
     - font-weight 300 → 500 ("+" 不再发虚)
     - text-align center (而不是 display:grid 跟 padding-bottom 3px 互相打架)
     - 加 glass shadow (inset highlight + outer lift) 跟全站 .glass-pill 同族 */
  .fab {
    position: fixed;
    right: 28px;
    bottom: 28px;
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.18) 0%,
      rgba(59, 130, 246, 0.14) 100%
    );
    border: 1.5px solid rgba(99, 102, 241, 0.35);
    font-size: 38px;
    font-weight: 500;
    line-height: 76px;       /* 80 - 2*2 border, 视觉居中 "+" */
    text-align: center;
    z-index: 50;
    cursor: pointer;
    display: block;
    padding: 0;
    text-decoration: none;
    color: var(--accent-700, #4338ca);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.45),
      0 6px 16px rgba(99, 102, 241, 0.18);
    transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease, color 150ms ease;
  }
  .fab:hover {
    transform: translateY(-2px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      0 8px 20px rgba(99, 102, 241, 0.24);
    text-decoration: none;
  }
  /* v0.3.27-#17 (PO 0723-3 续): 0 sessions 状态 — FAB 颜色更深以引导创建.
     0 sessions 状态 bg alpha 0.18/0.14 → 0.32/0.26 (比默认更深一档, 但保持玻璃语言). */
  .fab.emphasized {
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.32) 0%,
      rgba(59, 130, 246, 0.26) 100%
    );
    border: 1.5px solid rgba(99, 102, 241, 0.50);
  }
  .fab:active {
    transform: scale(0.96);
  }
  .fab:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  @media (max-width: 600px) {
    .fab {
      right: 20px;
      bottom: 20px;
    }
  }
</style>
