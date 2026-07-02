<script lang="ts">
  /**
   * v0.1.3 Sprint 3 (2026-07-02) — session 列表页。
   *
   * 本次 Commit 1 改动:
   * - T13: loading 时显 3 个 SkeletonCard (模拟 session card 视觉重量),
   *   替代原来朴素的"加载中…"文本。
   *
   * 沿用:
   * - Sprint 1: format tokens (千分位已迁到 SessionCard 内部)
   * - Sprint 2: 不动 /sessions/+page.svelte 本体
   */
  import { onMount } from 'svelte';
  import { loadSessions, sessions } from '$stores/sessions';
  import SessionCard from '$components/SessionCard.svelte';
  import SkeletonCard from '$components/SkeletonCard.svelte';

  let loading = true;
  let error: string | null = null;

  onMount(async () => {
    try {
      await loadSessions();
    } catch (e: any) {
      error = e?.message ?? '加载失败';
    } finally {
      loading = false;
    }
  });
</script>

<section>
  <div class="row between" style="margin-bottom: var(--space-4);">
    <h2>我的 sessions</h2>
    <a class="btn primary" href="/sessions/new">+ 新建 session</a>
  </div>

  {#if loading}
    <div class="stack">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if $sessions.length === 0}
    <div class="card" style="text-align: center;">
      <p class="muted">还没有 session</p>
      <a class="btn primary" href="/sessions/new">创建第一个</a>
    </div>
  {:else}
    <div class="stack">
      {#each $sessions as s (s.id)}
        <SessionCard session={s} />
      {/each}
    </div>
  {/if}
</section>
