/**
 * Number / date / currency formatting utilities.
 *
 * Zero dependencies — built on the platform `Intl` namespace so it works
 * in every modern browser, Node 18+ and SvelteKit's SSR runtime.
 *
 * Sprint 1 (v0.1.3): this module is the single source of truth for any
 * money / quantity / date string the UI emits. Sprint 2+ components must
 * import from here rather than hand-formatting values.
 */

export interface FormatMoneyOptions {
  /** ISO 4217 code (e.g. 'THB', 'CNY', 'USD'). When provided a suffix is appended. */
  currency?: string;
  /** Show the currency suffix even when `currency` is set. Default: true. */
  showSymbol?: boolean;
  /** Number of decimal places. Default: 2. */
  decimals?: number;
  /** Use K / M / B compact notation for large numbers. Default: false. */
  compact?: boolean;
  /** BCP-47 locale tag. Default: 'zh-CN'. */
  locale?: string;
}

export interface FormatNumberOptions {
  decimals?: number;
  locale?: string;
}

export interface FormatDateOptions {
  withYear?: boolean;
  weekday?: boolean;
  /** When true, only the time portion (HH:MM) is returned. */
  time?: boolean;
  /** Year + date + time combined. */
  full?: boolean;
  /** BCP-47 locale tag. Default: 'zh-CN'. */
  locale?: string;
}

/** Returned when input is missing / non-finite — keeps the UI stable. */
const INVALID_PLACEHOLDER = '—';

/**
 * Returns true when the value cannot be safely formatted.
 * NaN, +/-Infinity, null, undefined, and non-numeric strings all qualify.
 */
function isInvalidNumber(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'string') {
    const n = Number(value);
    return !Number.isFinite(n);
  }
  return true;
}

/**
 * Format a number as money with thousands separator and tabular nums.
 *
 * @example
 * formatMoney(5894.2)                              // "5,894.20"
 * formatMoney(5894.2, { currency: 'THB' })         // "5,894.20 THB"
 * formatMoney(5894.2, { currency: 'THB',
 *                       showSymbol: false })       // "5,894.20"
 * formatMoney(1234567, { compact: true })          // "123.5万" (zh-CN)
 * formatMoney(NaN)                                 // "—"
 */
export function formatMoney(
  value: number,
  options: FormatMoneyOptions = {}
): string {
  if (isInvalidNumber(value)) return INVALID_PLACEHOLDER;

  const {
    currency,
    showSymbol = true,
    decimals = 2,
    compact = false,
    locale = 'zh-CN',
  } = options;

  let formatted: string;

  if (compact) {
    const nf = new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    formatted = nf.format(value as number);
  } else {
    const nf = new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: true,
    });
    formatted = nf.format(value as number);
  }

  if (currency && showSymbol) {
    return `${formatted} ${currency}`;
  }
  return formatted;
}

/**
 * Format a number with thousands separator and a configurable
 * number of decimal places — no currency suffix.
 *
 * @example
 * formatNumber(5894.2)                  // "5,894.20"
 * formatNumber(5894.2, { decimals: 0 }) // "5,894"
 */
export function formatNumber(
  value: number,
  options: FormatNumberOptions = {}
): string {
  if (isInvalidNumber(value)) return INVALID_PLACEHOLDER;

  const { decimals = 2, locale = 'zh-CN' } = options;

  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  }).format(value as number);
}

/**
 * Format a date (string or Date) for human-readable display.
 *
 * Behaviour depends on which option flags are set:
 *   - `withYear`  → prepend the year (e.g. "2026年6月22日")
 *   - `weekday`   → include the day of the week
 *   - `time`      → show only the time, e.g. "20:00"
 *   - `full`      → year + date + time
 *   - (default)   → "6月22日" (short, no year)
 *
 * Note: in zh-CN, `Intl.DateTimeFormat` naturally places the weekday
 * AFTER the date (e.g. "6月22日周一"). This is the platform's behaviour
 * and matches the way Chinese dates are normally written.
 *
 * @example
 * formatDate('2026-06-22')                          // "6月22日"
 * formatDate('2026-06-22', { withYear: true })      // "2026年6月22日"
 * formatDate('2026-06-22', { weekday: true })       // "6月22日周一"
 * formatDate('2026-06-22T20:00:00+08:00',
 *            { time: true })                        // "20:00"
 * formatDate('2026-06-22T20:00:00+08:00',
 *            { full: true })                        // "2026年6月22日 20:00"
 * formatDate('not-a-date')                          // "—"
 */
export function formatDate(
  value: string | Date,
  options: FormatDateOptions = {}
): string {
  const { withYear = false, weekday = false, time = false, full = false, locale = 'zh-CN' } = options;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return INVALID_PLACEHOLDER;

  // `time` alone → HH:MM only.
  if (time && !full) {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  // `full` is a meta-flag: year + date + time.
  const useYear = withYear || full;

  const dateParts: Intl.DateTimeFormatOptions = {
    month: 'long',
    day: 'numeric',
  };
  if (useYear) dateParts.year = 'numeric';
  if (weekday) dateParts.weekday = 'short';

  const dateStr = new Intl.DateTimeFormat(locale, dateParts).format(date);

  if (!full) return dateStr;

  const timeStr = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return `${dateStr} ${timeStr}`;
}
