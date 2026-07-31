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

  // Close avatar menu when leaving compact chrome.
  $: if (!compact) menuOpen = false;

  // Guest on a ledger page: always「登录以保存」(never plain「登录」).
  $: guestSaveLabel = inSession() && !isJoinPage();

  async function handleLogout() {
    menuOpen = false;
    await logout();
    await goto('/');
  }

  function inSession(): boolean {
    return /^\/sessions\/\d+(\/|$)/.test(page.url.pathname) ||
           /^\/s\/[A-Z0-9]+(\/|$)/i.test(page.url.pathname);
  }
  function isSessionsListPage(): boolean {
    return page.url.pathname === '/sessions';
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
      aria-label="轻均分账 FairLite"
    >
      <span class="brand-zh" aria-hidden="true">
        <span class="brand-zh-inner">
          <span class="brand-zh-glass" aria-hidden="true">轻均</span>
          轻均
        </span>
      </span>
      <span class="brand-zh brand-zh--en-size" aria-hidden="true">
        <span class="brand-zh-inner">
          <span class="brand-zh-glass" aria-hidden="true">分账</span>
          分账
        </span>
      </span>
      <span class="brand-en">FairLite</span>
    </a>
  </div>

  {#if page.url.pathname !== '/auth/login' && !isLoginPage()}
    <div class="right" class:right-compact={compact}>
      <!-- Title + chrome + avatar: one-step L→R morph (avatar slot reserved immediately). -->
      <div
        class="ledger-title"
        class:visible={compact && !!ledgerTitle}
        data-testid="navbar-ledger-title"
        title={ledgerTitle ?? undefined}
        aria-hidden={compact && ledgerTitle ? undefined : 'true'}
      >
        <span class="ledger-title-text">{ledgerTitle ?? ''}</span>
      </div>

      <div
        class="nav-chrome-full"
        class:collapsed={compact}
        aria-hidden={compact ? 'true' : undefined}
      >
        {#if $user}
          <span class="email" title="{$user.email}">{$user.default_name}</span>
          {#if page.url.pathname !== '/sessions/new' && !isSessionsListPage()}
            <a href="/sessions" class="btn-sm links-item" tabindex={compact ? -1 : 0}>我的账本</a>
          {/if}
          <button class="ghost btn-sm" onclick={handleLogout} tabindex={compact ? -1 : 0}>注销登录</button>
        {:else if guestSaveLabel}
          <a
            href={loginHref}
            class="btn-sm"
            data-testid="navbar-login-save"
            tabindex={compact ? -1 : 0}
          >登录以保存</a>
        {:else if !inSession()}
          <a href="/auth/login" class="btn-sm" tabindex={compact ? -1 : 0}>登录</a>
        {/if}
      </div>

      <div
        class="avatar-menu"
        class:expanded={compact}
        bind:this={menuRoot}
        aria-hidden={compact ? undefined : 'true'}
      >
        <button
          type="button"
          class="avatar-btn"
          class:anon={!$user}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={$user ? `账户菜单：${$user.default_name}` : '账户菜单'}
          data-testid="navbar-avatar-btn"
          tabindex={compact ? 0 : -1}
          onclick={toggleMenu}
        >
          <span class="avatar-letter">
            {$user ? avatarLetter($user.default_name) : '登'}
          </span>
        </button>
        {#if menuOpen && compact}
          <div class="avatar-popover" role="menu" data-testid="navbar-avatar-menu">
            {#if $user}
              <div class="menu-identity" role="presentation">
                <span class="menu-name">{$user.default_name}</span>
                {#if $user.email}
                  <span class="menu-email" title={$user.email}>{$user.email}</span>
                {/if}
              </div>
              {#if page.url.pathname !== '/sessions/new' && !isSessionsListPage()}
                <a href="/sessions" class="menu-item" role="menuitem" onclick={() => (menuOpen = false)}>
                  我的账本
                </a>
              {/if}
              <button type="button" class="menu-item danger" role="menuitem" onclick={handleLogout}>
                注销登录
              </button>
            {:else if guestSaveLabel}
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
    </div>
  {/if}
</header>

<style>
  :global(:root) {
    /* Content row = touch target so full chrome (44px btn) and compact avatar
       share the same bar height — morph must not resize the header.
       Note: --navbar-h is owned by +layout.svelte (measured full bar height for
       page offset) — do not use it to size .navbar itself. */
    --navbar-content-h: var(--touch-target); /* 44px */
  }
  .navbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    width: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    overflow-x: clip;
    /* Fixed bar height (padding + 44px row) — unchanged in compact morph. */
    height: calc(2 * var(--space-3) + var(--navbar-content-h) + env(safe-area-inset-top, 0px));
    min-height: calc(2 * var(--space-3) + var(--navbar-content-h) + env(safe-area-inset-top, 0px));
    max-height: calc(2 * var(--space-3) + var(--navbar-content-h) + env(safe-area-inset-top, 0px));
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
    /* Glass chrome stays constant — do NOT thicken/opaque on compact title morph. */
  }
  /* Fill under status bar with paper tone so iOS overscroll never flashes stark white above the bar. */
  .navbar::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: env(safe-area-inset-top, 0px);
    background: #fafafa;
    pointer-events: none;
    z-index: -1;
  }

  .left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    flex: 0 0 auto;
    height: var(--navbar-content-h);
    min-height: var(--navbar-content-h);
  }

  .brand {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    color: var(--color-text);
    text-decoration: none;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 18rem;
    flex-shrink: 0;
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
  /* 「分账」— 轻均同款玻璃细体，字号对齐 FairLite (.brand-en) */
  .brand-zh--en-size .brand-zh-inner {
    font-size: 0.78em;
    line-height: 1.1;
    letter-spacing: 0.12em;
    text-indent: 0.12em;
    -webkit-text-stroke: 0.4px rgba(0, 0, 0, 0.65);
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

  .right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
    min-width: 0;
    flex: 1 1 auto;
    flex-wrap: nowrap;
    justify-content: flex-end;
    position: relative;
    height: var(--navbar-content-h);
    min-height: var(--navbar-content-h);
  }
  .right.right-compact {
    flex-wrap: nowrap;
  }

  /*
   * One-step L→R morph:
   * - Avatar width reserved immediately (no width tween) so title's layout target
   *   IS the final seat from frame 0 — avoids the old two-hop (button seat → final).
   * - Title: final max-width on enter (instant), slides L→R via translateX.
   * - Chrome: leaves flow immediately, slides L→R (positive X) + fades, same timing.
   * Timings restored to original 320ms / 280ms / 240ms / 260ms curves.
   */
  .ledger-title {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 0;
    height: var(--navbar-content-h);
    display: flex;
    align-items: center;
    opacity: 0;
    transform: translate3d(-18px, 0, 0);
    overflow: hidden;
    pointer-events: none;
    visibility: hidden;
    transition:
      max-width 0s linear 320ms,
      opacity 280ms cubic-bezier(0.22, 1, 0.36, 1),
      transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
      visibility 0s linear 320ms;
  }
  .ledger-title.visible {
    /* Final width immediately — motion is pure L→R translate into that seat. */
    max-width: min(46vw, 12.5rem);
    opacity: 1;
    transform: translate3d(0, 0, 0);
    pointer-events: auto;
    visibility: visible;
    transition:
      max-width 0s linear 0s,
      opacity 280ms cubic-bezier(0.22, 1, 0.36, 1),
      transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
      visibility 0s linear 0s;
  }
  .ledger-title-text {
    display: block;
    font-family: var(--font-zh);
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--gray-900);
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    padding-inline-end: 2px;
  }

  .nav-chrome-full {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    min-width: 0;
    flex: 0 1 auto;
    height: var(--navbar-content-h);
    opacity: 1;
    transform: translate3d(0, 0, 0);
    transform-origin: right center;
    transition:
      opacity 240ms ease,
      transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
      visibility 0s linear 0s;
  }
  .nav-chrome-full.collapsed {
    /* Out of flow immediately so title layout = final seat; visual exit is L→R. */
    position: absolute;
    right: calc(36px + var(--space-2));
    top: 0;
    bottom: 0;
    transform: translate3d(20px, 0, 0);
    opacity: 0;
    pointer-events: none;
    visibility: hidden;
    transition:
      opacity 240ms ease,
      transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
      visibility 0s linear 320ms;
  }
  .nav-chrome-full .btn-sm {
    white-space: nowrap;
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
    flex: 0 0 0;
    width: 0;
    max-width: 0;
    height: var(--navbar-content-h);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    visibility: hidden;
    /* UAT: 头像消失时从右向左退出 (负 X), 跟 chrome 按钮从右向左进入同向.
     * 旧: scale-only + origin center → 宽变 0 后残影挂在右侧, 视觉像 L→R 消失. */
    transform: translate3d(-20px, 0, 0) scale(0.55);
    transform-origin: right center;
    overflow: visible;
    pointer-events: none;
    /* Width reserved instantly when expanded — only opacity/scale/translate tween. */
    transition:
      opacity 260ms ease,
      transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
      visibility 0s linear 320ms;
  }
  .avatar-menu.expanded {
    flex: 0 0 36px;
    width: 36px;
    max-width: 36px;
    opacity: 1;
    visibility: visible;
    transform: translate3d(0, 0, 0) scale(1);
    pointer-events: auto;
    transition:
      opacity 260ms ease,
      transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
      visibility 0s linear 0s;
  }
  .avatar-btn {
    /* Override global button { min-height: 44px; padding: … } — that stretched the chip into an oval. */
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    min-width: 36px;
    min-height: 36px;
    max-width: 36px;
    max-height: 36px;
    aspect-ratio: 1 / 1;
    flex: 0 0 36px;
    border-radius: 50%;
    border: 1px solid rgba(40, 40, 40, 0.28);
    background: linear-gradient(135deg, rgba(40, 40, 40, 0.92) 0%, rgba(58, 58, 58, 0.88) 100%);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    margin: 0;
    line-height: 0;
    overflow: hidden;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.35),
      0 2px 8px rgba(40, 40, 40, 0.28);
    transition: transform 120ms ease, box-shadow 150ms ease;
  }
  .avatar-btn.anon {
    background: linear-gradient(135deg, rgba(40, 40, 40, 0.14) 0%, rgba(58, 58, 58, 0.10) 100%);
    color: var(--btn-label, var(--logo-ink, #1a1a1a));
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
    justify-content: center;
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
    text-align: center;
  }
  .menu-item:hover {
    background: rgba(40, 40, 40, 0.08);
    color: var(--btn-label, var(--logo-ink, #1a1a1a));
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
    border: 1px solid rgba(40, 40, 40, 0.25);
    background: linear-gradient(
      135deg,
      rgba(40, 40, 40, 0.04) 0%,
      rgba(58, 58, 58, 0.02) 100%
    );
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.95),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 2px rgba(15, 23, 42, 0.04);
    color: var(--btn-label, var(--logo-ink, #1a1a1a));
    font-size: var(--font-size-sm);
    font-weight: 600;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-sm:hover {
    background: linear-gradient(
      135deg,
      rgba(40, 40, 40, 0.10) 0%,
      rgba(58, 58, 58, 0.06) 100%
    );
    text-decoration: none;
  }
  .ghost.btn-sm {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.20) 0%,
      rgba(255, 255, 255, 0.10) 100%
    );
    border-color: rgba(40, 40, 40, 0.20);
    color: var(--gray-700);
    box-shadow: none;
  }
  .ghost.btn-sm:hover {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.50) 0%,
      rgba(255, 255, 255, 0.35) 100%
    );
    color: var(--btn-label, var(--logo-ink, #1a1a1a));
  }
  @supports not (backdrop-filter: blur(1px)) {
    .btn-sm { background: rgba(40, 40, 40, 0.08); }
    .navbar {
      background: rgba(255, 255, 255, 0.85);
    }
    .ghost.btn-sm { background: rgba(255, 255, 255, 0.55); }
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
    .ledger-title-text { font-size: 0.9rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ledger-title,
    .ledger-title.visible,
    .nav-chrome-full,
    .nav-chrome-full.collapsed,
    .avatar-menu,
    .avatar-menu.expanded {
      transition: none;
    }
  }
</style>
