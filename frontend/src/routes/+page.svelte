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
   *
   * v0.3.21 #106 (PO msg 16:58 + 17:16): landing F2-v2 — SplitIt E 双行 stacked
   * (line-1 "Split" 125px italic serif 700 + line-2 "It." 58px tracked sans)
   * with glass material (cool ivory #E6ECF2 body + 3px/2px white outer stroke
   * painted via paint-order: stroke fill + top specular band via -webkit-background-clip
   * + soft cool drop shadow). Tagline emphasis「撕不裂」— same italic-serif glass
   * material at 42px (not 40 — at 40 the 1.5px stroke / top specular degrades to
   * faint at @1x; 42 + 1.8px keeps rim crisp). Buttons swapped (primary = 登录,
   * ghost = 直接开始使用), with .or-row middle divider ("或 · 无需注册，直接使用")
   * and removed bottom .hint for anonymous state (hint copy migrated to .or-row).
   * Logged-in state keeps .hint with logout link (unchanged).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Wallet } from 'lucide-svelte';
  import { user, logout } from '$stores/user';
  import { FRONTEND_VERSION } from '$lib/version';

  // Background image: travel / friends sharing good times
  const BG_URL =
    'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=1280&q=75';

  // v0.3.21 #106: tagline is no longer a plain string — it contains an inline
  // <span class="tagline-emphasis">「撕不裂」</span> for the brand-emphasis
  // callback to the wordmark (PO msg 16:58 #2). Defined as a Svelte snippet
  // so the JSX stays in the template where it can be styled.
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

  // v0.3.21 #102 (PO msg 14:53): logout 处理器 — landing 已登录显示退出超链接, 点击调用 logout() 清 user store
  async function handleLogout() {
    if (busy) return;
    busy = true;
    try {
      await logout();
    } catch (e) {
      console.error("logout failed:", e);
    }
    busy = false;
  }

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
  <title>SplitIt — 轻松分摊</title>
</svelte:head>

<!-- Full-page background container -->
<div class="bg-wrapper">
  <img class="bg-img" src={BG_URL} alt="friends" />

  <div class="overlay">
    <!-- Centered content -->
    <div class="hero">
      <!-- v0.3.21 #106: SplitIt 改成 E 双行 stacked (line-1 "Split" italic serif 125px
           + line-2 "It." tracked sans 58px) + glass material — 完整替换 v0.3.21 #105
           的 ultralight 单 wordmark。 glass 材质: 冷 ivory #E6ECF2 body + 白色 outer
           stroke (paint-order: stroke fill) + top specular band (background-clip: text
           渐变 + 双层结构 .hl) + soft cool drop shadow. -->
      <div class="logo-slot">
        <div class="logo-stack">
          <span class="brand-line-1">
            <span class="hl" aria-hidden="true">Split</span>Split
          </span>
          <span class="brand-line-2">
            <span class="hl" aria-hidden="true">It.</span>It.
          </span>
        </div>
      </div>

      <!-- v0.3.21 #106: tagline 内嵌 brand-emphasis 「撕不裂」— 全角书名号 U+300C/U+300D
           (不改成英文引号或直角引号). emphasis 跟 wordmark 同 italic-serif + glass
           material, 42px (不是 40 — 40 时 1.5px stroke / top specular band @1x 几乎
           看不见, 42 + 1.8px stroke 保留 rim 清晰). -->
      <h1 class="tagline">
        分账够清楚，友情<span class="tagline-emphasis"><span class="hl" aria-hidden="true">「撕不裂」</span>「撕不裂」</span>。
      </h1>
      <p class="sub">{SUB}</p>

      {#if error}
        <div class="error-banner">{error}</div>
      {/if}

      <!-- v0.3.21 #106 (PO msg 16:58 #3 + #4): 按钮对调 + 中间 .or-row.
           - 匿名态: primary = 登录 (<a href> 真 navigation), .or-row 中段,
             ghost = 直接开始使用 (<button> 走 handleStartUsing → wizard)
           - 已登录态: primary = 进入我的账本 (走 handleStartUsing → /sessions) -->
      <div class="actions">
        {#if !$user}
          <a href="/auth/login" class="btn-primary">登录</a>
          <div class="or-row">
            <span class="or-char">或</span>
            <span>无需注册，直接使用</span>
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
        {/if}
      </div>

      <!-- v0.3.21 #106: 匿名态 .hint 文案已搬到 .or-row, 此处匿名态不渲染.
           已登录态保留 .hint (含退出登录), 不动. -->
      {#if $user}
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

  /* v0.3.21 #106: 删除 .brand-row (单 wordmark flex 容器), 改用 .logo-stack
     双行 stacked. .logo-slot 已存在 (margin-bottom 1.5rem) 保留. */

  /* F2-v2 — Liquid Glass outline + inset highlight (Apple Intelligence / Vision Pro)
     Locked layout: two-line stacked (E baseline).
     Glass-material idea: the wordmark reads as a piece of solid,
     polished glass sitting in front of the photo. Each letter has:
       1. a clear bright *edge* — a thin white outer rim achieved
          via a wide white stroke drawn BEHIND the fill (paint-order)
          so only the outer half-pixel is visible
       2. a clear top *specular band* — the upper third of every
          letter is whiter than the body, simulating light catching
          the top of a curved glass surface
       3. a soft cool/neutral drop shadow for depth (the glass is
          in front of the photo, not glowing into it)
     Critical contrast with F1 (which is milky / semi-transparent)
     and F3 (which is iridescent / chromatic): F2 is OPAQUE WHITE
     WITH A CRISP RIM AND A SPECULAR TOP. No color, no refraction. */
  .logo-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: clamp(0.15rem, 0.4vw, 0.3rem);
    line-height: 0.92;
  }

  .brand-line-1,
  .brand-line-2 {
    position: relative;
    display: inline-block;
    -webkit-font-smoothing: antialiased;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
  }

  .brand-line-1 .hl,
  .brand-line-2 .hl {
    position: absolute;
    inset: 0;
    pointer-events: none;
    font: inherit;
    letter-spacing: inherit;
    line-height: inherit;
    text-transform: inherit;
    font-style: inherit;
  }

  /* ----- Line 1: "Split" italic serif 125px ----- */
  .brand-line-1 {
    font-family: "Times New Roman", "New York", "Charter",
      "Source Serif Pro", "Noto Serif", serif;
    font-style: italic;
    font-weight: 700;
    font-size: 125px;
    letter-spacing: -0.035em;
    line-height: 0.92;

    /* Solid glass body — pure opaque white, NOT translucent.
       The base fill must be a different value from the highlight
       gradient so the top band reads as a clear band of brightness. */
    color: #E6ECF2;

    /* Wide white stroke painted BEHIND the fill — the outer
       ~1.5px of the stroke is not covered by the fill, so it shows
       as a clean bright glass rim against the dark photo bg. */
    -webkit-text-stroke: 3px #FFFFFF;
    paint-order: stroke fill;

    /* Soft cool/neutral drop shadow for depth. Keep the halo COOL
       (not warm) so the wordmark reads as glass, not as a lit
       filament. */
    text-shadow:
      0 2px 4px rgba(220, 230, 245, 0.35),
      0 12px 32px rgba(0, 0, 0, 0.50);
  }
  /* Top specular band — drawn ON TOP of the base via inset:0
     absolute, with mix-blend-mode: normal so the gradient REPLACES
     the base color (not just brightens it, which would be invisible
     against #E6ECF2). The result: the upper ~30% of each letter
     is pure white, the rest is the cool ivory base. */
  .brand-line-1 .hl {
    color: transparent;
    -webkit-text-stroke: 0;
    background: linear-gradient(180deg,
      #FFFFFF 0%,
      #FFFFFF 14%,
      #F4F8FC 28%,
      rgba(230, 236, 242, 0.00) 40%,
      rgba(230, 236, 242, 0.00) 100%);
    -webkit-background-clip: text;
    background-clip: text;
  }

  /* ----- Line 2: "It." tracked sans 58px ----- */
  .brand-line-2 {
    font-family: -apple-system, BlinkMacSystemFont,
      "SF Pro Display", "Inter", "Helvetica Neue", sans-serif;
    font-style: normal;
    font-weight: 600;
    font-size: 58px;
    letter-spacing: 0.18em;
    line-height: 1;

    color: #E6ECF2;
    -webkit-text-stroke: 2px #FFFFFF;
    paint-order: stroke fill;

    text-shadow:
      0 1px 3px rgba(220, 230, 245, 0.30),
      0 8px 24px rgba(0, 0, 0, 0.50);
  }
  .brand-line-2 .hl {
    color: transparent;
    -webkit-text-stroke: 0;
    background: linear-gradient(180deg,
      #FFFFFF 0%,
      #FFFFFF 16%,
      #F4F8FC 32%,
      rgba(230, 236, 242, 0.00) 44%,
      rgba(230, 236, 242, 0.00) 100%);
    -webkit-background-clip: text;
    background-clip: text;
  }

  .tagline {
    font-size: 2.25rem;
    font-weight: 700;
    color: #fff;
    margin: 0 0 0.75rem;
    line-height: 1.15;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  /* v0.3.21 #106 (PO msg 16:58 #2 + 17:16): 「撕不裂」brand-emphasis —
     同 line-1 italic-serif + glass material, 42px (不是 40 — 40 时 1.5px
     stroke / top specular band 在 @1x 几乎看不见 rim; 42 + 1.8px stroke
     保留 rim 清晰但仍明显小于 wordmark).
     三级 hierarchy: wordmark (125) > emphasis (42) > tagline body (36). */
  .tagline-emphasis {
    position: relative;
    display: inline-block;
    font-family: "Times New Roman", "New York", "Charter",
      "Source Serif Pro", "Noto Serif", serif;
    font-style: italic;
    font-weight: 700;
    font-size: 42px;
    letter-spacing: -0.02em;
    line-height: 1;
    color: #E6ECF2;
    -webkit-text-stroke: 1.8px #FFFFFF;
    paint-order: stroke fill;
    vertical-align: -0.04em;  /* nudge to sit on CJK baseline */
    margin: 0 0.05em;
    -webkit-font-smoothing: antialiased;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
    text-shadow:
      0 1px 2px rgba(220, 230, 245, 0.30),
      0 5px 14px rgba(0, 0, 0, 0.40);
  }
  .tagline-emphasis .hl {
    position: absolute;
    inset: 0;
    pointer-events: none;
    color: transparent;
    -webkit-text-stroke: 0;
    background: linear-gradient(180deg,
      #FFFFFF 0%,
      #FFFFFF 18%,
      #F4F8FC 36%,
      rgba(230, 236, 242, 0.00) 48%,
      rgba(230, 236, 242, 0.00) 100%);
    -webkit-background-clip: text;
    background-clip: text;
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
  /* v0.3.20 #100 (PO msg 14:37): 主按钮改 透明玻璃 + 象牙白文字 — PO 原话
     "透明玻璃，象牙白文字，不要现在的蓝色按钮". 当前 v0.3.17 #16 蓝紫渐变 + 蓝字
     跟暗 overlay 强对比但抢戏. 改 rgba 白半透 + ivory 文字让按钮融到玻璃族. */
  .btn-primary {
    min-height: 52px;
    color: #FFFFF0; /* v0.3.20 #100 ivory white text */
    background: rgba(255, 255, 255, 0.20);
    border: 1px solid rgba(255, 255, 255, 0.45);
    backdrop-filter: saturate(200%) blur(20px);
    -webkit-backdrop-filter: saturate(200%) blur(20px);
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 6px 20px rgba(255, 255, 240, 0.30);
  }

  /* v0.3.21 #104 (PO msg 15:07): 删按钮蓝色边框 — Safari/Chrome 默认 focus
     outline 删掉 (改用 ivory focus-visible). -webkit-tap-highlight-color: transparent
     让 iOS tap 高亮也消失 (蓝色闪蓝). focus-visible (键盘 focus) 用 ivory outline
     仍给 a11y 反馈. */
  .btn-primary,
  .btn-primary:hover,
  .btn-primary:active,
  .btn-primary:focus,
  .btn-primary:focus-visible,
  .btn-ghost,
  .btn-ghost:hover,
  .btn-ghost:active,
  .btn-ghost:focus,
  .btn-ghost:focus-visible {
    -webkit-tap-highlight-color: transparent;
    outline: none;
  }
  .btn-primary:focus-visible,
  .btn-ghost:focus-visible {
    outline: 2px solid rgba(255, 255, 240, 0.8);
    outline-offset: 2px;
  }

  .btn-primary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.30);
    color: #FFFFF0;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.55),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08),
      0 8px 24px rgba(255, 255, 240, 0.35);
  }

  .btn-primary:active:not(:disabled) {
    transform: scale(0.97);
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
    .btn-primary { background: rgba(255, 255, 240, 0.85); }
    .btn-ghost { background: rgba(255, 255, 255, 0.85); }
    .btn-primary:focus, .btn-ghost:focus { outline: none; }
  }

  /* v0.3.21 #106 (PO msg 16:58 #4): "或 · 无需注册，直接使用" middle row —
     坐在两个按钮之间, 同删掉的底部 .hint 同灰色保持视觉重量不变. "或"
     略重 (500) 作 soft divider glyph; 紧 padding 让两个按钮仍读作
     一个 CTA cluster. */
  .or-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    font-size: 0.8125rem;
    color: rgba(255, 255, 255, 0.55);
    padding: 0.5rem 0 0.25rem;
    text-align: center;
  }
  .or-row .or-char {
    font-weight: 500;
    color: rgba(255, 255, 255, 0.70);
  }

  /* v0.3.21 #106: 匿名态底部 .hint 已删除 (文案搬到 .or-row).
     已登录态 .hint 段保留 (含 logout-link), CSS 不动. */
  .hint {
    margin-top: 1.25rem;
    font-size: 0.8125rem;
    color: rgba(255, 255, 255, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  /* v0.3.21 #102 (PO msg 14:53): landing 已登录态 退出登录 超链接 — 跟主按钮同透明玻璃 ivory. */
  .logout-link {
    background: rgba(255, 255, 255, 0.20);
    border: 1px solid rgba(255, 255, 255, 0.45);
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    color: #FFFFF0;
    font-size: 0.8125rem;
    font-weight: 500;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    cursor: pointer;
    transition: background 0.18s, transform 0.1s;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  }
  .logout-link:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.30);
    border-color: rgba(255, 255, 255, 0.55);
    transform: translateY(-1px);
  }
  .logout-link:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>