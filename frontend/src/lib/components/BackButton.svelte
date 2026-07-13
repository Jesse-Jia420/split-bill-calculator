<!--
  BackButton.svelte — v0.3.14 (BUG #1, design v1 任务 B)
  复用 settle / bills/[billId]/edit 等多页返回导航。
  icon: ChevronLeft (lucide-svelte, v0.1.3 Sprint 3 已引入)
  触摸目标: 44px (iOS HIG)
  视觉: 延续 .btn.ghost 风格 (token 全部引用 v0.1.3 app.css, 不新增)
-->
<script lang="ts">
  import { ChevronLeft } from 'lucide-svelte';

  /** 目标 URL (SvelteKit 路由, 内部跳转) */
  export let href: string;
  /** 按钮显示文案 + aria-label。默认 '返回 session'。 */
  export let label: string = '返回 session';
</script>

<a class="btn ghost back-btn" {href} aria-label={label}>
  <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
  <span>{label}</span>
</a>

<style>
  .back-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--touch-target);
    min-width: var(--touch-target);
    padding: 0 var(--space-3);
    font-size: var(--font-size-sm);
    color: var(--gray-500);
    border-radius: var(--radius-md);
  }
  .back-btn :global(svg) {
    flex: 0 0 auto;
  }
  .back-btn:hover {
    color: var(--gray-800);
  }
  .back-btn:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
  }
</style>
