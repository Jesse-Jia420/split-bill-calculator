import { writable } from 'svelte/store';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

/** 全站 Toast 状态 store (single root + stack). */
const store = writable<ToastItem[]>([]);

let nextId = 1;

/** 显示一条 Toast,默认 2000ms 后自动消失。 */
export function showToast(message: string, kind: ToastKind = 'info', durationMs = 2000): number {
  const id = nextId++;
  store.update((items) => [...items, { id, message, kind }]);
  if (durationMs > 0) {
    setTimeout(() => dismissToast(id), durationMs);
  }
  return id;
}

export function dismissToast(id: number): void {
  store.update((items) => items.filter((t) => t.id !== id));
}

export function dismissAll(): void {
  store.set([]);
}

export const toast = {
  subscribe: store.subscribe,
  show: showToast,
  success: (msg: string, durationMs?: number) => showToast(msg, 'success', durationMs),
  error: (msg: string, durationMs?: number) => showToast(msg, 'error', durationMs),
  info: (msg: string, durationMs?: number) => showToast(msg, 'info', durationMs),
  dismiss: dismissToast,
  dismissAll,
};