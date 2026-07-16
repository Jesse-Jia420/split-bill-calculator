<script lang="ts">
  /**
   * v0.3.1 (Sprint 4 T19) — Redesigned landing page.
   *
   * Design: Mobile-first immersive landing.
   * - Full-page Unsplash background image
   * - Dark semi-transparent overlay
   * - Centered tagline + 2 CTA buttons
   * - Anonymous: "直接开始使用" → /sessions/new (wizard) + "登录"
   * - Logged-in users are redirected to /sessions by +layout.svelte
   *
   * The "直接开始使用" button sends both anonymous and logged-in users
   * to the same 2-step wizard (/sessions/new). Logged-in users skip
   * the wizard and go straight to /sessions from there.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Wallet } from 'lucide-svelte';
  import { user } from '$stores/user';
  import { FRONTEND_VERSION } from '$lib/version';

  // Background image: travel / friends sharing good times
  const BG_URL =
    'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=1280&q=75';

  const TAGLINE = '轻松分摊，一起记账';
  const SUB = '旅行、合租、聚餐 — 随时随地，AA 不再烦恼';

  let busy = false;
  let error: string | null = null;

  onMount(() => {
    // Landing is a full-viewport immersive page (BG image + 2 CTAs).
    // Lock body scroll + disable touch-action so iOS Safari doesn't
    // bounce / rubber-band when the user swipes at the edges. Restored
    // on unmount so /sessions/* pages scroll normally.
    document.body.style.overflow = 'hidden';
    document.body.style.touchAction = 'none';
    return () => {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    };
  });

  async function handleStartUsing() {
    if (busy) return;
    error = null;
    busy = true;
    try {
      // Logged-in users go straight to the dashboard, not the wizard.
      // (v0.3.1: keep existing behavior for $user branch — unchanged.)
      if ($user) {
        await goto('/sessions', { replaceState: true });
        return;
      }
      // Anonymous users land on the wizard to name the book + list
      // their group, then the wizard creates the session.
      await goto('/sessions/new', { replaceState: true });
    } catch (e: any) {
      error = e?.message ?? '跳转失败，请重试';
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>Split Bill — 轻松分摊</title>
</svelte:head>

<!-- Full-page background container -->
<div class="bg-wrapper">
  <img class="bg-img" src={BG_URL} alt="friends" />

  <div class="overlay">
    <!-- Centered content -->
    <div class="hero">
      <div class="brand-row">
        <span class="brand-icon"><Wallet size={32} strokeWidth={1.75} /></span>
        <span class="brand-name">Split Bill</span>
      </div>

      <h1 class="tagline">{TAGLINE}</h1>
      <p class="sub">{SUB}</p>

      {#if error}
        <div class="error-banner">{error}</div>
      {/if}

      <div class="actions">
        <button
          class="btn-primary"
          onclick={handleStartUsing}
          disabled={busy}
        >
          {busy ? '创建中…' : ($user ? '进入我的账本' : '直接开始使用')}
        </button>

        {#if !$user}
          <a href="/auth/login" class="btn-ghost">
            登录
          </a>
        {/if}
      </div>

      <p class="hint">
        {#if $user}
          已登录为 {$user.default_name}
        {:else}
          无需注册，直接使用
        {/if}
      </p>
    </div>
  </div>
</div>

<style>
  /* Full-page background wrapper */
  .bg-wrapper {
    position: fixed;
    inset: 0;
    z-index: 0;
  }

  .bg-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center;
  }

  /* Dark overlay for text readability.
     v0.3.17 #16 hotfix: 0.55 -> 0.42 (PO msg 03:00), 让玻璃按钮 .glass-pill
     半透明白背景更清晰看见背景图, 玻璃质感更明显。 */
  .overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .hero {
    text-align: center;
    padding: 2rem 1.5rem;
    max-width: 400px;
    width: 100%;
    animation: fadeUp 0.6s ease-out both;
  }

  @keyframes fadeUp {
    from {
      opacity: 0;
      transform: translateY(24px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .brand-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  /* v0.3.17 #16 hotfix: emoji -> Lucide Wallet icon
     - 内联 SVG, line-height 1 + display inline-flex 让 SVG 跟 brand-name baseline 对齐
     - color: #fff 跟 .brand-name 同色, 保持视觉一致 */
  .brand-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    color: #fff;
  }

  .brand-name {
    font-size: 1.25rem;
    font-weight: 700;
    color: #fff;
    letter-spacing: 0.02em;
  }

  .tagline {
    font-size: 2.25rem;
    font-weight: 700;
    color: #fff;
    margin: 0 0 0.75rem;
    line-height: 1.15;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .sub {
    font-size: 1rem;
    color: rgba(255, 255, 255, 0.82);
    margin: 0 0 2rem;
    line-height: 1.5;
  }

  .error-banner {
    background: rgba(244, 63, 94, 0.9);
    color: #fff;
    border-radius: 0.5rem;
    padding: 0.625rem 1rem;
    font-size: 0.875rem;
    margin-bottom: 1rem;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: stretch;
  }

  /* v0.3.17 #16 hotfix: 纯色 -> 玻璃 pill
     - 主按钮: 实色蓝 + glass-pill (半透明白底 + backdrop blur)
     - ghost: 浅白 + glass-pill (更透, 看见背景图)
     - 玻璃让暗 overlay 0.55 -> 0.42 后背景图更可见 */
  .btn-primary,
  .btn-ghost {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 1.5rem;
    border-radius: 9999px;
    cursor: pointer;
    transition: background 0.18s, transform 0.1s, box-shadow 0.18s;
    text-decoration: none;
    letter-spacing: 0.01em;
    font-family: inherit;
  }

  /* 主按钮: 实色蓝 + glass-pill 玻璃化 */
  .btn-primary {
    min-height: 52px;
    background: linear-gradient(
      135deg,
      rgba(59, 130, 246, 0.85) 0%,
      rgba(99, 102, 241, 0.78) 100%
    );
    border: 1px solid rgba(255, 255, 255, 0.35);
    backdrop-filter: saturate(200%) blur(20px);
    -webkit-backdrop-filter: saturate(200%) blur(20px);
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 6px 20px rgba(59, 130, 246, 0.35);
  }

  .btn-primary:hover:not(:disabled) {
    background: linear-gradient(
      135deg,
      rgba(59, 130, 246, 0.95) 0%,
      rgba(99, 102, 241, 0.9) 100%
    );
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.1),
      0 8px 24px rgba(59, 130, 246, 0.45);
  }

  .btn-primary:active:not(:disabled) {
    transform: scale(0.98);
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Ghost: 浅玻璃白 (跟 app.css .glass-pill 同参数, rgba 提到 0.22/0.18
     让深色 overlay 也能看见背景图纹理)。 */
  .btn-ghost {
    min-height: 48px;
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.22) 0%,
      rgba(255, 255, 255, 0.14) 100%
    );
    border: 1.5px solid rgba(255, 255, 255, 0.45);
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    color: #fff;
    font-size: 0.9375rem;
    font-weight: 500;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.35),
      0 4px 14px rgba(0, 0, 0, 0.18);
  }

  .btn-ghost:hover {
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.32) 0%,
      rgba(255, 255, 255, 0.22) 100%
    );
    border-color: rgba(255, 255, 255, 0.7);
    text-decoration: none;
    color: #fff;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.45),
      0 6px 18px rgba(0, 0, 0, 0.22);
  }

  /* Safari iOS < 18 fallback (无 backdrop-filter) */
  @supports not (backdrop-filter: blur(1px)) {
    .btn-primary { background: rgba(59, 130, 246, 0.9); }
    .btn-ghost { background: rgba(255, 255, 255, 0.22); }
  }

  .hint {
    margin-top: 1.25rem;
    font-size: 0.8125rem;
    color: rgba(255, 255, 255, 0.55);
  }
</style>
