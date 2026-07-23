import { writable, get } from 'svelte/store';
import { listSessions } from '$api/sessions';
import type { SessionSummary } from '$api/sessions';

export const sessions = writable<SessionSummary[]>([]);

export async function loadSessions(): Promise<SessionSummary[]> {
  try {
    const list = await listSessions();
    sessions.set(list);
    return list;
  } catch {
    sessions.set([]);
    return [];
  }
}

export function getSessions(): SessionSummary[] {
  return get(sessions);
}

/** v0.3.25 #16 (UAT: /sessions item 加红色删除按钮, owner only):
 * 从 sessions store 移除一个 session (DELETE 后本地同步). 触发 sessions
 * writable subscriber 自动重渲染列表. */
export function removeSession(id: number): void {
  sessions.update((list) => list.filter((s) => s.id !== id));
}