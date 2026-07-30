<script lang="ts">
  /**
   * v0.1.4 (2026-07-03) — 全局错误页 (round 2 改动 3)。
   *
   * PO 10:15 拍板新增。
   * 作用: 替代 SvelteKit 默认错误页 (raw JSON `{"status":401,"error":"Not Found"}`),
   * 提供友好错误页。
   *
   * 行为:
   * - status === 401: 自动清 user state, redirect /auth/login?returnTo=...
   *   让用户重新登录后能回到原页面。
   * - 其他 status: 显示错误码 + 错误信息, 提供「返回首页」按钮。
   *
   * 关于 SSR 401:
   * 当前 SPA 模式 (CSR-only fetch), `+page.server.ts` 只调 `/version` (公开),
   * 不会触发 SSR 401。+error.svelte 主要覆盖:
   * - 404 (route 不存在)
   * - 500 (FE 运行时错误)
   * - 401 (token 过期, FE 401 后通过 SvelteKit error() 抛)
   */
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { clearUser } from '$stores/user';

  let redirected = false;

  $: status = page.status;
  $: errorMessage = page.error?.message ?? '未知错误';

  onMount(async () => {
    if (status === 401 && !redirected) {
      redirected = true;
      clearUser();
      const returnTo = window.location.pathname + window.location.search;
      try {
        await goto(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { replaceState: true });
      } catch {
        // ignore — 跳转失败至少已经把 user state 清了
      }
    }
  });

  function goHome() {
    goto('/sessions', { replaceState: true });
  }

  $: statusLabel =
    status === 401
      ? '正在跳转到登录…'
      : status === 404
        ? '页面不存在'
        : status === 500
          ? '服务器出错'
          : '出错';

  $: heroText = statusLabel;
</script>

<section class="error-page" data-status={status}>
  <div class="error-hero">
    <div class="glass-ring" aria-hidden="true"></div>
    <div class="error-pill" aria-hidden="true">
      <span class="pill-text">{heroText}</span>
    </div>
  </div>

  <div class="error-card" role="region" aria-label={`错误页 ${status}`}>
    <h1>出错了（{status}）</h1>
    <p class="muted">{errorMessage}</p>

    {#if status === 401}
      <p class="muted">正在跳转到登录…</p>
    {:else}
      <button type="button" class="btn btn-primary" onclick={goHome}>返回首页</button>
    {/if}
  </div>
</section>

<style>
  .error-page {
    min-height: 100vh;
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-5);
  }

  .error-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    animation: errorHeroIn 360ms ease-out both;
  }

  .error-card {
    width: 100%;
    max-width: 480px;
    text-align: center;
    border-radius: var(--radius-md, 10px);
    padding: var(--space-6);
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.22);
    backdrop-filter: saturate(180%) blur(18px);
    -webkit-backdrop-filter: saturate(180%) blur(18px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.35),
      0 18px 60px rgba(15, 23, 42, 0.08);
    animation: errorCardIn 420ms cubic-bezier(0.2, 0.9, 0.2, 1) both;
  }

  .error-card h1 {
    margin: 0 0 var(--space-3);
    font-size: 20px;
    color: var(--gray-900);
    letter-spacing: -0.01em;
    font-weight: 650;
  }

  .error-card .muted,
  .muted {
    margin: 0 0 var(--space-3);
    color: var(--gray-500);
  }

  .error-pill {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.78) 0%,
      rgba(255, 255, 255, 0.62) 100%
    );
    backdrop-filter: blur(20px) saturate(200%);
    -webkit-backdrop-filter: blur(20px) saturate(200%);
    border: 1px solid rgba(255, 255, 255, 0.78);
    border-radius: 999px;
    padding: 10px 18px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.9),
      0 4px 16px rgba(15, 23, 42, 0.06);
    animation: errorCardBreathe 2.4s ease-in-out infinite;
    user-select: none;
  }

  .pill-text {
    font-size: 14px;
    font-weight: 600;
    color: var(--btn-label, var(--logo-ink, #1a1a1a));
    letter-spacing: -0.005em;
  }

  /* LoadingOverlay 同源 glass ring（仅展示动画，不引入 overlay） */
  .glass-ring {
    position: relative;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: transparent;
    box-shadow:
      inset 0 0 0 4px rgba(40, 40, 40, 0.18),
      inset 0 1px 0 4px rgba(255, 255, 255, 0.55),
      inset 0 -1px 0 4px rgba(40, 40, 40, 0.08),
      0 0 0 0.5px rgba(40, 40, 40, 0.35),
      0 8px 24px rgba(40, 40, 40, 0.18),
      0 1px 2px rgba(40, 40, 40, 0.10);
    animation: errorRingRotate 900ms cubic-bezier(0.45, 0, 0.55, 1) infinite;
    flex-shrink: 0;
  }

  .glass-ring::before {
    content: "";
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: radial-gradient(
      circle at 30% 30%,
      #525252 0%,
      #262626 60%,
      #121212 100%
    );
    box-shadow:
      0 0 8px rgba(40, 40, 40, 0.6),
      0 0 16px rgba(40, 40, 40, 0.4);
    z-index: 3;
  }

  .glass-ring::after {
    content: "";
    position: absolute;
    inset: 4px;
    border-radius: 50%;
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.55) 0%,
      rgba(58, 58, 58, 0.10) 100%
    );
    backdrop-filter: blur(4px) saturate(220%);
    -webkit-backdrop-filter: blur(4px) saturate(220%);
    z-index: 1;
  }

  @keyframes errorRingRotate {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  @keyframes errorCardBreathe {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.03);
    }
  }

  @keyframes errorHeroIn {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @keyframes errorCardIn {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .glass-ring {
      animation: none;
    }
    .error-pill {
      animation: none;
    }
    .error-card,
    .error-hero {
      animation: none;
    }
  }

  @supports not (backdrop-filter: blur(1px)) {
    .error-card {
      background: rgba(255, 255, 255, 0.85);
      border-color: rgba(229, 231, 235, 0.8);
    }
  }
</style>
