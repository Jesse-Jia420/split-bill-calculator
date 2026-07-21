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
  // v0.3.17 #36fix2 (PO msg 12:57): join page (/sessions/<id>/join) 流程本身
  // 支持 anon 加入 (「新建昵称以加入账本」), 不需要 "先登录再保存" 按钮.
  // 上面 inSession() 的 regex 命中 /sessions/123/join 因为 /sessions/123 后
  // 是 /, 之前会错误渲染 "登录以保存". 用 isJoinPage() 排除这一支.
  function isJoinPage(): boolean {
    return /^\/sessions\/\d+\/join/.test(page.url.pathname);
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
  <a href="/" class="brand">SplitIt</a>
  {#if !['/auth/login', '/sessions/new'].includes(page.url.pathname) && $user}
    <nav class="links">
      <!-- v0.3.17 #30: 「我的账本」class 改为 btn-sm links-item, 跟「注销登录」
           共用 .btn-sm 玻璃参数 (PO msg 14:28)。视觉同族 (同色 + 同描边 + 同 hover)。
           原 .glass-pill 蓝紫淡玻璃 ≠ 注销登录 .ghost 白玻璃, 两个按钮看着不属于
           一个组件。统一用 .btn-sm 后, 整组 nav 视觉一致。.links-item 保留以维持
           nav link 的语义定位 (flex 布局项), 但视觉参数全部继承 .btn-sm。 -->
      <a href="/sessions" class="btn-sm links-item">我的账本</a>
    </nav>
  {/if}
  {#if page.url.pathname !== '/auth/login'}
    <div class="right">
      {#if $user}
        <span class="email" title="{$user.email}">{$user.default_name}</span>
        <button class="ghost btn-sm" on:click={handleLogout}>注销登录</button>
      {:else if inSession() && !isJoinPage()}
        <a
          href={`/auth/login?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`}
          class="btn-sm"
        >
          登录以保存
        </a>
      {:else if !inSession()}
        <a href="/auth/login" class="btn-sm">登录</a>
      {/if}
    </div>
  {/if}
</header>

<style>
  /* v0.3.20 #99-fix4 (PO msg 14:26 #7585): NavBar 升 fixed 让 backdrop-filter
     真正接住下方滚动内容 — 原版 position:relative 时, main 内容在 navbar 下方
     flex row, 滚动时根本不会到 navbar 区域, backdrop-filter 没东西模糊.
     fixed + z-index:100 让 navbar 浮在 main 之上面, 当用户滚动账单, 内容会
     滚到 navbar 区域下方被 saturate(130%) blur(20px) + alpha 0.05 white bg 柔和
     模糊透出来 — PO 原意图 (bar 不抢戏 + 背景图案部分漏出). */
  :global(:root) {
    /* 暴露给 +layout.svelte main.page padding-top 用, 跟 navbar 内容高度同步 */
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
    /* v0.3.17 #30 (PO msg 14:28): 加 env(safe-area-inset-top) — iOS 全面屏
       刘海/灵动岛区域不挡 brand 文字。body 已 lock 外层滚 (见 app.css),
       v0.3.20 #99-fix4 (PO msg 14:26 #7585): 升 fixed (从 flex layout 第一项 → 浮在所有
       内容之上 z-index 100). main.page 加 padding-top 让内容起步于 navbar 之下,
       滚动后内容从下方滚到 navbar 区域被 saturate(130%) blur(20px) + 0.05 white
       模糊透出来 — PO 原意图 (bar 不抢戏 + 背景内容部分漏出). */
    padding: calc(var(--space-3) + env(safe-area-inset-top, 0px)) var(--space-4) var(--space-3);
    /* v0.3.20 #99 (PO msg 13:36 #7532 第 4 项, msg 13:39 #7536 缩范围:
       只做 header, footer 不管): NavBar 半透明玻璃化.
       v0.3.20 #99-fix (PO msg 13:54 反馈): 透明玻璃 — 原版加 indigo→blue 渐变
       把 paper 纹理盖死了, 跟"原就是为了让背景图案部分漏出来"的诉求反.
       改 transparent white alpha + 降 saturate 让 paper 纹部分透过来.
       - bg: rgba(255,255,255,0.55) (白色 alpha, 无彩色)
       - backdrop-filter: saturate(130%) blur(20px) (blur 让纸纹糊但仍可见, saturate
         不加太高免纸纹失真)
       - inset highlight top 1px rgba(255,255,255,0.4) 玻璃上沿
       - inset highlight bottom 1px rgba(0,0,0,0.04) 玻璃下沿
       - border-bottom 1px rgba(255,255,255,0.2) 玻璃跟 paper bg 的柔和分割
       - Safari iOS < 18 fallback @supports: 0.85 opaque white (纸纹 fallback 不可见,
         但保证 navbar 文字仍可读) */
    /* v0.3.20 #99-fix (PO msg 13:54): 透明玻璃 — 不再加颜色 (前版 indigo→blue 渐变
       把 paper 纹盖死). 改用纯白 alpha + blur 让 paper 纹部分透过来.
       saturate 从 180% → 130% 让纸纹不过饱和失真. */
    /* v0.3.20 #99-fix2 (PO msg 13:56 #7549 再透一点 + 13:57 #7563 让背景漏出来): 0.55 -> 0.20 */
    /* v0.3.20 #99-fix3 (PO msg 14:07 #7571 不行透明度再提高): alpha 0.20 -> 0.05 (几乎全透, paper bg 100% 漏过来) */
    /* v0.3.20 #99-fix5 (PO msg 14:29 #7602): alpha 0.05 -> 0.02 (PO 让透明度再降, 几乎纯透明只靠 backdrop-filter blur 撑玻璃感) */
    background: rgba(255, 255, 255, 0.02);
    backdrop-filter: saturate(130%) blur(20px);
    -webkit-backdrop-filter: saturate(130%) blur(20px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.2);
    flex-wrap: wrap;
  }
  .brand {
    font-weight: 600;
    font-size: var(--font-size-lg);
    color: var(--color-text);
    text-decoration: none;
  }
  /* v0.3.20 #100 (PO msg 14:37): hover 象牙白替代蓝色. 象牙白 #FFFFF0 在白纸上 = 低对比 = logo hover 时视觉 'fade' — PO 原话 "象牙白色，不要现在的蓝色". */
  .brand:hover { color: #FFFFF0; }
  .links { flex: 1; display: flex; gap: var(--space-3); }
  /* v0.3.17 #30 (PO msg 14:28): 删 .links a 独立样式 — 之前给 <a class="glass-pill">
     提供 fallback layout, 现在「我的账本」已经升级为 .btn-sm, 自己的 display /
     min-height / align-items / color 全由 .btn-sm 提供。
     保留 .links a 选择器为空规则会触发 svelte-check unused-selector 警告,
     干脆整块删掉。 */
  .links a { display: inline-flex; align-items: center; } /* 仅保留 layout 兜底 */
  .right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto; /* v0.3.17 #28.5 #8: .links 隐藏时 (例如 /sessions/new wizard) 也贴右 */
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
  /* v0.3.18 #49 (PO msg 21:16 #6508 极透明化 sweep):
     bg 0.06/0.04 → 0.04/0.02 (再 × 0.67 透明, 整站 btn-sm 几乎全透).
     border 0.20 → 0.25 (边缘补偿). inset highlight 0.7 → 0.95 (玻璃上沿加强).
     外阴影 indigo 0.10 → 0.16 (玻璃感更强). */
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
    /* v0.3.18 #49: hover 0.12/0.09 → 0.08/0.06 (跟 base 0.04/0.02 同比例降级, hover 仍略亮) */
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
    /* v0.3.18 #49: fallback 0.12 → 0.08 (跟新 base 0.04/0.02 同比例降级) */
    .btn-sm { background: rgba(99, 102, 241, 0.08); }
  }
  /* .ghost: 注销按钮 — 更弱化 (白玻璃非蓝玻璃)
     v0.3.18 #49: bg 0.35/0.20 → 0.20/0.10 (跟 .btn-sm 同比例降级). border 0.15 → 0.20. */
  .ghost {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.20) 0%,
      rgba(255, 255, 255, 0.10) 100%
    );
    border-color: rgba(99, 102, 241, 0.20);
    color: var(--gray-700);
  }
  /* v0.3.18 #48: hover 0.85/0.65 → 0.50/0.35 (跟新 base 同比例降级) */
  .ghost:hover {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.50) 0%,
      rgba(255, 255, 255, 0.35) 100%
    );
    color: var(--accent-700);
  }
  /* v0.3.18 #48: Safari iOS < 18 backdrop-filter fallback.
     v0.3.20 #99: fallback 用更 opaque white (0.85) 替代前版 indigo 渐变 — 跟新
     transparent glass bg 一致, 失去 blur 但仍提供文字可读性.
     v0.3.20 #99-fix: 同步去 indigo 色. */
  @supports not (backdrop-filter: blur(1px)) {
    .navbar {
      background: rgba(255, 255, 255, 0.85);
    }
    .ghost { background: rgba(255, 255, 255, 0.55); }
  }
</style>