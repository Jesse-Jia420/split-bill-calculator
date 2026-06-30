<script lang="ts">
  import { user, logout } from '$stores/user';
  import { goto } from '$app/navigation';
  import { FRONTEND_VERSION } from '$lib/version';

  async function handleLogout() {
    await logout();
    await goto('/');
  }
</script>

<header class="navbar">
  <a href="/" class="brand">Split Bill</a>
  <nav class="links">
    <a href="/sessions">我的 sessions</a>
  </nav>
  <div class="right">
    {#if $user}
      <span class="email" title="{$user.email}">{$user.default_name}</span>
      <button class="ghost btn-sm" on:click={handleLogout}>退出</button>
    {:else}
      <a href="/auth/login" class="btn-sm">登录</a>
    {/if}
    <span class="version" title="frontend version">FE: {FRONTEND_VERSION}</span>
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
  .version {
    color: var(--color-text-muted);
    font-size: 0.75rem;
    font-family: monospace;
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