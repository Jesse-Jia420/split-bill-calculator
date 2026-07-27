<script lang="ts">
  /**
   * v0.3.17 #27 — Toast 全玻璃化改造 (PO msg 20:30 #5891).
   *
   * 设计 token (design-notes/v0.3.17-glass-form/tokens.json):
   * - 3 variant (success/error/info) 统一 pill (border-radius 999px)
   * - 玻璃参数: saturate 200% blur 20px + 1.5px 白边 + inset highlight + box-shadow
   * - 渐变背景: success emerald / error rose→red / info blue→indigo
   * - Icon: inline Lucide SVG (12px stroke 3, 圆底 18px rgba 255,255,255,0.25)
   * - 位置 bottom 80px center (跟 v0.1.2 一致, 避开 FAB)
   * - 动画: fly y=28 duration 280 cubicOut + fade out 200ms
   *
   * 调用约定 (不改 store.ts 默认 2000ms):
   *   toast.success(msg)               → 默认 2000ms
   *   toast.info(msg)                  → 默认 3000ms
   *   toast.error(msg, 4000)           → 必须显式传 4000 (错误需要用户读完)
   */
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { toast, type ToastItem } from '$stores/toast';

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') toast.dismissAll();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="toast-root" aria-live="polite" aria-atomic="true">
  {#each $toast as t (t.id)}
    <div
      class="toast-item"
      class:success={t.kind === 'success'}
      class:error={t.kind === 'error'}
      class:info={t.kind === 'info'}
      in:fly={{ y: 28, duration: 280, easing: cubicOut }}
      out:fade={{ duration: 200 }}
    >
      <span class="toast-icon" aria-hidden="true">
        {#if t.kind === 'success'}
          <!-- Lucide check -->
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        {:else if t.kind === 'error'}
          <!-- Lucide circle-alert -->
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        {:else}
          <!-- Lucide info -->
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        {/if}
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
    /* v0.3.21 #108 (PO msg 17:54): z-index 100 → 9999, 保证 toast 永远在
     *   modal-backdrop (z-index 999) 之上 (之前的 100 < 999 让 toast
     *   在 CurrencyAddModal 弹窗下层, 用户看不到反馈). 9999 远高于所有
     *   已知 modal/NavBar (NavBar=100, FAB=150, modal=999). */
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    pointer-events: none;
    max-width: calc(100vw - 32px);
  }
  /* v0.3.17 #27: glass base (saturate 200% blur 20px + 1.5px 白边 + inset highlight) */
  .toast-item {
    pointer-events: auto;
    border: 1.5px solid rgba(255, 255, 255, 0.6);
    border-radius: 999px;
    padding: 10px 18px;
    color: #fff;
    backdrop-filter: saturate(200%) blur(20px);
    -webkit-backdrop-filter: saturate(200%) blur(20px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 6px 20px rgba(0, 0, 0, 0.12);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.3;
    white-space: nowrap;
    max-width: 100%;
  }
  /* v0.3.17 #27: success = emerald 渐变 */
  .toast-item.success {
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.85) 0%, rgba(5, 150, 105, 0.78) 100%);
    color: #fff;
  }
  /* v0.3.17 #27: error = rose → red 渐变 */
  .toast-item.error {
    background: linear-gradient(135deg, rgba(244, 63, 94, 0.92) 0%, rgba(220, 38, 38, 0.85) 100%);
    color: #fff;
  }
  /* v0.3.17 #27: info = blue → indigo 渐变 (跟 .btn-primary 同参数) */
  .toast-item.info {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.85) 0%, rgba(99, 102, 241, 0.78) 100%);
    color: #fff;
  }
  .toast-icon {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.25);
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
