<!--
  InviteLinkButton.svelte

  v0.1.2 反馈修 6 + v0.2.1 UI rev — 邀请按钮 stopPropagation (避免触发 members header 折叠).

  v0.3.15 (PO #4807 + Designer 报告) — 清理死代码:
  - 删 `let error: string | null = null` (声明后从未赋值)
  - 删 `<div class="error">{error}</div>` 模板 (永远不显示)

  v0.3.22 #122 (PO msg 15:38 #8025) — 按钮文案 "邀请" → "账本链接/邀请".

  v0.3.23 #129 (PO msg 16:35 UAT 新批) — 删 btn-icon (emoji 视觉不一致).

  v0.3.24 #14 (PO msg 16:35 UAT #14) — 成功反馈 toast 改 confirm modal:
  - 用户复制成功后, 弹 confirm modal 而不是 auto-dismiss toast
  - 文案 (两段, 中间换行, v0.3.24 #14.1 PO msg #8285 反馈调整):
      已复制此账本链接,请妥善保管!
      可用于 回到此账本(粗体) 或 邀请他人(粗体)
  - "知道了" 按钮 → manual dismiss (state modalOpen = false)
  - 点击 backdrop / 按 Esc 也关闭 (一致 UX)
  - 复制失败仍走 toast.error 兜底 (保留错误反馈)
  - z-index 1000 (在 Toast 9999 之下, 在普通 modal 999 之上)
  - 半透明黑 backdrop (rgba 0,0,0,0.10 + blur 4px) + 玻璃 modal (圆角 18px, 白底 + backdrop-filter, padding 24px)

  v0.3.31 #2 (UAT 0725-2 #2, PO msg ~20:03 字面 "匿名用户创建账本,首次进入账单页时,邀请链接按钮高亮呼吸"):
  - 加 `breathing: boolean = false` prop
  - breathing=true 时按钮加 `.invite-btn-breathing` class (CSS keyframes 1.5s ease-in-out infinite,
    box-shadow 16→24px indigo + scale 1↔1.02; keyframes @keyframes invite-breath 在 frontend/src/app.css)
  - 触发条件: 由 /sessions/[id]/+page.svelte 在 isAnonOwner && sessionStorage 首次访问 设 true
  - 文案 pill (.expiry-anon-a 红色 pill) 在 page-level 渲染, InviteLinkButton 不参与
-->
<script lang="ts">
  import { toast } from '$stores/toast';

  export let sessionId: number;
  /** v0.3.1: unguessable public code from sessions.session_code. */
  export let sessionCode: string = '';
  /** True if the caller is the session owner (保留 prop,后续 v0.2 rotate 功能回归使用)。 */
  export const isOwner: boolean = false;
  /** v0.3.31 #2 (UAT 0725-2 #2): 匿名 owner 首次进入账单页时由 parent 设 true,
   *  按钮加 .invite-btn-breathing class 触发 CSS keyframes @keyframes invite-breath
   *  (1.5s ease-in-out infinite, 紫光晕 16→24px + scale 1↔1.02).
   *  默认 false, 不触发.  触发后立即写 sessionStorage 避免刷新重触. */
  export let breathing: boolean = false;
  /* v0.3.18 #66 (PO #6899 Mockup A): 过期提示已移到 page-level .expiry-inline-a (amber pill),
     ownerEmail / inviteExpiresAt / formatExpiresDate / expiresDate 全部不再需要,
     删除以避免 svelte-check unused export warning. */

  let copied = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  /** v0.3.24 #14: 复制成功后弹 confirm modal — manual dismiss by user. */
  let modalOpen = false;

  /** v0.3.1: copy the SESSION URL (not the invite URL).
   * Per PO 16:55, the "invite link" that gets copied should just be the
   * session page URL — the invite token is internal and not surfaced. */
  $: inviteUrl =
    typeof window !== 'undefined'
      ? sessionCode
        ? window.location.origin + '/s/' + sessionCode
        : window.location.origin + '/sessions/' + sessionId
      : '';

  /** v0.3.24 #14: extract copy logic for readability (原内联在 handleInviteClick). */
  async function copyToClipboard(url: string): Promise<boolean> {
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // Fallback: 隐藏 input + execCommand('copy')
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  /** v0.3.1: copy SESSION URL directly (no lazy load needed — no
   *  API call, no expiry display). Just copy `${origin}/sessions/${id}`. */
  async function handleInviteClick() {
    const url = inviteUrl;
    if (!url) return;

    const ok = await copyToClipboard(url);

    if (ok) {
      // v0.3.24 #14: 成功 → 弹 confirm modal 而非 toast (PO UAT 字面要求)
      modalOpen = true;
    } else {
      // 失败仍走 toast.error 兜底 (复制失败用户需要看到, 修以重试)
      toast.error('复制失败,请手动选中链接');
    }

    // v0.3.1 (PO Bug #4): show "已复制" for 10s then reset to "邀请".
    // Only 2 states: 邀请 / 已复制. No busy / loading state.
    copied = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied = false;
      resetTimer = null;
    }, 10000);
  }

  /** v0.3.24 #14: manual close (知道了 / Esc / backdrop click). */
  function closeModal() {
    modalOpen = false;
  }

  /** v0.3.24 #14: Esc 关闭 modal (跟全站 modal 键盘 UX 一致 — CurrencyAddModal 同款). */
  function handleKeydown(e: KeyboardEvent) {
    if (modalOpen && e.key === 'Escape') closeModal();
  }

  /** v0.3.24 #14: 点击 backdrop 关闭 modal (modal 内点击不冒泡). */
  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) closeModal();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="invite-row">
  <!-- PO 反馈修 6 项目 1: 点击立即复制 + 显示确认反馈。 -->
  <button
    type="button"
    class="glass-pill invite-btn"
    class:copied
    class:invite-btn-breathing={breathing}
    onclick={(e) => { e.stopPropagation(); handleInviteClick(); }}
    title="复制邀请链接"
    aria-label="复制邀请链接"
    data-testid="invite-btn"
  >
    <span class="btn-content">
      <span class="btn-label">{copied ? '已复制' : '账本链接/邀请'}</span>
    </span>
  </button>
  <!-- v0.3.18 #66 (PO #6899 Mockup A): anon 账本过期提示**移到 section header** (amber pill).
       不再挂在 invite 按钮下方, 由 /sessions/[id]/+page.svelte 的 .expiry-inline-a 渲染。
       保留 ownerEmail / inviteExpiresAt / formatExpiresDate / expiresDate 派生以备未来回归。 -->
</div>

<!-- v0.3.24 #14: 复制成功弹出 confirm modal (manual dismiss).
     文案两段中间 <br /> 换行 (PO 字面要求); "知道了" 按钮 manual close. -->
{#if modalOpen}
  <div
    class="invite-sheet-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
  >
    <div
      class="invite-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="账本链接已复制"
      data-testid="invite-confirm-modal"
    >
      <p class="invite-modal-msg" data-testid="invite-confirm-msg">
        已复制此账本链接,请妥善保管!<br />
        可用于 <strong class="emphasize">回到此账本</strong> 或 <strong class="emphasize">邀请他人</strong>。
      </p>
      <div class="invite-modal-foot">
        <button
          type="button"
          class="invite-modal-btn"
          onclick={closeModal}
          data-testid="invite-confirm-btn"
        >
          知道了
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .invite-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-end;
  }
  /* v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 —
     bg/border/box-shadow 由 .glass-pill 提供, 这里只保留布局与 copied 反馈。 */
  .invite-btn {
    /* 玻璃化在 .glass-pill 类里, 这里不重复定义 bg/border/box-shadow。
       只保留 copied 状态的视觉反馈 (绿色) + transition (匹配 pill 的 150ms)。 */
    transition: transform 150ms ease, background 150ms ease, box-shadow 150ms ease, color 150ms ease;
  }
  .invite-btn:active {
    transform: scale(0.97);
  }
  /* copied 状态: 玻璃底色 + 绿色文字 + 绿色光晕, 保持玻璃质感 */
  .invite-btn.copied {
    background: linear-gradient(
      135deg,
      rgba(16, 185, 129, 0.18) 0%,
      rgba(16, 185, 129, 0.12) 100%
    );
    border-color: rgba(16, 185, 129, 0.30);
    color: var(--color-success, #047857);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.6),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      0 1px 4px rgba(16, 185, 129, 0.14);
  }
  .invite-btn.copied:hover {
    background: linear-gradient(
      135deg,
      rgba(16, 185, 129, 0.26) 0%,
      rgba(16, 185, 129, 0.20) 100%
    );
  }
  .btn-content {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
  }
  /* 移动端 375px: 极致紧凑,文字同行,不挤压 */
  @media (max-width: 380px) {
    .invite-btn {
      padding: var(--space-2) var(--space-3);
      min-height: 36px;
    }
    .btn-label {
      font-size: var(--font-size-sm);
    }
  }

  /* v0.3.18 #66: removed .hint — 过期提示移到 page-level .expiry-inline-a (amber pill).
     保留此处注释占位避免未来误回退。 */

  /* ============================================================
   * v0.3.24 #14 (PO msg 16:35 UAT) — confirm modal (替换 toast)
   * ============================================================ */
  /* v0.3.29 (UAT 0725-1 #2, PO msg 12:43): 跟 CurrencyAddModal .modal-backdrop 完全一致.
     PO 字面 "同汇率设置一样". 之前 v0.3.28 #8 re-fix 把 invite backdrop 升级到
     blur(24px) saturate(200%) + bg 0.45, 跟 CurrencyAddModal 不一致. PO 反馈
     两者看起来不同. 修法: 改回 CurrencyAddModal 同款 token — bg rgba(0,0,0,0.30)
     + blur(16px) saturate(180%) + z-index 999. 同步更新 fallback bg 0.48→0.30
     跟 bg 主值一致 (Safari iOS < 18). 两个弹窗现在视觉完全统一 (跨组件但
     token 同源, 跟 v0.3.27 #9 commit 80abeda 原始统一设计一致). */
  /* v0.3.34 #1 (UAT 0725-1 #2, PO 字面 "同汇率设置一样"): 升级 invite 弹窗 backdrop 强度.
     之前 v0.3.29 (a14820c) 改回跟 CurrencyAddModal 同款 (blur 16px / saturate 180% / bg 0.30),
     但 PO 真机验证测试不通过. 实际 CurrencyAddModal 跟 invite backdrop 不一致:
     - CurrencyAddModal: blur(24px) saturate(200%) bg rgba(0,0,0,0.45)
     - invite (旧): blur(16px) saturate(180%) bg rgba(0,0,0,0.30)
     修法: invite 升级到 CurrencyAddModal 同款 token — blur(24px) saturate(200%) bg rgba(0,0,0,0.45).
     两个弹窗现在真的一致 (跨组件 token 完全同源, 含 z-index 999, position fixed, inset 0).
     v0.3.35 #5 (UAT 0725-3 #11, PO 字面 "样式要与 添加已结算记录的弹窗一致"): 形态从 centered modal
     改 bottom sheet (跟 AddSettlementSheet 同款). 保留 v0.3.34 #1 backdrop blur 强度 (24/200%/0.45)
     — 比 AddSettlementSheet (4/0.40) 更暗一档, 视觉上还跟 centered modal 一样. z-index 999 跟
     CurrencyAddModal .sheet-backdrop 同一层 (Toast 9999 之下, 普通 modal 999 之上). */
  .invite-sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(24px) saturate(200%);
    -webkit-backdrop-filter: blur(24px) saturate(200%);
    z-index: 999;
    animation: backdropFadeIn 200ms ease-out;
  }
  /* v0.3.35 #5: 形态从 centered modal 改 bottom sheet (跟 AddSettlementSheet 同款).
     圆角只在顶部 24px, 底部贴屏 max-width 480px, slide-up 280ms cubic-bezier 动效. */
  .invite-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0 auto;
    max-width: 480px;
    max-height: 92vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: saturate(220%) blur(28px);
    -webkit-backdrop-filter: saturate(220%) blur(28px);
    border-top-left-radius: 24px;
    border-top-right-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-bottom: 0;
    padding: 8px 16px 0;
    box-shadow:
      0 -8px 32px rgba(15, 23, 42, 0.12),
      inset 0 1px 0 rgba(255, 255, 255, 0.85);
    z-index: 1000;
    animation: inviteSheetUp 280ms cubic-bezier(0.32, 0.72, 0, 1);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  @keyframes inviteSheetUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  @supports not (backdrop-filter: blur(1px)) {
    .invite-sheet {
      background: rgba(255, 255, 255, 0.96);
    }
    .invite-sheet-backdrop {
      /* v0.3.29 (UAT 0725-1 #2): 跟 CurrencyAddModal .modal-backdrop fallback 一致 (0.30)
         (Safari iOS < 18 无 backdrop-filter, fallback bg = 主值 bg, 让两个弹窗 fallback
         状态也完全相同, 不需要 0.48 让 invite backdrop 更浓液). */
      background: rgba(0, 0, 0, 0.30);
    }
  }
  .invite-modal-msg {
    /* PO 字面: 字号 15-16px + 行高舒适 */
    margin: 0;
    font-size: 15px;
    line-height: 1.7;
    color: var(--gray-800, #1f2937);
    text-align: center;
    font-weight: var(--font-weight-medium, 500);
    /* 中文段落视觉: 两个<br /> 对应两段,中间空隙自然, 不需要额外 margin */
  }
  /* v0.3.24 #14.1 (PO msg #8285 反馈): "回到此账本" / "邀请他人" 强调粗体 */
  .invite-modal-msg strong.emphasize {
    font-weight: var(--font-weight-semibold, 600);
    color: var(--gray-900, #111827);
  }
  .invite-modal-foot {
    display: flex;
    justify-content: center;
  }
  /* "知道了" 主按钮 — 跟 CurrencyAddModal .fab--submit (indigo→blue gradient) 同源 token */
  .invite-modal-btn {
    appearance: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 15px;
    font-weight: var(--font-weight-semibold, 600);
    color: #fff;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.95) 0%, rgba(59, 130, 246, 0.95) 100%);
    border: 1px solid rgba(99, 102, 241, 0.40);
    border-radius: 12px;
    padding: 10px 36px;
    min-width: 100px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 4px 12px rgba(99, 102, 241, 0.28);
    transition:
      background 150ms ease,
      transform 100ms ease,
      box-shadow 150ms ease;
  }
  .invite-modal-btn:hover {
    background: linear-gradient(135deg, rgba(99, 102, 241, 1) 0%, rgba(59, 130, 246, 1) 100%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 6px 16px rgba(99, 102, 241, 0.36);
  }
  .invite-modal-btn:active {
    transform: scale(0.97);
  }
  .invite-modal-btn:focus-visible {
    outline: 2px solid var(--accent-500, #6366f1);
    outline-offset: 2px;
  }

  @keyframes backdropFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes modalSlideUp {
    from { opacity: 0; transform: translateY(8px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  /* 移动端 375px: 紧凑 padding + 字号不变 (PO 字面要求 24px padding) */
  @media (max-width: 380px) {
    .invite-modal {
      max-width: calc(100vw - 32px);
      padding: 20px;
      border-radius: 16px;
    }
  }
</style>
