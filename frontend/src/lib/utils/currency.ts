/**
 * Currency symbol / display helpers.
 *
 * v0.3.15 (PRD §3.15.2 #2): extracted from BillForm so any component
 * can prefix a currency code with its symbol without redefining the
 * mapping (CNY ¥, THB ฿, JPY ¥, USD $, EUR €, GBP £). Unknown codes
 * fall through to an empty string — callers decide whether to also
 * append the raw code (e.g. for debugging / runtime safety net).
 *
 * The mapping is intentionally hard-coded rather than reading
 * `Intl.NumberFormat` for the target locale. The project deals in a
 * small set of currencies (CNY, THB, JPY, USD); `Intl` returns e.g.
 * "CN¥" for CNY which is two characters and looks visually heavier
 * than the single "¥" the product wants on settle balances / transfer
 * paths. Keep this list tight until product asks for more.
 */

const SYMBOLS: Record<string, string> = {
  CNY: '¥',
  THB: '฿',
  JPY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

export function currencySymbol(code: string): string {
  if (!code) return '';
  return SYMBOLS[code.toUpperCase()] ?? '';
}
