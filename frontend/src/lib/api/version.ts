import { apiFetch } from './client';

/** §3.11.13 — FE footer displays backend version pulled live. */
export async function getBackendVersion(): Promise<{ backend: string }> {
  return apiFetch<{ backend: string }>('/version', { method: 'GET' });
}
