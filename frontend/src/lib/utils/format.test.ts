import { describe, it, expect } from 'vitest';
import { formatMoney, formatNumber, formatDate } from './format';

describe('formatMoney', () => {
  it('formats with thousands separator and 2 decimal places by default', () => {
    expect(formatMoney(1234.5)).toBe('1,234.50');
  });

  it('formats zero as "0.00"', () => {
    expect(formatMoney(0)).toBe('0.00');
  });

  it('handles negative numbers with a leading minus', () => {
    expect(formatMoney(-1234.5)).toBe('-1,234.50');
  });

  it('appends the currency suffix by default', () => {
    expect(formatMoney(5894.2, { currency: 'THB' })).toBe('5,894.20 THB');
  });

  it('omits the currency suffix when showSymbol is false', () => {
    expect(formatMoney(5894.2, { currency: 'THB', showSymbol: false })).toBe('5,894.20');
  });

  it('rounds to the requested number of decimals', () => {
    // 5894.205 → "5,894.21" (rounded to 2dp)
    expect(formatMoney(5894.205, { decimals: 2 })).toBe('5,894.21');
    expect(formatMoney(5894.2, { decimals: 0 })).toBe('5,894');
  });

  it('uses compact notation when requested (zh-CN uses 万/亿 above 10K)', () => {
    // 1,234,567 in zh-CN compact = "123.5万"
    expect(formatMoney(1234567, { compact: true })).toBe('123.5万');
    // 50,000 in zh-CN compact = "5万"
    expect(formatMoney(50000, { compact: true })).toBe('5万');
  });

  it('returns "—" for non-finite input without throwing', () => {
    expect(formatMoney(Number.NaN)).toBe('—');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatMoney(Number.NEGATIVE_INFINITY)).toBe('—');
  });

  it('returns "—" for null / undefined', () => {
    expect(formatMoney(null as unknown as number)).toBe('—');
    expect(formatMoney(undefined as unknown as number)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('formats with thousands separator', () => {
    expect(formatNumber(1234.5)).toBe('1,234.50');
  });

  it('respects custom decimal precision', () => {
    expect(formatNumber(5894.2, { decimals: 0 })).toBe('5,894');
    expect(formatNumber(5894.205, { decimals: 2 })).toBe('5,894.21');
  });

  it('returns "—" for non-finite input', () => {
    expect(formatNumber(Number.NaN)).toBe('—');
  });
});

describe('formatDate', () => {
  it('formats a date in the default "M月D日" style', () => {
    expect(formatDate('2026-06-22')).toBe('6月22日');
  });

  it('prepends the year when withYear is true', () => {
    expect(formatDate('2026-06-22', { withYear: true })).toBe('2026年6月22日');
  });

  it('includes the weekday when weekday is true (zh-CN format: date then weekday)', () => {
    // In zh-CN, the platform places weekday AFTER the date.
    expect(formatDate('2026-06-22', { weekday: true })).toBe('6月22日周一');
  });

  it('returns HH:MM when only time is requested', () => {
    expect(formatDate('2026-06-22T20:00:00+08:00', { time: true })).toBe('20:00');
  });

  it('returns year + date + time when full is true', () => {
    expect(formatDate('2026-06-22T20:00:00+08:00', { full: true })).toBe(
      '2026年6月22日 20:00'
    );
  });

  it('returns "—" for invalid input', () => {
    expect(formatDate('not-a-date')).toBe('—');
    expect(formatDate(new Date('not-a-date'))).toBe('—');
  });
});
