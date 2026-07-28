<!--
  InviteLinkButton.svelte

  v0.1.2 反馈修 6 + v0.2.1 UI rev — 邀请按钮 stopPropagation (避免触发 members header 折叠).

  v0.3.15 (PO #4807 + Designer 报告) — 清理死代码.

  v0.3.22 #122 (PO msg 15:38 #8025) — 按钮文案 "邀请" → "账本链接/邀请".

  v0.3.23 #129 (PO msg 16:35 UAT 新批) — 删 btn-icon (emoji 视觉不一致).

  v0.3.24 #14 (PO msg 16:35 UAT #14) — 成功反馈 toast 改 confirm modal.

  v0.3.31 #2 (UAT 0725-2 #2) — breathing 匿名 owner 首次进入触发高亮呼吸.

  v0.3.36 #5 (UAT 0728-1 #5, PO 字面 "邀请链接复制弹窗中的文字字号要适当增大, 你可以请 design agent 重新设计一下这里")
    — 弹窗成功态改 success-card 形态 (PO 拍 mockup 3) + QR code 自动生成:
    * 顶部 64×64 绿色玻璃 ✓ icon
    * 主标题 "账本链接已复制" 17px
    * 副标题 15px, 关键动词加粗
    * URL preview chip (subtle indigo 玻璃)
    * "可用于 回到此账本 / 邀请他人" 用两列微型 chip
    * QR code (~200×200, 居中)
    * "知道了" 按钮 → manual dismiss
    * 弹窗关闭行为不变 (Esc / backdrop click / 知道了 全 OK)
    * URL chip click → 重新复制 invite URL

  v0.3.0728-2 #4 — UAT 0728-2 #4: QR code 点击保存 PNG.
    * QR <img> 加 onclick → fetch(qrDataUrl) → blob → URL.createObjectURL → anchor.download="账本二维码.png".
    * 视觉提示: cursor pointer + hover opacity 0.92 + active scale 0.98 + focus ring.
    * 键盘可达: role="button" + tabindex="0" + onkeydown (Enter/Space) 同样触发下载.
    * toast 反馈: 成功 "二维码已保存" / 失败 "保存失败,请长按图片手动保存".
    * 反 #121 自决 — 不用 file-saver 库, 走原生 fetch + Blob + URL.createObjectURL.

  v0.3.0728-2 #5 — UAT 0728-2 #5: 分享按钮 1 button → 3 button row (从左至右).
    1) 保存账本二维码 (anchor download QR.png, 复用 #4 downloadQrPng)
    2) 分享账本二维码 (navigator.share 带 QR PNG file attachment + AbortError 静默 + fallback 走 #4 downloadQrPng)
    3) 分享账本链接 (navigator.share URL, 跟 v0.3.37 #5 同款, handlePwaAction 不变)
    * 3 个 button 等宽 (flex: 1 1 0; gap: 8px; width: 100% 容器)
    * 字体从 13.5px → 12.5px (3 button 紧凑布局, padding 12 → 8px)
    * 视觉: 玻璃风 rgba(99,102,241,0.12→0.08) + border 1px 0.22 + accent-700 文字 (跟之前 1 button 同源)
    * Data-testid 3 个: invite-pwa-save-qr / invite-pwa-share-qr / invite-pwa-share-link (test-friendly)
    * PWA 引导 hint 文案保留在按钮上方 (1 hint + 3 button stack, 跟 mockup 一致)
    * 反 #121 自决 — 3 button 等宽 + 文案精简 + 文件名 账本二维码.png

  v0.3.37 #5 (PO msg #9309 UAT 0728-1 v2 #5) — 弹窗 4 优化:
    * QR <img> 加 onclick → fetch(qrDataUrl) → blob → URL.createObjectURL → anchor.download="账本二维码.png".
    * 视觉提示: cursor pointer + hover opacity 0.92 + active scale 0.98 + focus ring.
    * 键盘可达: role="button" + tabindex="0" + onkeydown (Enter/Space) 同样触发下载.
    * toast 反馈: 成功 "二维码已保存" / 失败 "保存失败,请长按图片手动保存".
    * 反 #121 自决 — 不用 file-saver 库, 走原生 fetch + Blob + URL.createObjectURL.

  v0.3.37 #5 (PO msg #9309 UAT 0728-1 v2 #5) — 弹窗 4 优化:
    1. 删除右上角 × close button — 删 <button class="sheet-close"> + aria-label + handler.
       保留 sheet-title 左侧空白让标题居中感 (不补 dummy spacer, 视觉对齐靠 text-align center).
    2. iOS sheet drag-down → dismiss:
       - touchstart 记录 sheetTopY + sheetHeight (调 use:portal 后 sheet 在 body 末尾)
       - touchmove deltaY > 0 → sheet `transform: translateY(deltaY)px`, backdrop alpha = 1 - min(1, deltaY / sheetHeight)
       - deltaY > sheetHeight × 0.3 → closeModal (跟手下滑)
       - deltaY < 0 (上滑) → rubber band: transform: translateY(deltaY/3)px + scale(1 - |deltaY|/2000) 轻微反馈
       - threshold < 0.3 → touchend 时回弹 (transition: transform 280ms cubic-bezier(0.32, 0.72, 0, 1), transform: none)
       - Playwright iPhone 13 touch sequence 模拟下滑 → sheet dismiss 验证
    3. 删 .use-row + .use-chip HTML + CSS (回到此账本 + 邀请他人 两列 chip).
       替换为 PWA 引导 row (下面 #4).
    4. 浏览器 PWA "添加到桌面" + 浏览器快捷邀请他人引导 (新功能):
       - Platform detection (navigator.userAgent + window.matchMedia):
         * iOS Safari (UA 含 "iPhone" + "Safari"): "在 Safari 点 [分享] 按钮 → 添加到主屏幕"
         * Android Chrome (UA 含 "Android" + "Chrome"): "在 Chrome 菜单 (⋮) → 添加到主屏幕"
         * Desktop Chrome/Edge (UA 含 "Chrome" + 非 mobile): "点击地址栏右侧 [安装] 图标"
         * 其他 fallback: "在浏览器菜单中添加到桌面"
       - Web Share API `navigator.share({url, title})` mobile + 复制链接 fallback desktop.
         注: Web Share API 只在 HTTPS + secure context 才能调, 失败 fallback 走 navigator.clipboard.writeText.
       - 视觉: 跟 success-card 同款玻璃 (rgba(15,23,42,0.04) bg + 1px solid rgba(15,23,42,0.06) border),
         2 行短文案 + 图标 (lucide) + 主行动按钮. 整体在 sheet-body 末尾 (QR + url-chip 之后).
       - 跟 modalOpen 同步: modal 关 → 不再显示 PWA row.

  注: 跟 v0.3.36 #6 + #17 兼容 — 保留 currentColor XIcon (实际已被 v0.3.37 删, 但 XIcon import 保留防止 unused 警告).
      PWA 引导用 lucide-svelte 新增 icons (Share2, MoreVertical, PlusSquare, Download).
-->
<script lang="ts">
  import { X as XIcon, Share2, MoreVertical, PlusSquare, Download } from 'lucide-svelte';
  import QRCode from 'qrcode';
  import { toast } from '$stores/toast';
  import { portal } from '$lib/actions/portal';
  import { createEventDispatcher, onMount } from 'svelte';

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

  /** v0.3.37 #5 #2: drag-down dismiss state. */
  let sheetEl: HTMLDivElement | null = null;
  let dragStartY = 0;
  let dragging = false;
  let dragDeltaY = 0;
  let sheetHeight = 0;

  /** v0.3.37 #5 #4: platform detection state (mobile / iOS / android / desktop). */
  let platform: 'ios' | 'android' | 'desktop' | 'other' = 'other';
  let isStandalone = false;

  /** v0.3.37 #5 #4: detect platform once on mount (UA + standalone check). */
  onMount(() => {
    if (typeof navigator === 'undefined' || typeof window === 'undefined') return;
    const ua = navigator.userAgent || '';
    const isiPhone = /iPhone/i.test(ua) && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
    const isAndroid = /Android/i.test(ua) && /Chrome/i.test(ua) && !/EdgA|EdgiOS/i.test(ua);
    const isDesktopChrome = !/Mobile|iPhone|iPad|Android/i.test(ua) && /Chrome|Edg/i.test(ua);
    if (isiPhone) platform = 'ios';
    else if (isAndroid) platform = 'android';
    else if (isDesktopChrome) platform = 'desktop';
    else platform = 'other';

    // 检测是否已经添加到桌面 (standalone mode), 已经是 PWA 就不显示引导
    // @ts-ignore — standalone 是 non-standard 但 Safari/Chrome 都支持
    isStandalone = window.matchMedia?.('(display-mode: standalone)').matches ||
      // @ts-ignore
      window.navigator.standalone === true;
  });

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
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 240,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
      });
    } catch (e: any) {
      console.error('[InviteLinkButton] QR generate failed:', e);
      qrError = e?.message ?? 'QR 码生成失败';
      qrDataUrl = '';
    }
  }

  /** v0.3.0728-2 #4: download QR code as PNG file.
   * 当前 qrDataUrl 已经是 base64 PNG data URL (qrcode.toDataURL 输出).
   * 用 fetch(dataURL) → blob → URL.createObjectURL → anchor download.
   * 反 #121 自决 — 不引入 file-saver 依赖, 直接走原生 API.
   * 文件名: "账本二维码.png" (跟 description 描述一致).
   */
  async function downloadQrPng(): Promise<boolean> {
    if (!qrDataUrl) return false;
    try {
      const resp = await fetch(qrDataUrl);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = '账本二维码.png';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // 短延迟再 revoke, 给浏览器一点时间触发下载
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      return true;
    } catch (e) {
      console.error('[InviteLinkButton] QR download failed:', e);
      return false;
    }
  }

  /** v0.3.24 #14: extract copy logic for readability. */
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
      modalOpen = true;
      dispatch('copy');
      dispatch('open');
    } else {
      toast.error('复制失败,请手动选中链接');
    }

    copied = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied = false;
      resetTimer = null;
    }, 10000);
  }

  /** v0.3.36 #5: URL chip click → 重新复制 invite URL. */
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

  /** v0.3.0728-2 #5: 3-button row 第 2 个 — 分享账本二维码 (mobile Web Share + QR file).
   * 跟 #4 链接分享类似, 但附件是 QR PNG (blob from qrDataUrl fetch).
   * AbortError user cancel 静默; fallback 走 navigator.clipboard.writeText (URL 兜底). */
  async function handleShareQr() {
    if (!qrDataUrl) {
      toast.error('二维码未生成');
      return;
    }
    let qrBlob: Blob | null = null;
    try {
      const resp = await fetch(qrDataUrl);
      qrBlob = await resp.blob();
    } catch {
      toast.error('二维码读取失败');
      return;
    }
    // 优先 Web Share API 带附件 (mobile 主流浏览器支持 files)
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      // @ts-ignore — navigator.canShare 是非标准但主流浏览器都支持
      const file = new File([qrBlob], '账本二维码.png', { type: 'image/png' });
      // @ts-ignore — navigator.canShare 同上
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          // @ts-ignore
          await navigator.share({
            title: '账本链接二维码',
            text: '扫一扫加入账本',
            files: [file],
          });
          dispatch('copy');
          return;
        } catch (e: any) {
          if (e?.name !== 'AbortError') {
            console.warn('[InviteLinkButton] Share QR failed, falling back:', e);
          } else {
            return;
          }
        }
      }
    }
    // fallback: 无 navigator.share / 不支持 files → 走下载
    const ok = await downloadQrPng();
    if (ok) {
      toast.success('二维码已保存, 可从相册分享');
    } else {
      toast.error('分享失败, 请长按二维码保存');
    }
  }

  /** v0.3.37 #5 #4: PWA 引导行动 — Web Share API (mobile) 或复制链接 (desktop fallback).
   * v0.3.0728-2 #5: 现仅用作 3-button row 第 3 个按钮 "分享账本链接" 的 handler. */
  async function handlePwaAction() {
    if (!inviteUrl) return;
    // 优先 Web Share API (mobile + Chrome desktop 都支持)
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: '账本链接',
          text: '邀请你加入账本',
          url: inviteUrl,
        });
        dispatch('copy');
        return;
      } catch (e: any) {
        // user cancel → AbortError, 不弹错误; 真错 (TypeError 等) → fallback
        if (e?.name !== 'AbortError') {
          console.warn('[InviteLinkButton] Web Share failed, falling back:', e);
        } else {
          return; // user 主动取消
        }
      }
    }
    // fallback: 复制链接 + toast
    const ok = await copyToClipboard(inviteUrl);
    if (ok) {
      toast.success('链接已复制, 可粘贴分享');
      dispatch('copy');
    } else {
      toast.error('分享失败,请手动复制链接');
    }
  }

  /** v0.3.24 #14: manual close (知道了 / Esc / backdrop click). */
  function closeModal() {
    modalOpen = false;
    dragDeltaY = 0;
    dragging = false;
  }

  /** v0.3.24 #14: Esc 关闭 modal. */
  function handleKeydown(e: KeyboardEvent) {
    if (modalOpen && e.key === 'Escape') closeModal();
  }

  /** v0.3.24 #14: 点击 backdrop 关闭 modal (modal 内点击不冒泡). */
  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) closeModal();
  }

  /** v0.3.37 #5 #2: drag-down dismiss — touch sequence. */
  function handleTouchStart(e: TouchEvent) {
    if (!sheetEl) return;
    const t = e.touches[0];
    if (!t) return;
    dragStartY = t.clientY;
    dragging = true;
    sheetHeight = sheetEl.getBoundingClientRect().height;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!dragging || !sheetEl) return;
    const t = e.touches[0];
    if (!t) return;
    const deltaY = t.clientY - dragStartY;
    dragDeltaY = deltaY;
    // 下滑 (deltaY > 0) → 跟手下滑
    // 上滑 (deltaY < 0) → rubber band (减缓 + 轻微 scale 反馈)
    if (deltaY >= 0) {
      sheetEl.style.transform = `translateY(${deltaY}px)`;
      sheetEl.style.transition = 'none';
    } else {
      // rubber band: 1/3 反馈 + 极轻微 scale (max -0.025)
      const rubberY = deltaY / 3;
      const scale = 1 + Math.max(deltaY, -100) / 4000;
      sheetEl.style.transform = `translateY(${rubberY}px) scale(${scale})`;
      sheetEl.style.transition = 'none';
    }
  }

  function handleTouchEnd() {
    if (!dragging || !sheetEl) return;
    const threshold = sheetHeight * 0.3;
    if (dragDeltaY > threshold) {
      // 跟手下滑超过 30% → dismiss
      closeModal();
    } else {
      // 回弹 (transition 280ms 同 sheet 进场)
      sheetEl.style.transform = '';
      sheetEl.style.transition = 'transform 280ms cubic-bezier(0.32, 0.72, 0, 1)';
      // 280ms 后清 transition
      setTimeout(() => {
        if (sheetEl) sheetEl.style.transition = '';
      }, 300);
    }
    dragging = false;
    dragDeltaY = 0;
  }

  /** v0.3.37 #5 #4: PWA 引导文案 (按平台分). */
  $: pwaHint = platform === 'ios'
    ? '在 Safari 点底部分享按钮,选择「添加到主屏幕」'
    : platform === 'android'
      ? '在 Chrome 菜单 (⋮) 中选择「添加到主屏幕」'
      : platform === 'desktop'
        ? '点击地址栏右侧「安装」图标,添加到桌面'
        : '在浏览器菜单中选择「添加到桌面」';

  $: pwaIcon = platform === 'ios' ? Share2 : platform === 'android' ? MoreVertical : platform === 'desktop' ? Download : PlusSquare;

  $: pwaButtonLabel = platform === 'desktop' ? '复制链接分享' : '分享账本链接';
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
     v0.3.37 #5 (PO msg #9309 UAT 0728-1 v2 #5): 弹窗 4 优化 —
       1. 删 sheet-close (× button)
       2. touch sequence drag-down dismiss (iOS sheet pattern)
       3. 删 use-row (回到此账本 + 邀请他人 两列 chip)
       4. 加 PWA 引导 row (添加到桌面 + 分享按钮)
     内部结构 100% 跟 AddSettlementSheet bottom sheet 同源 (backdrop / sheet-handle / sheet-body / sheet-foot). -->
<div use:portal data-testid="invite-modal-host">
{#if modalOpen}
  <div
    class="invite-sheet-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
    data-testid="invite-sheet-backdrop"
  ></div>
  <div
    class="invite-sheet"
    class:dragging
    role="dialog"
    aria-modal="true"
    aria-label="账本链接已复制"
    data-testid="invite-confirm-modal"
    bind:this={sheetEl}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    ontouchcancel={handleTouchEnd}
  >
    <div class="sheet-handle" aria-hidden="true"></div>
    <!-- v0.3.37 #5 #1: 删 sheet-close (× button), sheet-head 仅保留居中 title -->
    <div class="sheet-head">
      <span class="sheet-title" data-testid="invite-sheet-title">账本链接</span>
    </div>
    <!-- v0.3.36 #5 success-card: 中心 column, gap 14px -->
    <div class="sheet-body">
      <div class="check-hero" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
      </div>
      <p class="invite-modal-title" data-testid="invite-confirm-title">账本链接已复制</p>
      <p class="invite-modal-sub" data-testid="invite-confirm-sub">
        请妥善保管,链接可<strong>随时打开</strong>。
      </p>
      {#if qrDataUrl}
        <div class="qr-wrap" data-testid="invite-qr-wrap" aria-label="链接二维码">
          <!-- v0.3.0728-2 #4: QR image 加 onclick → 触发下载 (PNG, 文件名 "账本二维码.png").
               cursor: pointer + hover 视觉提示可在 CSS 中调整. -->
          <img
            class="qr-img"
            src={qrDataUrl}
            alt="账本链接二维码"
            width="200"
            height="200"
            data-testid="invite-qr-img"
            role="button"
            tabindex="0"
            aria-label="点击保存二维码"
            title="点击保存二维码"
            onclick={async (e) => {
              e.stopPropagation();
              const ok = await downloadQrPng();
              if (ok) toast.success('二维码已保存');
              else toast.error('保存失败,请长按图片手动保存');
            }}
            onkeydown={async (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const ok = await downloadQrPng();
                if (ok) toast.success('二维码已保存');
                else toast.error('保存失败,请长按图片手动保存');
              }
            }}
          />
        </div>
      {:else if qrError}
        <div class="qr-wrap qr-error" data-testid="invite-qr-error">二维码加载失败</div>
      {/if}
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

      <!-- v0.3.37 #5 #4: PWA 引导 row (删 use-row use-chip 后, 替换为此块)
           v0.3.0728-2 #5: 1 button row → 3 button row (从左至右):
             1) 保存账本二维码 — anchor download QR.png (reuse downloadQrPng)
             2) 分享账本二维码 — navigator.share + QR file (handleShareQr)
             3) 分享账本链接 — navigator.share URL (handlePwaAction, 跟之前一样)
           3 个 button 等宽 gap 8px (玻璃风 + 全站 .glass-pill 同族).
      {#if !isStandalone}
        <div class="pwa-row" data-testid="invite-pwa-row">
          <div class="pwa-hint">
            <svelte:component this={pwaIcon} size={18} strokeWidth={2} color="currentColor" />
            <span>{pwaHint}</span>
          </div>
          <div class="pwa-actions" data-testid="invite-pwa-actions">
            <button
              type="button"
              class="pwa-btn"
              onclick={async () => {
                const ok = await downloadQrPng();
                if (ok) toast.success('二维码已保存');
                else toast.error('保存失败,请长按图片手动保存');
              }}
              data-testid="invite-pwa-save-qr"
              aria-label="保存账本二维码"
              title="保存账本二维码"
            >
              <svelte:component this={Download} size={14} strokeWidth={2.2} color="currentColor" />
              <span>保存二维码</span>
            </button>
            <button
              type="button"
              class="pwa-btn"
              onclick={handleShareQr}
              data-testid="invite-pwa-share-qr"
              aria-label="分享账本二维码"
              title="分享账本二维码"
            >
              <svelte:component this={Share2} size={14} strokeWidth={2.2} color="currentColor" />
              <span>分享二维码</span>
            </button>
            <button
              type="button"
              class="pwa-btn"
              onclick={handlePwaAction}
              data-testid="invite-pwa-share-link"
              aria-label={pwaButtonLabel}
              title={pwaButtonLabel}
            >
              <svelte:component this={pwaIcon} size={14} strokeWidth={2.2} color="currentColor" />
              <span>{pwaButtonLabel}</span>
            </button>
          </div>
        </div>
      {/if}
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
   * .invite-sheet-backdrop 跟 CurrencyAddModal .sheet-backdrop 字段级同.
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

  /* === Bottom sheet (跟 AddSettlementSheet .sheet 同族, v0.3.35 #5 升级) ===
   * v0.3.37 #5 #2: 加 touch-action: pan-y 让浏览器知道此元素可垂直 pan (避免 passive listener 警告 + scroll lock conflict)
   * + 拖动时 transition:none (inline style 控制 transform) → 跟手反馈流畅 */
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
    touch-action: pan-y;
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
    will-change: transform;
  }
  .invite-sheet.dragging {
    /* drag 时 inline style 控制 transform, 这里只保证动画期间 overflow 不被 clip */
    transition: none !important;
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
      background: rgba(15, 23, 42, 0.55);
    }
  }

  /* ============================================================
   * v0.3.37 #5: sheet-handle / sheet-head / sheet-title 保留
   * sheet-close 整个块删掉 (#1)
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
    justify-content: center;     /* v0.3.37 #5 #1: 删 close 后 title 居中 */
    padding: 0 4px 12px;
  }
  .sheet-title {
    font-size: 17px;
    font-weight: 600;
    color: #171717;
    letter-spacing: -0.01em;
  }

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

  /* Main heading */
  .invite-modal-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--gray-900);
    letter-spacing: -0.01em;
    line-height: 1.4;
    text-align: center;
    margin: 0;
  }

  /* Sub line */
  .invite-modal-sub {
    font-size: var(--font-size-base);
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

  /* QR code wrap */
  .qr-wrap {
    width: 224px;
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
    image-rendering: pixelated;
    image-rendering: -webkit-optimize-contrast;
    /* v0.3.0728-2 #4: QR 可点击保存 — cursor pointer + 微弱 hover 高光让用户知道可交互. */
    cursor: pointer;
    transition: opacity 150ms ease, transform 100ms ease;
  }
  .qr-img:hover {
    opacity: 0.92;
  }
  .qr-img:active {
    transform: scale(0.98);
  }
  .qr-img:focus-visible {
    outline: 2px solid var(--accent-500, #6366f1);
    outline-offset: 2px;
  }
  .qr-error {
    color: var(--gray-500);
    font-size: 13px;
    background: rgba(15, 23, 42, 0.04);
    border-style: dashed;
  }

  /* URL preview chip */
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

  /* v0.3.37 #5 #3: 删 .use-row + .use-chip (回到此账本 + 邀请他人 两列 chip 整个块删)
   * 删原因: 之前 #5 success-card 把这两列做视觉装饰, 但实际功能被 v0.3.37 #4 PWA 引导替代 (PWA 引导含"分享账本链接"按钮实际可触达邀请场景) */

  /* ============================================================
   * v0.3.37 #5 #4: PWA 引导 row
   * 视觉: 跟 success-card 同款玻璃 (rgba(15,23,42,0.04) bg + 1px solid rgba(15,23,42,0.06) border)
   * 2 行: 顶部 hint 文案 + 图标 (一行, 12.5px)
   *      底部主行动按钮 (full width, 玻璃 indigo, 36px 高)
   * PWA 添加后 (isStandalone=true) → 整个块 hidden
   * ============================================================ */
  .pwa-row {
    width: 100%;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(15, 23, 42, 0.04);
    border: 1px solid rgba(15, 23, 42, 0.06);
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 2px 0 0;
  }
  .pwa-hint {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--gray-700);
    font-size: 12.5px;
    line-height: 1.45;
    font-weight: 500;
  }
  .pwa-hint :global(svg) {
    flex-shrink: 0;
    color: var(--gray-700);
  }
  /* v0.3.0728-2 #5: 3-button row 容器 — flex 等宽 gap 8px */
  .pwa-actions {
    display: flex;
    gap: 8px;
    width: 100%;
  }
  .pwa-btn {
    flex: 1 1 0;
    min-width: 0;
    height: 36px;
    padding: 0 8px;
    border-radius: 10px;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.12) 0%, rgba(99, 102, 241, 0.08) 100%);
    border: 1px solid rgba(99, 102, 241, 0.22);
    color: var(--accent-700, #4338ca);
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    transition: background 150ms ease, transform 100ms ease;
    white-space: nowrap;
  }
  .pwa-btn:hover {
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.18) 0%, rgba(99, 102, 241, 0.12) 100%);
  }
  .pwa-btn:active {
    transform: scale(0.98);
  }

  /* === sheet-foot + btn-primary (跟 AddSettlementSheet 同族) === */
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

  /* === 移动端 375px: 紧凑 padding === */
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