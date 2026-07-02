<script lang="ts">
  /**
   * v0.1.2 反馈修 6 — 全站通用 Toast 提示组件。
   *
   * PO 反馈: 「系统几乎没有动画反馈」。Toast 给用户即时反馈 (复制成功 / 删除成功 / 出错)。
   * 设计原则:
   * - 单实例 (固定一个 root),通过 toast store 触发
   * - fade in 200ms + 上滑,2s 后 fade out 200ms
   * - 底部居中 bottom: 80px (避开 FAB 56px + 24px 偏移)
   * - 不阻塞主线程
   */
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { toast, type ToastItem } from '$stores/toast';

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') toast.dismissAll();
  }
</script>

<svelte:window on:keydown={onKey} />

<div class="toast-root" aria-live="polite" aria-atomic="true">
  {#each $toast as t (t.id)}
    <div
      class="toast-item"
      class:success={t.kind === 'success'}
      class:error={t.kind === 'error'}
      class:info={t.kind === 'info'}
      in:fly={{ y: 20, duration: 200, easing: cubicOut }}
      out:fade={{ duration: 200 }}
    >
      <span class="toast-icon" aria-hidden="true">
        {#if t.kind === 'success'}✓{:else if t.kind === 'error'}!{:else}i{/if}
      </span>
      <span class="toast-msg">{t.message}</span>
    </div>
  {/each}
</div>

<style>
  .toast-root {
    position: fixed;
    left: 50%;
    bottom: 80px;
    transform: translateX(-50%);
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    pointer-events: none;
    max-width: calc(100vw - 32px);
  }
  .toast-item {
    pointer-events: auto;
    background: var(--color-surface, #fff);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 10px 18px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-sm, 14px);
    font-weight: 500;
    line-height: 1.3;
    white-space: nowrap;
    max-width: 100%;
    /* 兜底: 浏览器不支持 transition 时也好看 */
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .toast-item.success {
    border-color: var(--color-success, #10b981);
    background: var(--color-success, #10b981);
    color: #fff;
  }
  .toast-item.error {
    border-color: var(--color-error, #ef4444);
    background: var(--color-error, #ef4444);
    color: #fff;
  }
  .toast-item.info {
    background: var(--color-surface, #fff);
    color: var(--color-text);
  }
  .toast-icon {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 12px;
    background: rgba(255, 255, 255, 0.25);
  }
  .toast-item.info .toast-icon {
    background: var(--color-accent, #3b82f6);
    color: #fff;
  }
  .toast-msg {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 移动端: 紧凑 */
  @media (max-width: 480px) {
    .toast-item {
      padding: 8px 14px;
      font-size: 13px;
    }
  }
</style>