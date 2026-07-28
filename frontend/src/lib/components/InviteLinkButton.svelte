<!--
  InviteLinkButton.svelte

  v0.1.2 反馈修 6 + v0.2.1 UI rev — 邀请按钮 stopPropagation (避免触发 members header 折叠).

  v0.3.15 (PO #4807 + Designer 报告) — 清理死代码:
  - 删 `let error: string | null = null` (声明后从未赋值)
  - 删 `<div class="error">{error}</div>` 模板 (永远不显示)

  v0.3.22 #122 (PO msg 15:38 #8025) — 按钮文案 "邀请" → "账本链接/邀请".

  v0.3.23 #129 (PO msg 16:35 UAT 新批) — 删 btn-icon (emoji 视觉不一致).

  v0.3.24 #14 (PO msg 16:35 UAT #14) — 成功反馈 toast 改 confirm modal.

  v0.3.31 #2 (UAT 0725-2 #2) — breathing 匿名 owner 首次进入触发高亮呼吸.

  v0.3.36 #5 (UAT 0728-1 #5, PO 字面 "邀请链接复制弹窗中的文字字号要适当增大, 你可以请 design agent 重新设计一下这里")
    — 弹窗成功态改 success-card 形态 (PO 拍 mockup 3) + QR code 自动生成:
    * 顶部 64×64 绿色玻璃 ✓ icon (linear-gradient emerald 0.20→0.14 + 4-layer glass shadow)
    * 主标题 "账本链接已复制" 17px (lg, font-weight 600, letter-spacing -0.01em)
    * 副标题 15px (base) 一行, 关键动词加粗
    * URL preview chip (subtle indigo 玻璃: bg rgba(99,102,241,0.06) + border 1px dashed indigo 0.30)
    * "可用于 回到此账本 / 邀请他人" 用两列微型 chip 而非长句, 视觉更清晰
    * QR code (~200×200, 居中, white padding 12px + border-radius 12px + bg 白色) — 用 npm `qrcode`
      库 `toDataURL(text)` 生成, 嵌在 sub 跟 url-chip 中间. 反 #121 自决选 lib (qrcode vs qrcode-generator)
      选 qrcode — 稳定, canvas 输出, TS 支持, 比 qrcode-generator 大但 QR 视觉稳定性更好.
    * "知道了" 按钮 → manual dismiss (跟 AddSettlementSheet cta-row btn-primary 同款)
    * 弹窗关闭行为不变 (跟 v0.3.36 #16 + 之前的 auto-close 行为一致 — Esc / backdrop click / 知道了 全 OK)
    * URL chip click → 重新复制 invite URL (二次复制便利, e.g. user 第一次没保存)

  注: 跟 v0.3.36 #6 + #17 兼容 — 保留 currentColor XIcon (防 anti-aliasing 隐形) + CurrencyAddModal 同款 backdrop token.
-->
<script lang="ts">
  import { X as XIcon } from 'lucide-svelte';
  import QRCode from 'qrcode';
  import { toast } from '$stores/toast';
  import { portal } from '$lib/actions/portal';
  import { createEventDispatcher } from 'svelte';

  /** v0.3.36 #16: dispatch 'copy' on successful clipboard write, 'open' on modal opens. */
  const dispatch = createEventDispatcher<{ copy: void; open: void }>();

  export let sessionId: number;
  /** v0.3.1: unguessable public code from sessions.session_code. */
  export let sessionCode: string = '';
  /** True if the caller is the session owner (保留 prop,后续 v0.2 rotate 功能回归使用)。 */
  export const isOwner: boolean = false;
  /** v0.3.31 #2: anon owner 首次进入账本页时由 parent 设 true, 触发 CSS keyframes. */
  export let breathing: boolean = false;
  /* v0.3.18 #66 (PO #6899 Mockup A): 过期提示已移到 page-level .expiry-inline-a (amber pill),
     ownerEmail / inviteExpiresAt / formatExpiresDate / expiresDate 全部不再需要,
     删除以避免 svelte-check unused export warning. */

  let copied = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  /** v0.3.24 #14: 复制成功后弹 confirm modal — manual dismiss by user. */
  let modalOpen = false;
  /** v0.3.36 #5: QR code data URL (从 inviteUrl 生成, modal open 时 lazy compute). */
  let qrDataUrl: string = '';
  /** v0.3.36 #5: QR generate loading/error 状态 (rare failure fallback). */
  let qrError: string | null = null;

  /** v0.3.1: copy the SESSION URL (not the invite URL). */
  $: inviteUrl =
    typeof window !== 'undefined'
      ? sessionCode
        ? window.location.origin + '/s/' + sessionCode
        : window.location.origin + '/sessions/' + sessionId
      : '';

  /** v0.3.36 #5: modal open + inviteUrl 变化时 lazy generate QR. */
  $: if (modalOpen && inviteUrl) {
    generateQr(inviteUrl);
  }

  /** v0.3.36 #5: QR 生成 — qrcode.toDataURL (canvas → base64 PNG), 200×200 + white padding 让边界清晰. */
  async function generateQr(text: string) {
    qrError = null;
    try {
      qrDataUrl = await QRCode.toDataURL(text, {
        errorCorrectionLevel: 'M', // Medium ~15% 容错 (URL 长度 < 200 char 完全够)
        margin: 2, // qrcode lib margin 是 module count, 2 = 留白 ~ 4 modules (12-14px 视觉清晰)
        width: 240, // 240 = 200 logical * 1.2 (retina clarity, 实际 CSS 显示 200×200)
        color: {
          dark: '#0f172a', // slate-900, 跟设计 token 同源
          light: '#ffffff', // 白底, 跟 mockup 一致
        },
      });
    } catch (e: any) {
      console.error('[InviteLinkButton] QR generate failed:', e);
      qrError = e?.message ?? 'QR 码生成失败';
      qrDataUrl = '';
    }
  }

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

  async function handleInviteClick() {
    const url = inviteUrl;
    if (!url) return;

    const ok = await copyToClipboard(url);

    if (ok) {
      // v0.3.24 #14: 成功 → 弹 confirm modal 而非 toast
      modalOpen = true;
      // v0.3.36 #16: dispatch copy + open events for parent
      dispatch('copy');
      dispatch('open');
    } else {
      // 失败仍走 toast.error 兜底
      toast.error('复制失败,请手动选中链接');
    }

    // v0.3.1 (PO Bug #4): show "已复制" for 10s then reset to "邀请".
    copied = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied = false;
      resetTimer = null;
    }, 10000);
  }

  /** v0.3.36 #5: URL chip click → 重新复制 invite URL (二次复制便利, 跟初始复制同 source). */
  async function handleUrlChipClick(e: MouseEvent) {
    e.stopPropagation();
    if (!inviteUrl) return;
    const ok = await copyToClipboard(inviteUrl);
    if (ok) {
      toast.success('已重新复制链接');
      dispatch('copy');
    } else {
      toast.error('复制失败,请手动选中链接');
    }
  }

  /** v0.3.24 #14: manual close (知道了 / Esc / backdrop click). */
  function closeModal() {
    modalOpen = false;
  }

  /** v0.3.24 #14: Esc 关闭 modal. */
  function handleKeydown(e: KeyboardEvent) {
    if (modalOpen && e.key === 'Escape') closeModal();
  }

  /** v0.3.24 #14: 点击 backdrop 关闭 modal (modal 内点击不冒泡). */
  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) closeModal();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="invite-row">
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
</div>

<!-- v0.3.24 #14: 复制成功弹出 confirm modal (manual dismiss).
     v0.3.27 #3 (PO msg 9234 真机截图质问): wrap modal markup 在 `<div use:portal>` host 里.
     v0.3.36 #5 (UAT 0728-1 #5): 弹窗成功态改 success-card 形态 (mockup 3) — check-hero + 标题 + sub + QR + url-chip + use-row + cta-row.
     内部结构 100% 跟 AddSettlementSheet bottom sheet 同源 (backdrop / sheet-handle / sheet-head / sheet-close / sheet-body / sheet-foot + cta-row + btn-primary). -->
<div use:portal data-testid="invite-modal-host">
{#if modalOpen}
  <div
    class="invite-sheet-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
  ></div>
  <div
    class="invite-sheet"
    role="dialog"
    aria-modal="true"
    aria-label="账本链接已复制"
    data-testid="invite-confirm-modal"
  >
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-head">
      <span class="sheet-title">账本链接</span>
      <button class="sheet-close" type="button" aria-label="关闭" onclick={closeModal}>
        <!-- v0.3.36 #6 — UAT 0728-1 #6: XIcon 加显式 color="currentColor" 防止 stroke 被 anti-aliasing 隐形 -->
        <XIcon size={16} strokeWidth={2.4} color="currentColor" />
      </button>
    </div>
    <!-- v0.3.36 #5 success-card: 中心 column, gap 14px (跟 mockup 3 .sheet-body 一致). -->
    <div class="sheet-body">
      <!-- 顶部绿色玻璃 ✓ icon (success visual anchor) -->
      <div class="check-hero" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
      </div>
      <!-- 主标题 17px (跟 mockup 3 .invite-modal-title 一致) -->
      <p class="invite-modal-title" data-testid="invite-confirm-title">账本链接已复制</p>
      <!-- 副标题 15px, 关键动词加粗 -->
      <p class="invite-modal-sub" data-testid="invite-confirm-sub">
        请妥善保管,链接可<strong>随时打开</strong>。
      </p>
      <!-- QR code 200×200 居中, white padding + 12px border-radius + bg 白 -->
      {#if qrDataUrl}
        <div class="qr-wrap" data-testid="invite-qr-wrap" aria-label="链接二维码">
          <img
            class="qr-img"
            src={qrDataUrl}
            alt="账本链接二维码"
            width="200"
            height="200"
            data-testid="invite-qr-img"
          />
        </div>
      {:else if qrError}
        <div class="qr-wrap qr-error" data-testid="invite-qr-error">二维码加载失败</div>
      {/if}
      <!-- URL preview chip — subtle indigo 玻璃, click 触发二次复制 (跟初始复制同 source) -->
      <button
        type="button"
        class="url-chip"
        onclick={handleUrlChipClick}
        title="点击重新复制链接"
        aria-label="重新复制账本链接"
        data-testid="invite-url-chip"
      >
        {inviteUrl}
      </button>
      <!-- 两列微型 use-case chip (回到此账本 / 邀请他人) -->
      <div class="use-row">
        <div class="use-chip">
          <strong>回到此账本</strong>
          粘贴到浏览器打开
        </div>
        <div class="use-chip">
          <strong>邀请他人</strong>
          发给朋友扫码
        </div>
      </div>
    </div>
    <div class="sheet-foot">
      <button type="button" class="btn-primary" onclick={closeModal} data-testid="invite-confirm-btn">
        知道了
      </button>
    </div>
  </div>
{/if}
</div>

<style>
  .invite-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-end;
  }
  /* v0.3.16 #8 (PO msg 19:26): 加 .glass-pill 玻璃化 */
  .invite-btn {
    transition: transform 150ms ease, background 150ms ease, box-shadow 150ms ease, color 150ms ease;
  }
  .invite-btn:active {
    transform: scale(0.97);
  }
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
  @media (max-width: 380px) {
    .invite-btn {
      padding: var(--space-2) var(--space-3);
      min-height: 36px;
    }
    .btn-label {
      font-size: var(--font-size-sm);
    }
  }

  /* ============================================================
   * v0.3.36 #17 — UAT 0728-1 #17 (PO 字面 "复制弹窗背景跟汇率弹窗完全一致"):
   * .invite-sheet-backdrop 跟 CurrencyAddModal .sheet-backdrop 字段级同 — bg rgba(15,23,42,0.40)
   * + blur(4px) saturate(180%) + z-index 50 (跟 CurrencyAddModal 字段级同).
   * ============================================================ */
  .invite-sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.40);
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
    z-index: 50;
    animation: backdropFadeIn 200ms ease-out;
  }

  /* === Bottom sheet (跟 AddSettlementSheet .sheet 同族, v0.3.35 #5 升级) === */
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
      /* v0.3.36 #17 — 跟 CurrencyAddModal .sheet-backdrop @supports fallback 同款 (0.55) */
      background: rgba(15, 23, 42, 0.55);
    }
  }

  /* ============================================================
   * v0.3.36 #5 (UAT 0728-1 #5, PO 字面 "邀请链接复制弹窗中的文字字号要适当增大,
   * 你可以请 design agent 重新设计一下这里") — success-card 形态
   * 设计师自决方案 = mockup 3 (PO 拍板).
   * 内部结构 100% 跟 AddSettlementSheet bottom sheet 同源
   * (sheet-handle / sheet-head / sheet-close / sheet-body / sheet-foot / btn-primary),
   * 只重排 sheet-body 内部 DOM.
   * ============================================================ */
  .sheet-handle {
    width: 36px;
    height: 4px;
    background: rgba(15, 23, 42, 0.18);
    border-radius: 100px;
    margin: 0 auto 12px;
  }
  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 12px;
  }
  .sheet-title {
    font-size: 17px;
    font-weight: 600;
    color: #171717;
    letter-spacing: -0.01em;
  }
  .sheet-close {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(15, 23, 42, 0.10);
    color: #525252;
    border: 0;
    cursor: pointer;
    transition: background 150ms ease;
  }
  .sheet-close:hover { background: rgba(15, 23, 42, 0.12); }

  /* === v0.3.36 #5: sheet-body 改 center column + gap 14px (success-card layout) === */
  .sheet-body {
    padding: 4px 4px 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }

  /* Checkmark hero — 64×64 绿色玻璃 disc */
  .check-hero {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.20) 0%, rgba(20, 184, 166, 0.14) 100%);
    backdrop-filter: saturate(200%) blur(20px);
    -webkit-backdrop-filter: saturate(200%) blur(20px);
    border: 1px solid rgba(16, 185, 129, 0.32);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      inset 0 -1px 0 rgba(16, 185, 129, 0.08),
      0 4px 14px rgba(16, 185, 129, 0.18);
    margin: 6px 0 0;
  }
  .check-hero svg { color: #047857; }

  /* Main heading — 17px 600 (跟 mockup 3 .invite-modal-title 一致, 跟 AddSettlementSheet sheet-title 同款) */
  .invite-modal-title {
    font-size: var(--font-size-lg); /* 17px clamp */
    font-weight: 600;
    color: var(--gray-900);
    letter-spacing: -0.01em;
    line-height: 1.4;
    text-align: center;
    margin: 0;
  }

  /* Sub line — 15px 400, 关键动词加粗 */
  .invite-modal-sub {
    font-size: var(--font-size-base); /* 15-16px */
    line-height: 1.5;
    color: var(--gray-700);
    text-align: center;
    margin: 0;
    font-weight: 400;
  }
  .invite-modal-sub strong {
    font-weight: 600;
    color: var(--gray-900);
  }

  /* QR code wrap — 200×200 + white padding + radius 8px + bg 白 + 浅 border + 微 shadow */
  .qr-wrap {
    width: 224px;          /* 200 (QR) + 12px × 2 padding = 224 */
    height: 224px;
    padding: 12px;
    border-radius: 12px;
    background: #ffffff;
    border: 1px solid rgba(15, 23, 42, 0.06);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.7),
      0 4px 12px rgba(15, 23, 42, 0.06);
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 4px 0;
  }
  .qr-img {
    display: block;
    width: 200px;
    height: 200px;
    border-radius: 4px;
    image-rendering: pixelated;       /* 让 QR 像素边缘锐利, 不被浏览器抗锯齿磨掉 */
    image-rendering: -webkit-optimize-contrast;
  }
  .qr-error {
    color: var(--gray-500);
    font-size: 13px;
    background: rgba(15, 23, 42, 0.04);
    border-style: dashed;
  }

  /* URL preview chip — subtle indigo 玻璃, click 触发 handleUrlChipClick 二次复制 */
  .url-chip {
    width: 100%;
    padding: 10px 14px;
    border-radius: 12px;
    background: rgba(99, 102, 241, 0.06);
    border: 1px dashed rgba(99, 102, 241, 0.30);
    color: var(--accent-700, #4338ca);
    font-size: 13px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.005em;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: inherit;
    cursor: pointer;
    transition: background 150ms ease, border-color 150ms ease;
  }
  .url-chip:hover {
    background: rgba(99, 102, 241, 0.10);
    border-color: rgba(99, 102, 241, 0.45);
  }
  .url-chip:active {
    transform: scale(0.99);
  }

  /* Use-case chips — 两列微型 chip */
  .use-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    width: 100%;
    margin-top: 2px;
  }
  .use-chip {
    padding: 9px 10px;
    border-radius: 10px;
    background: rgba(15, 23, 42, 0.04);
    border: 1px solid rgba(15, 23, 42, 0.06);
    color: var(--gray-700);
    font-size: 12px;
    font-weight: 500;
    text-align: center;
    line-height: 1.35;
  }
  .use-chip strong {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--gray-900);
    margin-bottom: 1px;
  }

  /* === sheet-foot + cta-row + btn-primary (跟 AddSettlementSheet 同族) === */
  .sheet-foot {
    display: flex;
    padding: 14px 4px 0;
  }
  .btn-primary {
    width: 100%;
    height: 50px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.95) 0%, rgba(168, 85, 247, 0.95) 100%);
    color: #fff;
    font-size: 16px;
    font-weight: 600;
    border: 0;
    cursor: pointer;
    box-shadow:
      0 4px 12px rgba(99, 102, 241, 0.30),
      inset 0 1px 0 rgba(255, 255, 255, 0.25);
    transition:
      background 150ms ease,
      transform 100ms ease;
  }
  .btn-primary:hover {
    background: linear-gradient(135deg, rgba(99, 102, 241, 1) 0%, rgba(59, 130, 246, 1) 100%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      0 6px 16px rgba(99, 102, 241, 0.36);
  }
  .btn-primary:active {
    transform: scale(0.97);
  }
  .btn-primary:focus-visible {
    outline: 2px solid var(--accent-500, #6366f1);
    outline-offset: 2px;
  }

  @keyframes backdropFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* === 移动端 375px: 紧凑 padding (跟 v0.3.35 #5 同款) === */
  @media (max-width: 380px) {
    .invite-modal {
      max-width: calc(100vw - 32px);
      padding: 20px;
      border-radius: 16px;
    }
    .qr-wrap {
      width: 200px;
      height: 200px;
      padding: 10px;
    }
    .qr-img {
      width: 180px;
      height: 180px;
    }
  }
</style>