import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearLoginDraft,
  isAuthLoginPath,
  loadLoginDraft,
  saveLoginDraft,
} from './loginDraft';

function installMemorySessionStorage() {
  const map = new Map<string, string>();
  const store = {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    key(i: number) {
      return [...map.keys()][i] ?? null;
    },
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: store,
    configurable: true,
  });
}

describe('isAuthLoginPath', () => {
  it('matches /auth/login', () => {
    expect(isAuthLoginPath('/auth/login')).toBe(true);
    expect(isAuthLoginPath('/auth/login/')).toBe(true);
  });

  it('matches /sessions/{id}/login', () => {
    expect(isAuthLoginPath('/sessions/42/login')).toBe(true);
    expect(isAuthLoginPath('/sessions/42/login/')).toBe(true);
  });

  it('rejects other routes', () => {
    expect(isAuthLoginPath('/sessions')).toBe(false);
    expect(isAuthLoginPath('/sessions/42')).toBe(false);
    expect(isAuthLoginPath('/sessions/42/join')).toBe(false);
    expect(isAuthLoginPath('/auth')).toBe(false);
  });
});

describe('loginDraft sessionStorage', () => {
  beforeEach(() => {
    installMemorySessionStorage();
  });

  afterEach(() => {
    clearLoginDraft();
  });

  it('saves and loads a verify draft for the same path', () => {
    saveLoginDraft({ path: '/auth/login', email: 'you@example.com' });
    const d = loadLoginDraft('/auth/login');
    expect(d).not.toBeNull();
    expect(d?.email).toBe('you@example.com');
    expect(d?.step).toBe('verify');
  });

  it('does not load a draft for a different path', () => {
    saveLoginDraft({ path: '/auth/login', email: 'you@example.com' });
    expect(loadLoginDraft('/sessions/1/login')).toBeNull();
  });

  it('clears the draft', () => {
    saveLoginDraft({ path: '/auth/login', email: 'you@example.com' });
    clearLoginDraft();
    expect(loadLoginDraft('/auth/login')).toBeNull();
  });
});
