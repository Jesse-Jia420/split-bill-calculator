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