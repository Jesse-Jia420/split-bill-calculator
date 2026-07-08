<script lang="ts">
  /**
   * v0.3.1 (Sprint 4 T19) — Redesigned landing page.
   *
   * Design: Mobile-first immersive landing.
   * - Full-page Unsplash background image
   * - Dark semi-transparent overlay
   * - Centered tagline + 2 CTA buttons
   * - Anonymous: "直接开始使用" (creates anon session) + "登录"
   * - Logged-in users are redirected to /sessions by +layout.svelte
   *
   * The "直接开始使用" button creates an anonymous session with
   * a single placeholder nickname slot, then navigates to the join
   * page so the user can claim it and enter the session.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
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
    // If user is already logged in, +layout.svelte will redirect to /sessions.
    // We don't need to do anything here.
  });

  async function handleStartUsing() {
    // v0.3.x (PO 10:39 拍板, 推翻 v0.3.1 PO 16:59):
    //   landing "直接开始使用" -> /sessions/new (Wizard 3 步) -- anon 创建 session
    //   标准入口. v0.3.1 quick-start 1-member + 跳 join 路径作废.
    if ($user) {
      await goto('/sessions', { replaceState: true });
      return;
    }
    await goto('/sessions/new', { replaceState: true });
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
        <span class="brand-icon">💰</span>
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
          {busy ? '创建中…' : ($user ? '进入我的session' : '直接开始使用')}
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

  /* Dark overlay for text readability */
  .overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
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

  .brand-icon {
    font-size: 2rem;
    line-height: 1;
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

  .btn-primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 52px;
    padding: 0 1.5rem;
    background: #3b82f6;
    border: none;
    border-radius: 9999px;
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
    text-decoration: none;
    letter-spacing: 0.01em;
  }

  .btn-primary:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-primary:active:not(:disabled) {
    transform: scale(0.98);
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-ghost {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0 1.5rem;
    background: rgba(255, 255, 255, 0.15);
    border: 1.5px solid rgba(255, 255, 255, 0.5);
    border-radius: 9999px;
    color: #fff;
    font-size: 0.9375rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    text-decoration: none;
  }

  .btn-ghost:hover {
    background: rgba(255, 255, 255, 0.25);
    border-color: rgba(255, 255, 255, 0.75);
    text-decoration: none;
    color: #fff;
  }

  .hint {
    margin-top: 1.25rem;
    font-size: 0.8125rem;
    color: rgba(255, 255, 255, 0.55);
  }
</style>
