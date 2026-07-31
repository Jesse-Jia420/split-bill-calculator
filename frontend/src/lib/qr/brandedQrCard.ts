/**
 * Compose a shareable branded ledger QR card (canvas → PNG data URL).
 * Matches FairLite paper + liquid-glass visual language: soft paper ground,
 * ExtraLight 「轻均」 + landing-style 「分账 FairLite」 mark, ledger name.
 * QR modules sit on transparent light cells (paper shows through) — no white
 * plate / scan-corner brackets.
 */
import QRCode from 'qrcode';

const W = 720;
const H = 900;

const PAPER = '#f6f5f1';
const INK = '#1a1a1a';
const INK_SOFT = 'rgba(26, 26, 26, 0.58)';
const MUTED = 'rgba(82, 82, 91, 0.78)';
const ACCENT = 'rgba(40, 40, 40, 0.22)';
const ACCENT_LINE = 'rgba(40, 40, 40, 0.35)';

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw text with letter-spacing (canvas has no CSS letter-spacing). */
function fillSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: CanvasTextAlign = 'center',
) {
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  const chars = Array.from(text);
  let total = 0;
  const widths: number[] = [];
  for (const ch of chars) {
    const w = ctx.measureText(ch).width;
    widths.push(w);
    total += w;
  }
  if (chars.length > 1) total += tracking * (chars.length - 1);

  let cursor =
    align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], cursor, y);
    cursor += widths[i] + tracking;
  }
  ctx.textAlign = prev;
}

function strokeSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: CanvasTextAlign = 'center',
) {
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  const chars = Array.from(text);
  let total = 0;
  const widths: number[] = [];
  for (const ch of chars) {
    const w = ctx.measureText(ch).width;
    widths.push(w);
    total += w;
  }
  if (chars.length > 1) total += tracking * (chars.length - 1);

  let cursor =
    align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  for (let i = 0; i < chars.length; i++) {
    ctx.strokeText(chars[i], cursor, y);
    cursor += widths[i] + tracking;
  }
  ctx.textAlign = prev;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function ensureFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load('200 88px "Noto Sans SC"'),
      document.fonts.load('400 28px "Noto Sans SC"'),
      document.fonts.load('500 32px "Noto Sans SC"'),
      document.fonts.load('500 26px "Inter Variable"'),
      document.fonts.load('400 22px "Inter Variable"'),
    ]);
    await document.fonts.ready;
  } catch {
    /* fall through — system fonts still ok */
  }
}

function truncateName(name: string, maxChars = 18): string {
  const cleaned = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return '未命名账本';
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;
  return chars.slice(0, maxChars - 1).join('') + '…';
}

/**
 * Build a branded QR PNG data URL for invite share / download / modal preview.
 */
export async function composeBrandedQrDataUrl(
  inviteUrl: string,
  sessionName: string = '',
): Promise<string> {
  await ensureFonts();

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');

  // --- Paper ground -------------------------------------------------------
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  const paperImg = await loadImage('/textured-paper.jpg');
  if (paperImg) {
    ctx.save();
    ctx.globalAlpha = 0.42;
    // cover
    const scale = Math.max(W / paperImg.width, H / paperImg.height);
    const pw = paperImg.width * scale;
    const ph = paperImg.height * scale;
    ctx.drawImage(paperImg, (W - pw) / 2, (H - ph) / 2, pw, ph);
    ctx.restore();
  }

  // Soft indigo wash (top-right + bottom-left) — glass atmosphere
  const wash1 = ctx.createRadialGradient(W * 0.85, 40, 20, W * 0.85, 80, 340);
  wash1.addColorStop(0, 'rgba(40, 40, 40, 0.14)');
  wash1.addColorStop(1, 'rgba(40, 40, 40, 0)');
  ctx.fillStyle = wash1;
  ctx.fillRect(0, 0, W, H);

  const wash2 = ctx.createRadialGradient(60, H - 40, 10, 80, H - 80, 300);
  wash2.addColorStop(0, 'rgba(58, 58, 58, 0.10)');
  wash2.addColorStop(1, 'rgba(58, 58, 58, 0)');
  ctx.fillStyle = wash2;
  ctx.fillRect(0, 0, W, H);

  // Outer soft card rim
  ctx.save();
  roundRect(ctx, 28, 28, W - 56, H - 56, 36);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Top glass highlight bar
  const topBar = ctx.createLinearGradient(80, 48, W - 80, 52);
  topBar.addColorStop(0, 'rgba(255,255,255,0)');
  topBar.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  topBar.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = topBar;
  ctx.fillRect(80, 48, W - 160, 2);

  // --- Brand mark: landing layout -----------------------------------------
  // Line 1: 「轻均」(ExtraLight glass). Line 2: 「分账 FairLite」 same size/weight.
  const brandY = 108;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // Dark glass approximation: translucent fill + crisp stroke
  ctx.font = '200 72px "Noto Sans SC", "PingFang SC", sans-serif';
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillStyle = INK_SOFT;
  strokeSpacedText(ctx, '轻均', W / 2, brandY, 16);
  fillSpacedText(ctx, '轻均', W / 2, brandY, 16);

  // Specular top highlight (second pass, clipped fade via lighter fill)
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  fillSpacedText(ctx, '轻均', W / 2, brandY - 1.5, 16);
  ctx.restore();

  // 「分账 FairLite」— same font size / weight (landing .brand-en)
  const subY = brandY + 38;
  const subFont =
    '400 22px "Inter Variable", Inter, "Noto Sans SC", "PingFang SC", system-ui, sans-serif';
  ctx.font = subFont;
  ctx.fillStyle = MUTED;
  const gap = 14;
  const fen = '分账';
  const en = 'FairLite';
  const fenW = ctx.measureText(fen).width;
  const enW = ctx.measureText(en).width;
  const rowW = fenW + gap + enW;
  const rowX = W / 2 - rowW / 2;
  ctx.textAlign = 'left';
  ctx.fillText(fen, rowX, subY);
  ctx.fillText(en, rowX + fenW + gap, subY);

  // Tagline
  ctx.font = '400 18px "Noto Sans SC", "PingFang SC", sans-serif';
  ctx.fillStyle = 'rgba(82, 82, 91, 0.62)';
  fillSpacedText(ctx, '极简分账，一链即平。', W / 2, subY + 34, 2);

  // Decorative divider
  const divY = subY + 58;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 120, divY);
  ctx.lineTo(W / 2 - 14, divY);
  ctx.moveTo(W / 2 + 14, divY);
  ctx.lineTo(W / 2 + 120, divY);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = ACCENT_LINE;
  ctx.arc(W / 2, divY, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // --- QR block (transparent light modules; no white plate / corners) -----
  const qrPixel = 400;
  const qrDataUrl = await QRCode.toDataURL(inviteUrl, {
    errorCorrectionLevel: 'H',
    margin: 1,
    width: qrPixel,
    color: {
      dark: '#0f172a',
      // Transparent light cells → paper card shows through
      light: '#00000000',
    },
  });
  const qrImg = await loadImage(qrDataUrl);
  if (!qrImg) throw new Error('QR image load failed');

  const framePad = 12;
  const frameSize = qrPixel + framePad * 2;
  const frameX = (W - frameSize) / 2;
  const frameY = divY + 24;

  // QR only — transparent light modules; paper card shows through (no white plate)
  ctx.drawImage(qrImg, frameX + framePad, frameY + framePad, qrPixel, qrPixel);

  // --- Ledger name ---------------------------------------------------------
  const nameY = frameY + frameSize + 44;
  const displayName = truncateName(sessionName, 16);
  ctx.font = '500 32px "Noto Sans SC", "PingFang SC", sans-serif';
  ctx.fillStyle = INK;
  fillSpacedText(ctx, displayName, W / 2, nameY, 1);

  ctx.font = '400 20px "Noto Sans SC", "PingFang SC", sans-serif';
  ctx.fillStyle = MUTED;
  fillSpacedText(ctx, '扫码加入账本', W / 2, nameY + 36, 4);

  // Footer brand strip
  const footY = H - 52;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(100, footY - 22);
  ctx.lineTo(W - 100, footY - 22);
  ctx.stroke();

  ctx.font = '400 17px "Noto Sans SC", "PingFang SC", "Inter Variable", Inter, sans-serif';
  ctx.fillStyle = 'rgba(82, 82, 91, 0.55)';
  fillSpacedText(ctx, '轻均 · 分账 FairLite', W / 2, footY, 2);

  return canvas.toDataURL('image/png');
}
