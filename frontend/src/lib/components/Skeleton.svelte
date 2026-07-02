<script lang="ts">
  /**
   * v0.1.3 Sprint 3 (2026-07-02) — Loading 占位。
   *
   * 通用 shimmer 骨架屏:
   * - 1.5s ease-in-out 无限循环
   * - prefers-reduced-motion 时停止动画
   * - 通过 props 控 width / height / radius,可作为 building block 拼出
   *   任意骨架 (session card / bill row / chip 等等)。
   */
  export let width: string = '100%';
  export let height: string = '16px';
  export let radius: string = 'var(--radius-sm)';
</script>

<div
  class="skeleton"
  style:width
  style:height
  style:border-radius={radius}
  aria-hidden="true"
></div>

<style>
  .skeleton {
    background: linear-gradient(
      90deg,
      var(--gray-100) 0%,
      var(--gray-200) 50%,
      var(--gray-100) 100%
    );
    background-size: 200% 100%;
    animation: shimmer 1.5s ease-in-out infinite;
  }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton { animation: none; }
  }
</style>
