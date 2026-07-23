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
    <a class="btn primary glass-pill" href="/sessions/new">+ 新建账本</a>
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
</section>
