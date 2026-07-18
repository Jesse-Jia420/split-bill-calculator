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
  <a href="/" class="brand">Split Bill</a>
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
  .navbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    /* v0.3.17 #30 (PO msg 14:28): 加 env(safe-area-inset-top) — iOS 全面屏
       刘海/灵动岛区域不挡 brand 文字。body 已 lock 外层滚 (见 app.css),
       .navbar 是 body flex column 第一项, 始终贴顶。 */
    padding: calc(var(--space-3) + env(safe-area-inset-top, 0px)) var(--space-4) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    /* v0.3.18 #48 (PO msg 19:10 #6489 全站透明化 sweep): nav bg 从实色 surface
       改为半透明白玻璃, 让 peach→rose→lavender 背景图透出, 玻璃感统一.
       bg rgba(255,255,255,0.40) + backdrop-filter blur 18px (玻璃语言保留). */
    background: rgba(255, 255, 255, 0.40);
    backdrop-filter: saturate(180%) blur(18px);
    -webkit-backdrop-filter: saturate(180%) blur(18px);
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
  /* v0.3.18 #48 (PO msg 19:10 #6489 全站透明化 sweep):
     indigo 玻璃 bg 0.10/0.08 → 0.06/0.04 (× 0.6 透明度降级, 让背景图透过来).
     border 0.15 → 0.20 (边缘补偿). inset highlight 0.6 → 0.7 (玻璃上沿加强).
     外阴影 indigo 0.06 → 0.10 (跟全站玻璃同源). */
  .btn-sm {
    min-height: var(--touch-target);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-full, 999px);
    border: 1px solid rgba(99, 102, 241, 0.20);
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.06) 0%,
      rgba(59, 130, 246, 0.04) 100%
    );
    backdrop-filter: saturate(180%) blur(16px);
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 3px rgba(99, 102, 241, 0.10);
    display: inline-flex;
    align-items: center;
    font-size: var(--font-size-sm);
    color: var(--accent-700, #4338ca);
    cursor: pointer;
    text-decoration: none;
    transition: transform 150ms ease, background 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  }
  .btn-sm:hover {
    /* v0.3.18 #48: hover 0.18/0.15 → 0.12/0.09 (跟新 base 同比例降级, hover 仍比 base 略亮) */
    background: linear-gradient(
      135deg,
      rgba(99, 102, 241, 0.12) 0%,
      rgba(59, 130, 246, 0.09) 100%
    );
    border-color: rgba(99, 102, 241, 0.28);
    color: var(--accent-800, #3730a3);
    transform: translateY(-1px);
    text-decoration: none;
  }
  .btn-sm:active { transform: scale(0.97); }
  @supports not (backdrop-filter: blur(1px)) {
    /* v0.3.18 #48: fallback 0.18 → 0.12 (跟新 base 同比例降级) */
    .btn-sm { background: rgba(99, 102, 241, 0.12); }
  }
  /* .ghost: 注销按钮 — 更弱化 (白玻璃非蓝玻璃)
     v0.3.18 #48: bg 0.65/0.45 → 0.35/0.20 (× 0.5 透明度降级, 跟 .btn-sm 同源). */
  .ghost {
    background: linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.35) 0%,
      rgba(255, 255, 255, 0.20) 100%
    );
    border-color: rgba(99, 102, 241, 0.15);
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
     .navbar 0.40 → 0.70 (跟新 bg 比例 +0.30 opaque 补足 fallback 可读性).
     .ghost 0.35/0.20 → 0.55/0.40 (同源). */
  @supports not (backdrop-filter: blur(1px)) {
    .navbar { background: rgba(255, 255, 255, 0.70); }
    .ghost { background: rgba(255, 255, 255, 0.55); }
  }
</style>