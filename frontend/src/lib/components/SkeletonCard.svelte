<script lang="ts">
  /**
   * v0.1.3 Sprint 3 (2026-07-02) — session card 骨架。
   *
   * 模拟 SessionCard 视觉重量:
   * - 标题行 + meta 行 + 数字行
   * - 走 Skeleton.svelte 的 shimmer,统一动画
   */
  import Skeleton from './Skeleton.svelte';
</script>

<div class="skeleton-card" aria-hidden="true">
  <div class="row1">
    <Skeleton width="60%" height="18px" />
    <Skeleton width="80px" height="22px" />
  </div>
  <div class="row2">
    <Skeleton width="40%" height="12px" />
    <Skeleton width="30%" height="12px" />
  </div>
</div>

<style>
  .skeleton-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: white;
    border: 1px solid var(--gray-200);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }
  .row1 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .row2 {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
</style>
