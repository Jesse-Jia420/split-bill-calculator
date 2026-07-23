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

<section>
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
    <!-- v0.3.27 #11 (PO reject 续 v2): EmptyState + 引导箭头.
         wrap div relative, 让 SVG arrow absolute 紧贴 EmptyState icon 旁.
         arrow 起点 EmptyState icon 右上角 → 终点 EmptyState 右下边界外 (FAB 方向).
         arrow 物理跨 ~140x170px 紧贴 EmptyState, 视觉指向右下 FAB (FAB 在 EmptyState 右下方). -->
    <div class="empty-state-wrap">
      <EmptyState
        icon="inbox"
        title="还没有任何账本"
        description="创建一个账本开始记账,或者接受朋友的邀请加入。"
      />
      <svg
        class="handdrawn-arrow"
        viewBox="0 0 140 180"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <path
          d="M 8 12 C 45 50, 75 90, 115 155"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-dasharray="5,4"
          opacity="0.78"
        />
        <path
          d="M 100 145 L 115 155 L 105 168"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          opacity="0.78"
        />
      </svg>
    </div>
  {:else}
    <div class="stack">
      {#each $sessions as s (s.id)}
        <SessionCard session={s} />
      {/each}
    </div>
  {/if}

  <!-- v0.3.27 (UAT 0723-2 #10): 「新建账本」按钮改为 与「新建账单」按钮 同款 FAB,
       位置 bottom: 28px right: 28px (跟 /sessions/[id] .fab 一致). -->
  <a
    class="fab glass-pill"
    href="/sessions/new"
    title="新建账本"
    aria-label="新建账本"
  >+</a>
</section>

<style>
  /* v0.3.27 (UAT 0723-2 #10): FAB 样式跟 /sessions/[id] .fab 完全一致 (复制独立一份,
     因为 Svelte scoped CSS 不能跨组件). */
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
    font-size: 36px;
    font-weight: 300;
    line-height: 1;
    z-index: 50;
    cursor: pointer;
    display: grid;
    place-items: center;
    padding: 0;
    padding-bottom: 3px;
    text-decoration: none;
    color: var(--accent-700, #4338ca);
    transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease, color 150ms ease;
  }
  .fab:hover {
    transform: translateY(-2px);
    text-decoration: none;
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

  /* v0.3.27 (UAT 0723-2 #11 v2, PO reject 续): 手绘箭头 — absolute relative .empty-state-wrap.
     起点 EmptyState icon 右上角 → 终点 EmptyState 右下边界外 (指向 FAB 方向).
     FAB 在 EmptyState 右下方 (实测 /sessions: EmptyState (16,155)-(375,388), FAB (290,744)-(370,824)).
     arrow 物理跨 140x180px 紧贴 EmptyState, 视觉从左上朝右下, 路径从 (8,12) → (115,155).
     wrap 是 relative 让 SVG absolute 跟 EmptyState 移动 (Fixed 不能跨页适配 — /sessions 和 /sessions/[id] EmptyState 位置不同). */
  .empty-state-wrap {
    position: relative;
  }
  .handdrawn-arrow {
    position: absolute;
    top: 30px;
    right: 8px;
    width: 140px;
    height: 180px;
    color: var(--accent-500, #6366f1);
    pointer-events: none;
    z-index: 1;
  }
</style>
