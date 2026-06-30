import { writable, get } from 'svelte/store';
import { me, logout as apiLogout } from '$api/auth';
import type { MeResponse } from '$api/auth';

export const user = writable<MeResponse | null>(null);

export async function loadUser(): Promise<MeResponse | null> {
  try {
    const u = await me();
    user.set(u);
    return u;
  } catch {
    user.set(null);
    return null;
  }
}

export function clearUser() {
  user.set(null);
}

export async function logout(): Promise<void> {
  try {
    await apiLogout();
  } catch {
    // ignore -- cookie clearing is the goal regardless
  }
  clearUser();
}

export function getUser(): MeResponse | null {
  return get(user);
}