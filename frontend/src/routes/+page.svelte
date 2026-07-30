<script lang="ts">
  /**
   * Landing — 轻均 FairLite
   * Hero: brand + one headline + one support line + CTA group on full-bleed atmosphere.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { user, logout } from '$stores/user';

  const BG_URL =
    'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=1600&q=80';

  let busy = false;
  let error: string | null = null;
  let ready = false;

  onMount(() => {
    document.body.style.overflow = 'hidden';
    document.body.style.touchAction = 'none';
    requestAnimationFrame(() => {
      ready = true;
    });
    return () => {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    };
  });

  async function handleLogout() {
    if (busy) return;
    busy = true;
    try {
      await logout();
    } catch (e) {
      console.error('logout failed:', e);
    }
    busy = false;
  }

  async function handleStartUsing() {
    if (busy) return;
    error = null;
    busy = true;
    try {
      if ($user) {
        await goto('/sessions', { replaceState: true });
        return;
      }
      await goto('/sessions/new', { replaceState: true });
    } catch (e: any) {
      error = e?.message ?? '跳转失败，请重试';
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>轻均 FairLite — 极简分账，一链即平</title>
  <meta name="description" content="旅行，合租，聚餐，随手分享记账，AA 不再烦恼" />
</svelte:head>

<div class="landing" class:ready>
  <div class="stage" aria-hidden="true">
    <img class="stage-img" src={BG_URL} alt="" />
    <div class="stage-wash"></div>
    <div class="stage-grain"></div>
  </div>

  <div class="hero">
    <div class="brand" aria-label="轻均 FairLite">
      <span class="brand-zh">
        <span class="brand-zh-inner">
          <span class="brand-zh-glass" aria-hidden="true">轻均</span>
          轻均
        </span>
      </span>
      <span class="brand-en">FairLite</span>
    </div>

    <h1 class="headline">极简分账，一链即平。</h1>
    <p class="support">旅行，合租，聚餐，随手分享记账，AA 不再烦恼</p>

    {#if error}
      <div class="error-banner" role="alert">{error}</div>
    {/if}

    <div class="actions">
      {#if !$user}
        <a href="/auth/login" class="btn-primary">登录</a>
        <div class="or-row" aria-hidden="true">
          <span class="or-char">或</span>
          <span>无需注册，</span>
        </div>
        <button
          type="button"
          class="btn-ghost"
          onclick={handleStartUsing}
          disabled={busy}
        >
          {busy ? '创建中…' : '直接开始使用'}
        </button>
      {:else}
        <button
          type="button"
          class="btn-primary"
          onclick={handleStartUsing}
          disabled={busy}
        >
          {busy ? '打开账本中…' : '进入我的账本'}
        </button>
        <p class="hint">
          已登录为 {$user.default_name}
          <button
            class="logout-link"
            type="button"
            onclick={handleLogout}
            disabled={busy}
          >退出登录</button>
        </p>
      {/if}
    </div>
  </div>
</div>

<style>
  .landing {
    position: fixed;
    inset: 0;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    --ink: #071a1c;
    --foam: #f4f7f5;
    --mist: rgba(244, 247, 245, 0.78);
    --sea: #1f6f66;
  }

  .stage {
    position: absolute;
    inset: 0;
  }

  .stage-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center 35%;
    transform: scale(1.06);
    animation: ken 28s ease-in-out infinite alternate;
  }

  .landing:not(.ready) .stage-img {
    animation: none;
  }

  .stage-wash {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(
        165deg,
        rgba(7, 26, 28, 0.55) 0%,
        rgba(12, 48, 46, 0.42) 42%,
        rgba(18, 36, 40, 0.62) 100%
      ),
      radial-gradient(
        120% 80% at 50% 18%,
        rgba(31, 111, 102, 0.28) 0%,
        transparent 58%
      );
  }

  .stage-grain {
    position: absolute;
    inset: 0;
    opacity: 0.18;
    pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E");
    mix-blend-mode: soft-light;
  }

  .hero {
    position: relative;
    z-index: 1;
    width: min(100%, 26rem);
    padding: 2rem 1.5rem calc(2rem + env(safe-area-inset-bottom, 0px));
    text-align: center;
  }

  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.55rem;
    margin-bottom: 1.5rem;
  }

  /*
   * 「轻均」— 细高 + iOS 锁屏时间式 Liquid Glass
   * - 细：Noto Sans SC ExtraLight (200)
   * - 高：scaleY 拉长、scaleX 略收，呼应「轻而匀称」
   * - 玻璃：冷白玻璃体 + 外沿描边 + 顶部高光带（paint-order / background-clip）
   */
  .brand-zh {
    display: inline-block;
    animation: rise 0.95s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .brand-zh-inner {
    position: relative;
    display: inline-block;
    font-family: 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', sans-serif;
    font-weight: 200;
    font-size: clamp(4.6rem, 20vw, 7rem);
    line-height: 0.92;
    letter-spacing: 0.22em;
    text-indent: 0.22em;
    transform: scaleX(0.88) scaleY(1.16);
    transform-origin: center center;
    -webkit-font-smoothing: antialiased;
    font-synthesis: none;
    text-rendering: optimizeLegibility;

    /* 玻璃体：半透冷白，透出背后氛围 */
    color: rgba(236, 244, 242, 0.72);

    /* 玻璃外沿 —— 描在 fill 后，只露外侧亮边 */
    -webkit-text-stroke: 1.35px rgba(255, 255, 255, 0.72);
    paint-order: stroke fill;

    filter: drop-shadow(0 10px 28px rgba(0, 0, 0, 0.38))
      drop-shadow(0 1px 0 rgba(255, 255, 255, 0.35));
  }

  /* 顶部高光带：模拟曲面玻璃受光（iOS 锁屏数字同族） */
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
      180deg,
      rgba(255, 255, 255, 0.98) 0%,
      rgba(255, 255, 255, 0.88) 12%,
      rgba(245, 252, 250, 0.55) 28%,
      rgba(230, 240, 238, 0.12) 42%,
      rgba(230, 240, 238, 0) 55%
    );
    -webkit-background-clip: text;
    background-clip: text;
    animation: glassSheen 6.5s ease-in-out infinite alternate;
  }

  .brand-en {
    font-family: 'Inter Variable', Inter, system-ui, sans-serif;
    font-weight: 400;
    font-size: clamp(1rem, 3.6vw, 1.25rem);
    letter-spacing: 0.32em;
    text-indent: 0.32em;
    text-transform: none;
    color: rgba(244, 247, 245, 0.78);
    animation: rise 0.95s cubic-bezier(0.16, 1, 0.3, 1) 0.08s both;
  }

  .headline {
    margin: 0;
    font-family: 'Noto Sans SC', 'PingFang SC', sans-serif;
    font-weight: 500;
    font-size: clamp(1.2rem, 4.6vw, 1.55rem);
    line-height: 1.35;
    color: var(--foam);
    text-shadow: 0 2px 16px rgba(0, 0, 0, 0.28);
    animation: rise 0.9s cubic-bezier(0.16, 1, 0.3, 1) 0.16s both;
  }

  .support {
    margin: 0.85rem 0 0;
    font-family: 'Noto Sans SC', 'PingFang SC', sans-serif;
    font-weight: 400;
    font-size: clamp(0.92rem, 3.4vw, 1.02rem);
    line-height: 1.55;
    color: var(--mist);
    animation: rise 0.9s cubic-bezier(0.16, 1, 0.3, 1) 0.24s both;
  }

  .error-banner {
    margin-top: 1rem;
    background: rgba(190, 50, 60, 0.88);
    color: #fff;
    border-radius: 0.6rem;
    padding: 0.65rem 1rem;
    font-size: 0.875rem;
  }

  .actions {
    margin-top: 2rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: stretch;
    animation: rise 0.9s cubic-bezier(0.16, 1, 0.3, 1) 0.34s both;
  }

  .btn-primary,
  .btn-ghost {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 52px;
    padding: 0 1.5rem;
    border-radius: 9999px;
    cursor: pointer;
    text-decoration: none;
    font-family: 'Noto Sans SC', 'Inter Variable', sans-serif;
    letter-spacing: 0.02em;
    transition: background 0.18s, transform 0.1s, box-shadow 0.18s, border-color 0.18s;
    -webkit-tap-highlight-color: transparent;
    outline: none;
  }

  .btn-primary {
    color: #06201e;
    font-size: 1rem;
    font-weight: 600;
    background: linear-gradient(180deg, #f7faf8 0%, #e6efeb 100%);
    border: 1px solid rgba(255, 255, 255, 0.55);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.85),
      0 10px 28px rgba(0, 0, 0, 0.22);
  }

  .btn-primary:hover:not(:disabled) {
    background: linear-gradient(180deg, #ffffff 0%, #eef5f2 100%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.95),
      0 12px 32px rgba(0, 0, 0, 0.26);
  }

  .btn-ghost {
    min-height: 48px;
    color: var(--foam);
    font-size: 0.95rem;
    font-weight: 500;
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.34);
    backdrop-filter: saturate(140%) blur(8px);
    -webkit-backdrop-filter: saturate(140%) blur(8px);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);
  }

  .btn-ghost:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.5);
  }

  .btn-primary:active:not(:disabled),
  .btn-ghost:active:not(:disabled) {
    transform: scale(0.98);
  }

  .btn-primary:disabled,
  .btn-ghost:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary:focus-visible,
  .btn-ghost:focus-visible,
  .logout-link:focus-visible {
    outline: 2px solid rgba(244, 247, 245, 0.85);
    outline-offset: 2px;
  }

  .or-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    font-size: 0.8125rem;
    color: rgba(244, 247, 245, 0.55);
    padding: 0.15rem 0;
  }

  .or-row .or-char {
    font-weight: 500;
    color: rgba(244, 247, 245, 0.72);
  }

  .hint {
    margin: 0.35rem 0 0;
    font-size: 0.8125rem;
    color: rgba(244, 247, 245, 0.62);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .logout-link {
    background: rgba(255, 255, 255, 0.14);
    border: 1px solid rgba(255, 255, 255, 0.34);
    backdrop-filter: saturate(140%) blur(6px);
    -webkit-backdrop-filter: saturate(140%) blur(6px);
    color: var(--foam);
    font-size: 0.8125rem;
    font-weight: 500;
    padding: 0.28rem 0.8rem;
    border-radius: 9999px;
    cursor: pointer;
    font-family: inherit;
  }

  .logout-link:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.24);
  }

  .logout-link:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(18px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes ken {
    from {
      transform: scale(1.06) translate3d(0, 0, 0);
    }
    to {
      transform: scale(1.12) translate3d(0, -1.5%, 0);
    }
  }

  @keyframes glassSheen {
    from {
      opacity: 0.88;
      filter: brightness(1);
    }
    to {
      opacity: 1;
      filter: brightness(1.08);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .stage-img,
    .brand-zh,
    .brand-en,
    .headline,
    .support,
    .actions,
    .brand-zh-glass {
      animation: none !important;
    }
  }
</style>
