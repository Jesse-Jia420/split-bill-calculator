// Common fetch wrapper used by every domain API module.
// cookies are auto-attached via credentials: 'include'.
// All API paths are relative to /api -- the vite dev proxy strips that
// prefix and forwards to the FastAPI backend on 8449.

export class ApiError extends Error {
  status: number;
  code: string;
  detail: any;
  constructor(status: number, code: string, detail?: any) {
    super(String(status) + " " + code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`/api` + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options
  });

  if (!res.ok) {
    let detail: any = undefined;
    try {
      detail = await res.json();
    } catch {
      detail = { detail: { error: res.statusText } };
    }
    const code = detail?.detail?.error ?? (`http_${res.status}`);
    throw new ApiError(res.status, code, detail);
  }

  // 204 No Content -- return undefined casted to T.
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}
