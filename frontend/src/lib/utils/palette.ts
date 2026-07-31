/**
 * v0.3.36 #12 + #13 — UAT 0728-1 #12 + #13 (PO 字面 "已结算记录 / 建议转账头像样式应跟成员 section 一致, 头像颜色应跟成员 section 一致").
 *
 * 把所有 avatar palette 计算集中到这一处共享 (之前 SessionMemberList + BillForm + SettlementRow
 * 各自 inline copy 一份 AVATAR_GRADIENTS 数组 + avatarGradient / paletteIndex / avatarInitial 函数).
 * 命名 / 颜色 / index 计算 / initial 推导 都在这里, 各组件 import 同一 source, 保证 4 处
 * (SessionMemberList 成员 chip / BillForm 参与者 / SettlementRow 已结算记录头像 / SettleTransferPath
 * 建议转账头像) 视觉完全一致.
 *
 * 命名约定:
 * - AVATAR_GRADIENTS = 10 色循环 (5 → 10 扩色, v0.3.0728-2 #20 PO 解冻:
 *   之前 5 色让 session 6+ 成员时 loop index % 5 撞色 (e.g. 6th member 跟 1st 同色).
 *   10 色保证 ≤10 成员的 session 每位独立颜色, 视觉一致性高).
 * - paletteGradient(index) → 返回完整 CSS `background: linear-gradient(...)`.
 * - paletteIndexFromMemberId(memberId) → stable hash 让同一 memberId 总拿到同一颜色 (跨 render 一致).
 * - avatarInitialOf(name) → 中文取首字 / 英文取首字母大写.
 *
 * Keep in sync with app.css `--avatar-0`…`--avatar-9`.
 */

/** Solid start-color per slot — for text accents ("xx 付") matching the avatar. */
export const AVATAR_SOLIDS: ReadonlyArray<string> = [
  '#6366f1', // indigo
  '#ec4899', // pink
  '#10b981', // emerald
  '#f59e0b', // amber
  '#3b82f6', // blue
  '#f43f5e', // rose
  '#84cc16', // lime
  '#0ea5e9', // sky
  '#8b5cf6', // violet
  '#f97316', // orange
];

const AVATAR_GRADIENTS: ReadonlyArray<string> = [
  'linear-gradient(135deg, rgba(99, 102, 241, 0.88) 0%, rgba(168, 85, 247, 0.88) 100%)', // indigo → purple
  'linear-gradient(135deg, rgba(236, 72, 153, 0.88) 0%, rgba(244, 63, 94, 0.88) 100%)', // pink → rose
  'linear-gradient(135deg, rgba(16, 185, 129, 0.88) 0%, rgba(20, 184, 166, 0.88) 100%)', // emerald → teal
  'linear-gradient(135deg, rgba(245, 158, 11, 0.88) 0%, rgba(234, 179, 8, 0.88) 100%)', // amber → yellow
  'linear-gradient(135deg, rgba(59, 130, 246, 0.88) 0%, rgba(6, 182, 212, 0.88) 100%)', // blue → cyan
  'linear-gradient(135deg, rgba(244, 63, 94, 0.88) 0%, rgba(217, 70, 239, 0.88) 100%)', // rose → fuchsia
  'linear-gradient(135deg, rgba(132, 204, 22, 0.88) 0%, rgba(34, 197, 94, 0.88) 100%)', // lime → green
  'linear-gradient(135deg, rgba(14, 165, 233, 0.88) 0%, rgba(59, 130, 246, 0.88) 100%)', // sky → blue
  'linear-gradient(135deg, rgba(139, 92, 246, 0.88) 0%, rgba(236, 72, 153, 0.88) 100%)', // violet → pink
  'linear-gradient(135deg, rgba(249, 115, 22, 0.88) 0%, rgba(239, 68, 68, 0.88) 100%)', // orange → red
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
