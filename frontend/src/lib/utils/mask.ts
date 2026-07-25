/**
 * Mask helpers for PII display (PO v0.3.29 — UAT 0725-1 #13 v4).
 *
 * 历史:
 * - v0.3.28 (UAT 0723-3 #2): 初版 inline 在 `join/+page.svelte::maskEmail`,
 *   头 3 位 + *** + @ + 完整 domain (e.g. `xin***@outlook.com`).
 *   domain 完整保留是为了让 user 还能从邮箱区分是哪个账号绑定的
 *   (e.g. outlook vs gmail).
 *
 * - v0.3.29 (UAT 0725-1 #13 v4 #5): PO 拍板方案 B — 改为首 1 字符 + ***
 *   + @ + 完整 domain (e.g. `x***@outlook.com`). 留 1 字符比 3 字符更
 *   隐藏, 但仍能让 user 凭残留字符 + domain 区分账号 (e.g. "x" 开头
 *   outlook = xinhua1001).
 *
 *   抽到独立模块方便 §11 跨页面 (join 页 + 登录页 subtitle) 共享, 避免
 *   重复定义 + 修一处忘一处.
 */

/**
 * Mask an email address for display: keep first 1 char + *** + @domain.
 *
 * @example
 *   maskEmail('demo@example.com')  // 'x***@outlook.com'
 *   maskEmail('a@gmail.com')             // 'a***@gmail.com'
 *   maskEmail('not-an-email')            // 'not***' (fallback: 3 chars + ***)
 *   maskEmail('')                        // '***'
 *   maskEmail(null)                      // ''
 *
 * @param email raw email string
 * @returns masked display string (empty for nullish)
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const atIdx = email.indexOf('@');
  if (atIdx < 1) {
    // No '@' or starts with '@' — fall back to first 3 chars + ***
    return email.slice(0, 3) + '***';
  }
  const localPart = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  return localPart.charAt(0) + '***@' + domain;
}