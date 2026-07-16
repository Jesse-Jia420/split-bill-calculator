<script lang="ts">
  import { user, logout } from '$stores/user';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  async function handleLogout() {
    await logout();
    await goto('/');
  }

  // §3.11.13 决策 η: 在 session 内 vs session 外, 登录按钮语义不同.
  // 在 session 内 → "登录以保存" + returnTo=当前路径 (登录后回 session 页面)
  // 在 session 外 → 普通 "登录" → /sessions (默认登录后跳转)
  function inSession(): boolean {
    return /^\/sessions\/\d+(\/|$)/.test(page.url.pathname);
  }
</script>

<header class="navbar">
  <a href="/" class="brand">Split Bill</a>
  <nav class="links">
    <a href="/sessions">我的账本</a>
  </nav>
  <div class="right">
    {#if $user}
      <span class="email" title="{$user.email}">{$user.default_name}</span>
      <button class="ghost btn-sm" on:click={handleLogout}>注销登录</button>
    {:else if inSession()}
      <a
        href={`/auth/login?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`}
        class="btn-sm"
      >
        登录以保存
      </a>
    {:else}
      <a href="/auth/login" class="btn-sm">登录</a>
    {/if}
  </div>
</header>

<style>
  .navbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    flex-wrap: wrap;
  }
  .brand {
    font-weight: 600;
    font-size: var(--font-size-lg);
    color: var(--color-text);
    text-decoration: none;
  }
  .brand:hover { color: var(--color-accent); }
  .links { flex: 1; display: flex; gap: var(--space-3); }
  .links a {
    color: var(--color-text-muted);
    min-height: var(--touch-target);
    display: inline-flex;
    align-items: center;
  }
  .right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .email {
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
    max-width: 12ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn-sm {
    min-height: var(--touch-target);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    display: inline-flex;
    align-items: center;
    font-size: var(--font-size-sm);
    color: var(--color-text);
    cursor: pointer;
  }
  .btn-sm:hover { border-color: var(--color-accent); }
</style>