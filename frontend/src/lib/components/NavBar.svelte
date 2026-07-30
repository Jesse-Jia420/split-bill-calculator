<script lang="ts">
  import { user, logout } from '$stores/user';
  import { navbarChrome, resetNavbarChrome } from '$stores/navbarChrome';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy } from 'svelte';

  let menuOpen = false;
  let menuRoot: HTMLDivElement | null = null;

  $: compact = $navbarChrome.compact && !!$navbarChrome.title;
  $: ledgerTitle = $navbarChrome.title;

  // Leave ledger chrome when navigating away from a session page.
  $: if (!inSession()) {
    if ($navbarChrome.title || $navbarChrome.compact) resetNavbarChrome();
    menuOpen = false;
  }

  async function handleLogout() {
    menuOpen = false;
    await logout();
    await goto('/');
  }

  function inSession(): boolean {
    return /^\/sessions\/\d+(\/|$)/.test(page.url.pathname) ||
           /^\/s\/[A-Z0-9]+(\/|$)/i.test(page.url.pathname);
  }
  function isJoinPage(): boolean {
    return /^\/sessions\/\d+\/join/.test(page.url.pathname) ||
           /^\/s\/[A-Z0-9]+\/join/i.test(page.url.pathname);
  }
  function isLoginPage(): boolean {
    return /^\/sessions\/\d+\/login/.test(page.url.pathname) ||
           /^\/s\/[A-Z0-9]+\/login/i.test(page.url.pathname);
  }

  function avatarLetter(name: string | null | undefined): string {
    const t = (name ?? '').trim();
    if (!t) return '?';
    return Array.from(t)[0]!.toUpperCase();
  }

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation();
    menuOpen = !menuOpen;
  }

  function onDocPointer(e: MouseEvent | TouchEvent) {
    if (!menuOpen || !menuRoot) return;
    const t = e.target as Node | null;
    if (t && menuRoot.contains(t)) return;
    menuOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') menuOpen = false;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onKey);
  }
  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onKey);
    }
  });

  $: loginHref = inSession()
    ? `/auth/login?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`
    : '/auth/login';
</script>

<header class="navbar" class:compact data-testid="app-navbar">
  <div class="left">
    <a
      href="/"
      class="brand"
      class:brand-hidden={compact}
      aria-label="轻均 FairLite"
      aria-hidden={compact ? 'true' : undefined}
      tabindex={compact ? -1 : 0}
    >
      <span class="brand-zh" aria-hidden="true">
        <span class="brand-zh-inner">
          <span class="brand-zh-glass" aria-hidden="true">轻均</span>
          轻均
        </span>
      </span>
      <span class="brand-en">FairLite</span>
    </a>

    {#if compact && ledgerTitle}
      <div class="ledger-title" data-testid="navbar-ledger-title" title={ledgerTitle}>
        {ledgerTitle}
      </div>
    {/if}
  </div>

  {#if page.url.pathname !== '/auth/login' && !isLoginPage()}
    <div class="right" class:right-compact={compact}>
      {#if compact}
        <!-- Compact: nickname / auth actions collapse into avatar menu -->
        <div class="avatar-menu" bind:this={menuRoot}>
          <button
            type="button"
            class="avatar-btn"
            class:anon={!$user}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={$user ? `账户菜单：${$user.default_name}` : '账户菜单'}
            data-testid="navbar-avatar-btn"
            onclick={toggleMenu}
          >
            <span class="avatar-letter">
              {$user ? avatarLetter($user.default_name) : '登'}
            </span>
          </button>
          {#if menuOpen}
            <div class="avatar-popover" role="menu" data-testid="navbar-avatar-menu">
              {#if $user}
                <div class="menu-identity" role="presentation">
                  <span class="menu-name">{$user.default_name}</span>
                  {#if $user.email}
                    <span class="menu-email" title={$user.email}>{$user.email}</span>
                  {/if}
                </div>
                {#if page.url.pathname !== '/sessions/new'}
                  <a href="/sessions" class="menu-item" role="menuitem" onclick={() => (menuOpen = false)}>
                    我的账本
                  </a>
                {/if}
                <button type="button" class="menu-item danger" role="menuitem" onclick={handleLogout}>
                  注销登录
                </button>
              {:else if inSession() && !isJoinPage()}
                <a href={loginHref} class="menu-item" role="menuitem" onclick={() => (menuOpen = false)}>
                  登录以保存
                </a>
              {:else if !inSession()}
                <a href="/auth/login" class="menu-item" role="menuitem" onclick={() => (menuOpen = false)}>
                  登录
                </a>
              {/if}
            </div>
          {/if}
        </div>
      {:else if $user}
        <span class="email" title="{$user.email}">{$user.default_name}</span>
        {#if page.url.pathname !== '/sessions/new'}
          <a href="/sessions" class="btn-sm links-item">我的账本</a>
        {/if}
        <button class="ghost btn-sm" onclick={handleLogout}>注销登录</button>
      {:else if inSession() && !isJoinPage()}
        <a href={loginHref} class="btn-sm">登录以保存</a>
      {:else if !inSession()}
        <a href="/auth/login" class="btn-sm">登录</a>
      {/if}
    </div>
  {/if}
</header>

<style>
  :global(:root) {
    --navbar-h: calc(2 * var(--space-3) + 24px); /* ~48px, 不含 safe-area */
  }
  .navbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    overflow-x: clip;
    padding: calc(var(--space-3) + env(safe-area-inset-top, 0px)) var(--space-4) var(--space-3);
    background: rgba(255, 255, 255, 0.02);
    backdrop-filter: saturate(130%) blur(20px);
    -webkit-backdrop-filter: saturate(130%) blur(20px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.2);
    flex-wrap: nowrap;
    justify-content: space-between;
    transition: background 180ms ease, box-shadow 180ms ease;
  }
  .navbar.compact {
    background: rgba(255, 255, 255, 0.55);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 1px 10px rgba(15, 23, 42, 0.06);
  }

  .left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    flex: 1 1 auto;
  }

  .brand {
    display: inline-flex;
    align-items: baseline;
    gap: 0.45rem;
    color: var(--color-text);
    text-decoration: none;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: opacity 180ms ease, transform 180ms ease, max-width 180ms ease;
    max-width: 14rem;
  }
  .brand.brand-hidden {
    opacity: 0;
    transform: translateY(-4px) scale(0.96);
    max-width: 0;
    pointer-events: none;
    margin: 0;
    gap: 0;
  }

  .brand-zh {
    display: inline-block;
    flex-shrink: 0;
  }
  .brand-zh-inner {
    position: relative;
    display: inline-block;
    font-family: var(--font-zh);
    font-weight: 200;
    font-size: 1.45rem;
    line-height: 0.95;
    letter-spacing: 0.2em;
    text-indent: 0.2em;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    font-synthesis: none;
    text-rendering: geometricPrecision;
    color: rgba(26, 26, 26, 0.58);
    -webkit-text-stroke: 0.55px rgba(0, 0, 0, 0.72);
    paint-order: stroke fill;
    text-shadow:
      0 0 0.4px rgba(0, 0, 0, 0.35),
      0 1px 0 rgba(255, 255, 255, 0.55),
      0 2px 6px rgba(0, 0, 0, 0.08);
  }
  .brand-zh-glass {
    position: absolute;
    inset: 0;
    pointer-events: none;
    font: inherit;
    font-weight: inherit;
    letter-spacing: inherit;
    line-height: inherit;
    text-indent: inherit;
    color: transparent;
    -webkit-text-stroke: 0;
    background: linear-gradient(
      185deg,
      rgba(255, 255, 255, 0.88) 0%,
      rgba(255, 255, 255, 0.42) 18%,
      rgba(255, 255, 255, 0.1) 38%,
      rgba(255, 255, 255, 0) 52%
    );
    -webkit-background-clip: text;
    background-clip: text;
    mix-blend-mode: soft-light;
    opacity: 0.9;
    animation: navGlassSheen 7s ease-in-out infinite alternate;
  }
  @keyframes navGlassSheen {
    from { opacity: 0.72; }
    to { opacity: 0.95; }
  }
  .brand-en {
    font-family: var(--font-en);
    font-size: 0.78em;
    font-weight: 500;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }

  .ledger-title {
    font-family: var(--font-zh);
    font-size: 1.02rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--gray-900);
    line-height: 1.2;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    animation: titleIn 220ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes titleIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
    min-width: 0;
    flex: 0 0 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .right.right-compact {
    flex-wrap: nowrap;
  }
  .email {
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
    max-width: 12ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .avatar-menu {
    position: relative;
    flex-shrink: 0;
  }
  .avatar-btn {
    width: 36px;
    height: 36px;
    border-radius: 999px;
    border: 1px solid rgba(99, 102, 241, 0.28);
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.92) 0%, rgba(59, 130, 246, 0.88) 100%);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.35),
      0 2px 8px rgba(99, 102, 241, 0.28);
    transition: transform 120ms ease, box-shadow 150ms ease;
  }
  .avatar-btn.anon {
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.14) 0%, rgba(59, 130, 246, 0.10) 100%);
    color: var(--accent-700, #4338ca);
  }
  .avatar-btn:hover {
    transform: translateY(-1px);
  }
  .avatar-btn:active {
    transform: scale(0.96);
  }
  .avatar-letter {
    font-family: var(--font-zh);
    font-size: 0.92rem;
    font-weight: 600;
    line-height: 1;
  }
  .avatar-popover {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 168px;
    max-width: min(72vw, 240px);
    padding: 6px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: saturate(160%) blur(18px);
    -webkit-backdrop-filter: saturate(160%) blur(18px);
    border: 1px solid rgba(15, 23, 42, 0.08);
    box-shadow:
      0 12px 32px rgba(15, 23, 42, 0.14),
      inset 0 1px 0 rgba(255, 255, 255, 0.8);
    display: flex;
    flex-direction: column;
    gap: 2px;
    z-index: 120;
    animation: menuIn 160ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes menuIn {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .menu-identity {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px 6px;
    border-bottom: 1px solid rgba(15, 23, 42, 0.06);
    margin-bottom: 2px;
  }
  .menu-name {
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--gray-900);
  }
  .menu-email {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-item {
    display: flex;
    align-items: center;
    min-height: 40px;
    padding: 0 10px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--gray-800);
    font-size: 0.9rem;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    font-family: inherit;
    width: 100%;
    text-align: left;
  }
  .menu-item:hover {
    background: rgba(99, 102, 241, 0.08);
    color: var(--accent-700, #4338ca);
    text-decoration: none;
  }
  .menu-item.danger {
    color: #b91c1c;
  }
  .menu-item.danger:hover {
    background: rgba(244, 63, 94, 0.08);
    color: #9f1239;
  }

  .btn-sm {
    min-height: var(--touch-target);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-full, 999px);
    border: 1px solid rgba(99, 102, 241, 0.25);
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.04) 0%,
      rgba(59, 130, 246, 0.02) 100%
    );
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.95),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 3px rgba(99, 102, 241, 0.16);
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
      rgba(99, 102, 241, 0.08) 0%,
      rgba(59, 130, 246, 0.06) 100%
    );
    border-color: rgba(99, 102, 241, 0.32);
    color: var(--accent-800, #3730a3);
    transform: translateY(-1px);
    text-decoration: none;
  }
  .btn-sm:active { transform: scale(0.97); }
  @supports not (backdrop-filter: blur(1px)) {
    .btn-sm { background: rgba(99, 102, 241, 0.08); }
  }
  .ghost {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.20) 0%,
      rgba(255, 255, 255, 0.10) 100%
    );
    border-color: rgba(99, 102, 241, 0.20);
    color: var(--gray-700);
  }
  .ghost:hover {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.50) 0%,
      rgba(255, 255, 255, 0.35) 100%
    );
    color: var(--accent-700);
  }
  @supports not (backdrop-filter: blur(1px)) {
    .navbar {
      background: rgba(255, 255, 255, 0.85);
    }
    .ghost { background: rgba(255, 255, 255, 0.55); }
  }

  @media (max-width: 380px) {
    .navbar {
      gap: var(--space-2);
      padding-left: var(--space-3);
      padding-right: var(--space-3);
    }
    .right { gap: var(--space-1); }
    .btn-sm { padding-left: var(--space-2); padding-right: var(--space-2); }
    .email { max-width: 10ch; }
    .ledger-title { font-size: 0.95rem; }
  }
</style>
