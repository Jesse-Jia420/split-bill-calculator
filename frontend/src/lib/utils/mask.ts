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

/** True when value looks like an already-masked address (e.g. a***@x.com). */
export function isMaskedEmail(email: string | null | undefined): boolean {
  return !!email && email.includes('***');
}

/**
 * Soft match for public-preview flows: compare mask(input) to a display mask.
 * Exact raw match when `expectedRaw` is a real address (no ***).
 */
export function emailMatchesSlot(
  input: string,
  opts: { expectedRaw?: string; emailMasked?: string } = {}
): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  const raw = (opts.expectedRaw ?? '').trim();
  if (raw && !isMaskedEmail(raw)) {
    return trimmed.toLowerCase() === raw.toLowerCase();
  }
  const masked = (opts.emailMasked || (isMaskedEmail(raw) ? raw : '')).trim();
  if (!masked) return true;
  return maskEmail(trimmed).toLowerCase() === masked.toLowerCase();
}
