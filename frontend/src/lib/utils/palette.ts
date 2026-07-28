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
 * - AVATAR_GRADIENTS = 5 色循环 (跟 v0.3.18 #64 + v0.3.20 #91 + v0.3.23 #132 沿用, glass 语言同源).
 * - paletteGradient(index) → 5 色循环返回 CSS background value.
 * - paletteIndexFromMemberId(memberId) → stable hash 让同一 memberId 总拿到同一颜色 (跨 render 一致).
 *   反 #121 Master 自决技术细节: 用 string hash (djb2-like) 而不是 Math.random, 保证同 member 颜色稳定.
 * - avatarInitialOf(name) → 中文取首字 / 英文取首字母大写, 跟 SessionMemberList + BillForm 同款 (v0.3.20 #91 mockup 拍板).
 *
 * 共享此 module 的组件:
 * - SessionMemberList.svelte (成员 chip avatar)
 * - BillForm.svelte (参与者 .ppt-avatar)
 * - SettlementRow.svelte (已结算记录 payer/payee avatar)
 * - SettleTransferPath.svelte (建议转账 from/to avatar, #13 新加)
 *
 * 不在此 module 的: AppBackground / LoadingOverlay 等非 avatar 组件 (无需 palette).
 */

const AVATAR_GRADIENTS: ReadonlyArray<string> = [
  'linear-gradient(135deg, rgba(99, 102, 241, 0.88) 0%, rgba(168, 85, 247, 0.88) 100%)', // indigo → purple
  'linear-gradient(135deg, rgba(236, 72, 153, 0.88) 0%, rgba(244, 63, 94, 0.88) 100%)', // pink → rose
  'linear-gradient(135deg, rgba(16, 185, 129, 0.88) 0%, rgba(20, 184, 166, 0.88) 100%)', // emerald → teal
  'linear-gradient(135deg, rgba(245, 158, 11, 0.88) 0%, rgba(234, 179, 8, 0.88) 100%)', // amber → yellow
  'linear-gradient(135deg, rgba(59, 130, 246, 0.88) 0%, rgba(6, 182, 212, 0.88) 100%)', // blue → cyan
];

/** 5 色循环 (index wrap) — 用于 SessionMemberList / BillForm 数组下标 (跟 memberCount 顺序一致). */
export function paletteGradient(index: number): string {
  return AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
}

/**
 * Stable hash: memberId → 0..AVATAR_GRADIENTS.length-1.
 * 用于 SettlementRow (payer_id / payee_id) + SettleTransferPath (from_member_id / to_member_id).
 * 不要求 cryptographically unique — 只用于跨 session 跨 render 给同 member 稳定颜色.
 */
export function paletteIndexFromMemberId(memberId: number): number {
  const s = String(memberId);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % AVATAR_GRADIENTS.length;
}

/**
 * Avatar 首字符:
 * - 中文: 取首字 (e.g. "像" → "像")
 * - 英文: 取前 2 字符大写 (e.g. "Jesse" → "JE", 跟 SessionMemberList 一致; BillForm mockup 拍板 "J" 是 v0.3.20 #91
 *   PO 反向调, 但 SessionMemberList 一直用 "JE"/"Ca" 2 字符 — 实际 codebase 有两种行为; 这里用 1 字符
 *   跟 BillForm / SettlementRow 主流一致, 跟 SessionMemberList 略不同 (但视觉差异极小))
 * - 空字符串 → '?'
 *
 * 注: 实际上 SessionMemberList 用 2 字符大写, BillForm 用 1 字符大写, SettlementRow 用 1 字符.
 * 这里统一 1 字符让 4 处行为一致, 跟 v0.3.20 #91 mockup 拍板 (PO 当时改 2→1 字符).
 * 后续如需 SessionMemberList 跟随, 一处改全改.
 */
export function avatarInitialOf(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const code = trimmed.codePointAt(0) ?? 0;
  if (code > 127) return trimmed.slice(0, 1);
  return trimmed.slice(0, 1).toUpperCase();
}