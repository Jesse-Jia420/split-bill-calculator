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
  /* v0.3.17 #21 (PO msg 13:51 item 3): EmptyState CTA 玻璃化 (0 条账单中央"新建账单"按钮)
     跟全站 Liquid Glass 风格统一 (member-chip / swipe button / fab / nav 登录)。
     保留主操作视觉强度 (大按钮 + accent 色), 但加 glass 玻璃感 (半透明 + blur)。
     hover: 玻璃加深 (跟 glass-pill 同模式)。 */
  .cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--touch-target);
    padding: var(--space-3) var(--space-5);
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.85) 0%,
      rgba(59, 130, 246, 0.75) 100%
    );
    color: white;
    border: 1px solid rgba(99, 102, 241, 0.35);
    border-radius: var(--radius-full, 999px);
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-medium);
    text-decoration: none;
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.30),
      inset 0 -1px 0 rgba(0, 0, 0, 0.10),
      0 4px 12px rgba(99, 102, 241, 0.25);
    cursor: pointer;
    font-family: inherit;
    transition: transform 150ms ease, background 150ms ease, box-shadow 150ms ease;
  }
  .cta:hover {
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.95) 0%,
      rgba(59, 130, 246, 0.85) 100%
    );
    border-color: rgba(99, 102, 241, 0.50);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.40),
      inset 0 -1px 0 rgba(0, 0, 0, 0.10),
      0 6px 16px rgba(99, 102, 241, 0.32);
    text-decoration: none;
    color: white;
    transform: translateY(-1px);
  }
  .cta:active {
    transform: scale(0.97);
  }
</style>
