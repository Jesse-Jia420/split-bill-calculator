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
</script>

<section class="error-page">
  <div class="error-card">
    <h1>出错了 ({status})</h1>
    <p class="muted">{errorMessage}</p>
    {#if status === 401}
      <p class="muted">正在跳转到登录…</p>
    {:else}
      <button type="button" class="primary" onclick={goHome}>返回首页</button>
    {/if}
  </div>
</section>

<style>
  .error-page {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: var(--space-6);
  }
  .error-card {
    max-width: 400px;
    text-align: center;
    background: white;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    padding: var(--space-6);
  }
  .error-card h1 {
    margin: 0 0 var(--space-3);
    font-size: 20px;
    color: var(--gray-900);
  }
  .error-card p {
    margin: 0 0 var(--space-3);
    color: var(--gray-500);
  }
  .error-card .primary {
    margin-top: var(--space-3);
    background: var(--accent-500);
    color: #fff;
    border: 0;
    border-radius: 999px;
    padding: 8px 20px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease;
  }
  .error-card .primary:hover {
    background: var(--accent-700);
  }
  .error-card .primary:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px var(--accent-500);
  }
</style>
