// =============================================================================
// engine — helpers for building engine REST URLs and bodies.
//
// These keep the data_dir conditional in one place so managed mode continues
// to omit it entirely and Local Data mode passes it on the endpoints that
// support it: /api/tickers, /api/candles, /api/session/start.
// =============================================================================

export interface AvailableDatesResult {
  symbol: string;
  dates: string[];
  earliest: string | null;
  latest: string | null;
  count: number;
  missing?: boolean;
  reason?: string;
}

export function engineUrl(
  apiBase: string,
  path: string,
  params?: Record<string, string | number | undefined>,
  dataDir?: string
): string {
  const p = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        p.set(key, String(value));
      }
    }
  }
  if (dataDir) {
    p.set('data_dir', dataDir);
  }
  const qs = p.toString();
  return `${apiBase}${path}${qs ? `?${qs}` : ''}`;
}

export function sessionStartBody(params: {
  symbol: string;
  starting_balance: number;
  start_date?: string;
}, dataDir?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    symbol: params.symbol,
    starting_balance: params.starting_balance,
  };
  if (params.start_date) {
    body.start_date = params.start_date;
  }
  if (dataDir) {
    body.data_dir = dataDir;
  }
  return body;
}

export async function fetchAvailableDates(
  apiBase: string,
  symbol: string,
  dataDir?: string,
  options?: { signal?: AbortSignal }
): Promise<AvailableDatesResult> {
  const res = await fetch(
    engineUrl(apiBase, '/api/available_dates', { symbol }, dataDir),
    options
  );
  if (!res.ok) {
    throw new Error(`Engine returned ${res.status}`);
  }
  return (await res.json()) as AvailableDatesResult;
}
