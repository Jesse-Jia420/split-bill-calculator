<script lang="ts">
  /**
   * v0.1.3 Sprint 3 (2026-07-02) — 单行 bill 骨架。
   *
   * 模拟 BillListGrouped 中一行 bill 的视觉重量:
   * - 上下两行: 第 1 行是 description + amount,第 2 行是 muted meta
   * - 高度约 72px,跟真实 row 一致,loading → loaded 不闪
   * - 走 Skeleton.svelte 的 shimmer,统一动画
   */
  import Skeleton from './Skeleton.svelte';
</script>

<div class="skeleton-bill" aria-hidden="true">
  <div class="row1">
    <Skeleton width="55%" height="16px" />
    <Skeleton width="80px" height="16px" />
  </div>
  <div class="row2">
    <Skeleton width="65%" height="12px" />
  </div>
</div>

<style>
  .skeleton-bill {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--gray-200);
  }
  .skeleton-bill:last-child { border-bottom: none; }
  .row1 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .row2 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
