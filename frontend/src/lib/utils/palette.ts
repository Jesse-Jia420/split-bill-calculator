/**
 * Avatar palette — soft charcoal companions (low-saturation).
 *
 * Shared by SessionMemberList / BillForm / SettlementRow / SettleTransferPath
 * (and CSS tokens `--avatar-0`…`--avatar-9` in app.css — keep in sync).
 *
 * 10 hues so ≤10 members each get a distinct color (index % 10).
 */

/** Solid start-color per slot — for text accents ("xx 付") matching the avatar. */
export const AVATAR_SOLIDS: ReadonlyArray<string> = [
  '#5c6570', // charcoal slate
  '#c17a7a', // dusty rose (settle-neg family)
  '#4d8f6e', // sage (settle-pos family)
  '#b8956c', // warm clay
  '#6a8499', // steel blue
  '#9a7a8c', // soft mauve
  '#7a8f6a', // moss olive
  '#5e8a85', // dusty teal
  '#8a7d72', // taupe
  '#c08a6e', // terracotta
];

const AVATAR_GRADIENTS: ReadonlyArray<string> = [
  'linear-gradient(135deg, rgba(92, 101, 112, 0.88) 0%, rgba(110, 118, 130, 0.88) 100%)', // charcoal slate
  'linear-gradient(135deg, rgba(193, 122, 122, 0.88) 0%, rgba(168, 120, 136, 0.88) 100%)', // dusty rose → mauve
  'linear-gradient(135deg, rgba(77, 143, 110, 0.88) 0%, rgba(106, 143, 120, 0.88) 100%)', // sage → soft olive
  'linear-gradient(135deg, rgba(184, 149, 108, 0.88) 0%, rgba(168, 137, 106, 0.88) 100%)', // warm clay
  'linear-gradient(135deg, rgba(106, 132, 153, 0.88) 0%, rgba(94, 122, 143, 0.88) 100%)', // steel blue
  'linear-gradient(135deg, rgba(154, 122, 140, 0.88) 0%, rgba(138, 112, 128, 0.88) 100%)', // soft mauve
  'linear-gradient(135deg, rgba(122, 143, 106, 0.88) 0%, rgba(109, 133, 96, 0.88) 100%)', // moss olive
  'linear-gradient(135deg, rgba(94, 138, 133, 0.88) 0%, rgba(106, 143, 138, 0.88) 100%)', // dusty teal
  'linear-gradient(135deg, rgba(138, 125, 114, 0.88) 0%, rgba(122, 111, 102, 0.88) 100%)', // taupe
  'linear-gradient(135deg, rgba(192, 138, 110, 0.88) 0%, rgba(176, 122, 104, 0.88) 100%)', // terracotta
];

/** Returns `background: linear-gradient(...)` for inline style (iOS Safari needs the property name). */
export function paletteGradient(index: number): string {
  return `background: ${AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length]}`;
}

/** Solid hex matching paletteGradient(index) start color. */
export function paletteSolid(index: number): string {
  return AVATAR_SOLIDS[index % AVATAR_SOLIDS.length];
}

/**
 * Stable hash: memberId → 0..AVATAR_GRADIENTS.length-1.
 */
export function paletteIndexFromMemberId(memberId: number): number {
  const s = String(memberId);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % AVATAR_GRADIENTS.length;
}

/**
 * Avatar 首字符:
 * - 中文: 取首字
 * - 英文: 取首字母大写
 * - 空 → '?'
 */
export function avatarInitialOf(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const code = trimmed.codePointAt(0) ?? 0;
  if (code > 127) return trimmed.slice(0, 1);
  return trimmed.slice(0, 1).toUpperCase();
}
