import { writable } from 'svelte/store';

/** Ledger-page scroll chrome for the global NavBar. */
export type NavbarChrome = {
  /** True when the in-page session title has scrolled under the navbar. */
  compact: boolean;
  /** Session / ledger name to surface in the navbar while compact. */
  title: string | null;
};

export const navbarChrome = writable<NavbarChrome>({
  compact: false,
  title: null,
});

export function setNavbarLedgerChrome(title: string | null, compact: boolean) {
  navbarChrome.set({
    title: title?.trim() ? title.trim() : null,
    compact: Boolean(compact && title?.trim()),
  });
}

export function resetNavbarChrome() {
  navbarChrome.set({ compact: false, title: null });
}
