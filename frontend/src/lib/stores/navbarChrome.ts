import { writable } from 'svelte/store';

/** Ledger-page scroll chrome for the global NavBar. */
export type NavbarChrome = {
  /** True when the in-page session title has scrolled under the navbar. */
  compact: boolean;
  /** Session / ledger name to surface in the navbar while compact. */
  title: string | null;
  /** Anon owner first-visit: show「当前未登录…」hint beside 登录以保存. */
  anonSaveHint: boolean;
};

export const navbarChrome = writable<NavbarChrome>({
  compact: false,
  title: null,
  anonSaveHint: false,
});

export function setNavbarLedgerChrome(title: string | null, compact: boolean) {
  navbarChrome.update((cur) => ({
    ...cur,
    title: title?.trim() ? title.trim() : null,
    compact: Boolean(compact && title?.trim()),
  }));
}

export function setNavbarAnonSaveHint(on: boolean) {
  navbarChrome.update((cur) => ({
    ...cur,
    anonSaveHint: Boolean(on),
  }));
}

export function resetNavbarChrome() {
  navbarChrome.set({ compact: false, title: null, anonSaveHint: false });
}
