import { apiFetch } from './client';

export interface ReferenceRate {
  from_currency: string;
  to_currency: string;
  /** Decimal string: 1 from = rate to */
  rate: string;
  provider: string;
  /** Provider/ECB date YYYY-MM-DD */
  provider_date: string | null;
  /** ISO-8601 UTC when our backend fetched */
  fetched_at: string;
}

/** Public reference FX: 1 `fromCurrency` = rate `toCurrency`. */
export function fetchReferenceRate(
  fromCurrency: string,
  toCurrency: string,
  init?: RequestInit
): Promise<ReferenceRate> {
  const q = new URLSearchParams({
    from: fromCurrency,
    to: toCurrency,
  });
  return apiFetch<ReferenceRate>(`/exchange-rates/reference?${q.toString()}`, {
    method: 'GET',
    ...init,
  });
}

/** Format fetched_at / provider_date for UI. */
export function formatRateFetchedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}
