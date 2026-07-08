<!--
  v0.3.x (PRD §3.11.3) — 详情页「登录以保存」按钮 slot。

  Why a dedicated component:
    - PRD §3.11.3 拍板: 复用"详情页原本的登录按钮 slot" — 这是一
      个页面级 CTA,**不**只是条件替换文案。
    - 渲染条件: 用户**未登录** (NavBar 显示「登录」时, 详情页自身
      也需要这个 CTA; 反之 NavBar 显示「退出」时此 slot 隐藏)。
    - 文案变化:
        owner_user_id === null → "🔐 登录以保存" + returnTo 含 ?claim=1
        owner_user_id != null → "登录" (普通登录, 不带 claim query)
    - 样式: 复用 sessions/[id] 详情页里 `.btn ghost .btn-sm` 的同款
      class, 不改 NavBar 默认登录按钮的 CSS 视觉。
    - 跳转后链路: /auth/login?returnTo=... → 用户走 verify-code → 落地
      /sessions/{id}?claim=1 → 详情页 onMount 检测 query 调
      POST /sessions/{id}/claim。

  关键 encode 决策:
    returnTo **必须**整体 encodeURIComponent,这样 `<href encoded>` 里
    的 `?` 和 `=` 转成 %3F / %3D. 浏览器解析 /auth/login URL 时只把
    "returnTo" 当一个 query key,decode 后是完整 path 含 ?claim=1.
    login verify 成功后 goto(returnTo) → 直接跳到 /sessions/{id}?claim=1,
    详情页 onMount 看到 ?claim=1 触发 claim 流程。

    ❌ 反模式: 直接拼 '/auth/login?returnTo=/sessions/{id}&claim=1' 会
    被浏览器拆成 returnTo=/sessions/{id} + 顶层 claim=1,login 跳回时
    只 goto /sessions/{id},详情页永远看不到 ?claim=1.
-->
<script lang="ts">
  export let sessionId: number;
  /** True when this session has no owner (PRD §3.11.3: 只有未认领的
   * session 显示「登录以保存」; 已认领 session 仅显示普通「登录」)。*/
  export let ownerUserId: number | null;

  /**
   * Build href with proper URI encoding.
   *
   * For owner-not-claimed: /auth/login?returnTo=%2Fsessions%2F{id}%3Fclaim%3D1
   * For owner-claimed:     /auth/login?returnTo=%2Fsessions%2F{id}
   */
  $: returnTo =
    ownerUserId === null
      ? '/sessions/' + sessionId + '?claim=1'
      : '/sessions/' + sessionId;
  $: href = '/auth/login?returnTo=' + encodeURIComponent(returnTo);
  $: label = ownerUserId === null ? '🔐 登录以保存' : '登录';
</script>

<a
  class="btn ghost btn-sm claim-login-cta"
  {href}
  aria-label={label}
  data-testid={ownerUserId === null ? 'claim-login-cta' : 'plain-login-cta'}
>
  {label}
</a>

<style>
  /* 仅占位以保证 scope 样式生效; 不改全局 .btn.ghost.btn-sm 默认样式。*/
  .claim-login-cta {
    /* No custom CSS — reuses global .btn.ghost.btn-sm visual exactly.
       Component stays presentational; layout / typography are inherited
       from the global button system that NavBar + session-header-actions
       both rely on. */
  }
</style>
