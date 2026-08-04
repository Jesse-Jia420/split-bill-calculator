import { describe, expect, it } from 'vitest';
import { shouldSkipAwayReload } from './skipAwayReload';

describe('shouldSkipAwayReload', () => {
  it('skips login OTP routes', () => {
    expect(shouldSkipAwayReload('/auth/login')).toBe(true);
    expect(shouldSkipAwayReload('/sessions/12/login')).toBe(true);
  });

  it('does not skip ledger bill-list or other routes', () => {
    expect(shouldSkipAwayReload('/s/ABCDEF1234')).toBe(false);
    expect(shouldSkipAwayReload('/s/ABCDEF1234/join')).toBe(false);
    expect(shouldSkipAwayReload('/s/ABCDEF1234/settle')).toBe(false);
    expect(shouldSkipAwayReload('/sessions')).toBe(false);
    expect(shouldSkipAwayReload('/')).toBe(false);
  });
});
