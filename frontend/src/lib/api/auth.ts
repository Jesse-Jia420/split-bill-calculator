
import { apiFetch } from './client';

export interface MeResponse {
  user_id: number;
  email: string;
  default_name: string;
}

export interface VerifyCodeResponse extends MeResponse {
  auth_token_expires_at: string;
}

export const sendCode = (email: string) =>
  apiFetch<{ sent: boolean; email: string; ttl_minutes: number }>(
    '/auth/send-code',
    { method: 'POST', body: JSON.stringify({ email }) }
  );

export const verifyCode = (email: string, code: string) =>
  apiFetch<VerifyCodeResponse>('/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ email, code })
  });

export const logout = () =>
  apiFetch<{ logged_out: boolean }>('/auth/logout', { method: 'POST' });

export const me = () => apiFetch<MeResponse>('/auth/me');
