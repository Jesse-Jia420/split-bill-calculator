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

<!-- v0.3.17 #22 hotfix (PO msg 16:32 #1): 整个 .right 区在 /auth/login 隐藏
     · anon 用户访问 /auth/login → $user 是 null → 之前会渲染「登录」按钮
       (指向自己, dead self-link, 视觉噪音)
     · 已登录用户访问 /auth/login (罕见但可能) → 之前会渲染「注销登录」按钮
       (跟登录页语义冲突, 视觉混乱)
     · 同一个 pathname check 不管 $user 状态都隐藏, 因为登录页本身已经有
       自己的 form 操作区, 不需要 nav 上的 auth 控件
     · pathname 已在脚本顶部 import (`import { page } from '$app/state'`),
       直接读 page.url.pathname
     · 改法用 outer {#if} 包整个 .right div, 不用每个分支单独包, 因为三
       分支 (login btn / login-以保存 / logout btn) 都不该出现在登录页 -->
<header class="navbar">
  <a href="/" class="brand">Split Bill</a>
  <nav class="links">
    <a href="/sessions">我的账本</a>
  </nav>
  {#if page.url.pathname !== '/auth/login'}
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
  {/if}
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
  /* v0.3.17 #21 (PO msg 13:51 item 3): NavBar 登录按钮 / 注销按钮玻璃化
     跟全站 member-chip / swipe button / fab / 汇率 pill 同 Liquid Glass 语言。
     .ghost 跟 .btn-sm 同形态, 仅 hover 不加深色 (注销按钮语义更弱)。 */
  .btn-sm {
    min-height: var(--touch-target);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-full, 999px);
    border: 1px solid rgba(99, 102, 241, 0.15);
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.10) 0%,
      rgba(59, 130, 246, 0.08) 100%
    );
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 3px rgba(99, 102, 241, 0.06);
    display: inline-flex;
    align-items: center;
    font-size: var(--font-size-sm);
    color: var(--accent-700, #4338ca);
    cursor: pointer;
    text-decoration: none;
    transition: transform 150ms ease, background 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  }
  .btn-sm:hover {
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.18) 0%,
      rgba(59, 130, 246, 0.15) 100%
    );
    border-color: rgba(99, 102, 241, 0.22);
    color: var(--accent-800, #3730a3);
    transform: translateY(-1px);
    text-decoration: none;
  }
  .btn-sm:active { transform: scale(0.97); }
  @supports not (backdrop-filter: blur(1px)) {
    .btn-sm { background: rgba(99, 102, 241, 0.18); }
  }
  /* .ghost: 注销按钮 — 更弱化 (白玻璃非蓝玻璃) */
  .ghost {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.65) 0%,
      rgba(255, 255, 255, 0.45) 100%
    );
    border-color: rgba(99, 102, 241, 0.10);
    color: var(--gray-700);
  }
  .ghost:hover {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.85) 0%,
      rgba(255, 255, 255, 0.65) 100%
    );
    color: var(--accent-700);
  }
</style>