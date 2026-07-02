<script lang="ts">
  /**
   * v0.1.3 Sprint 3 (2026-07-02) — 通用空状态。
   *
   * 三种内置 SVG icon (inbox / receipt / users),可选 CTA 按钮 (用 anchor
   * 走路由跳转,或 onclick handler 走 clipboard 等)。设计参考 Linear /
   * Wise: 居中布局 + 弱化图标 + 主标 + 描述 + 主操作按钮。
   */
  export let icon: 'inbox' | 'receipt' | 'users' = 'inbox';
  export let title: string;
  export let description: string;
  export let ctaLabel: string | null = null;
  export let ctaHref: string | null = null;
  export let onCtaClick: ((e: MouseEvent) => void | Promise<void>) | null = null;
</script>

<div class="empty-state">
  <div class="icon-wrap" aria-hidden="true">
    {#if icon === 'inbox'}
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 8l9 6 9-6" />
        <path d="M3 8v10a2 2 0 002 2h14a2 2 0 002-2V8" />
        <path d="M3 8l9-6 9 6" />
      </svg>
    {:else if icon === 'receipt'}
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 5h6a2 2 0 012 2v12l-3-2-2 2-2-2-3 2V7a2 2 0 012-2z" />
        <line x1="9" y1="10" x2="15" y2="10" />
        <line x1="9" y1="13" x2="15" y2="13" />
      </svg>
    {:else if icon === 'users'}
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="9" cy="7" r="4" />
        <path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
        <circle cx="17" cy="7" r="3" />
        <path d="M14 14.5a4 4 0 013-3.5" />
      </svg>
    {/if}
  </div>
  <h3 class="title">{title}</h3>
  <p class="description">{description}</p>
  {#if ctaLabel}
    {#if ctaHref}
      <a href={ctaHref} class="cta">{ctaLabel}</a>
    {:else if onCtaClick}
      <button type="button" class="cta" on:click={onCtaClick}>{ctaLabel}</button>
    {/if}
  {/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: var(--space-9) var(--space-5);
    color: var(--gray-500);
  }
  .icon-wrap {
    color: var(--gray-300);
    margin-bottom: var(--space-4);
  }
  .title {
    color: var(--gray-700);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    margin: 0 0 var(--space-2);
  }
  .description {
    color: var(--gray-500);
    font-size: var(--font-size-sm);
    margin: 0 0 var(--space-5);
    max-width: 320px;
    line-height: var(--line-height-normal);
  }
  .cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--touch-target);
    padding: var(--space-3) var(--space-5);
    background: var(--accent-500);
    color: white;
    border: 1px solid var(--accent-500);
    border-radius: var(--radius-full);
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-medium);
    text-decoration: none;
    box-shadow: var(--shadow-sm);
    cursor: pointer;
    font-family: inherit;
    transition: background-color var(--transition-fast), border-color var(--transition-fast);
  }
  .cta:hover {
    background: var(--accent-700);
    border-color: var(--accent-700);
    text-decoration: none;
    color: white;
  }
  .cta:active {
    transform: scale(0.98);
  }
</style>
