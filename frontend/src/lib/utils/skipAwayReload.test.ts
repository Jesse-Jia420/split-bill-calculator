import { describe, expect, it } from 'vitest';
import { shouldSkipAwayReload } from './skipAwayReload';

describe('shouldSkipAwayReload', () => {
  it('skips login OTP routes', () => {
    expect(shouldSkipAwayReload('/auth/login')).toBe(true);
    expect(shouldSkipAwayReload('/sessions/12/login')).toBe(true);
  });

  it('skips ledger bill-list detail', () => {
    expect(shouldSkipAwayReload('/s/ABCDEF1234')).toBe(true);
    expect(shouldSkipAwayReload('/s/abcdef1234/')).toBe(true);
  });

  it('does not skip join / list / settle', () => {
    expect(shouldSkipAwayReload('/s/ABCDEF1234/join')).toBe(false);
    expect(shouldSkipAwayReload('/s/ABCDEF1234/settle')).toBe(false);
    expect(shouldSkipAwayReload('/sessions')).toBe(false);
    expect(shouldSkipAwayReload('/')).toBe(false);
  });
});
