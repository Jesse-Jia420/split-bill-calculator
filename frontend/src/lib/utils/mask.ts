/**
 * Mask helpers for PII display.
 *
 * Keep first character of the local part + *** + @domain so users can
 * still tell accounts apart without exposing the full address.
 */

/**
 * Mask an email address for display.
 *
 * @example
 *   maskEmail('alice@example.com')  // 'a***@example.com'
 *   maskEmail('a@example.com')      // 'a***@example.com'
 *   maskEmail('not-an-email')       // 'not***'
 *   maskEmail('')                   // '***'
 *   maskEmail(null)                 // ''
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const atIdx = email.indexOf('@');
  if (atIdx < 1) {
    return email.slice(0, 3) + '***';
  }
  const localPart = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  return localPart.charAt(0) + '***@' + domain;
}
