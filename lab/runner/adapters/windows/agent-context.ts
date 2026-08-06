/**
 * Build a production-compatible AgentContext for the headless lab runner.
 */

import type { AppState, AppAction, LabChartHandle, PerformanceLog } from './types';

interface BuildAgentContextOptions {
  getState: () => AppState;
  chartHandle: LabChartHandle;
  performanceLog: PerformanceLog;
  apiBase: string;
  dataDir?: string;
  availableTickers: string[];
  send: (payload: Record<string, unknown>) => void;
  dispatch: (action: AppAction) => void;
  onSwitchSymbol: (symbol: string, date?: string) => void | Promise<void>;
  lastResult: Record<string, unknown> | undefined;
  executionLog: Record<string, unknown>;
}

export function buildAgentContext(opts: BuildAgentContextOptions): Record<string, unknown> {
  return {
    getState: opts.getState,
    chartRef: { current: opts.chartHandle as unknown as Record<string, unknown> },
    performanceLog: opts.performanceLog,
    apiBase: opts.apiBase,
    dataDir: opts.dataDir,
    availableTickers: opts.availableTickers,
    send: opts.send,
    dispatch: opts.dispatch,
    onSwitchSymbol: opts.onSwitchSymbol,
    lastResult: opts.lastResult,
    executionLog: opts.executionLog,
    onMessage: undefined,
  };
}

export function buildCurrentWorldState(
  state: AppState,
  chartHandle: LabChartHandle,
  performanceLog: PerformanceLog,
): Record<string, unknown> {
  // Placeholder: the real buildWorldState is called at runtime via the
  // production module. This function is only used to satisfy the local type
  // signature until the production call returns.
  return { state, chartHandle, performanceLog } as Record<string, unknown>;
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

export function engineUrl(
  apiBase: string,
  path: string,
  params?: Record<string, string | number | undefined>,
  dataDir?: string,
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

export async function startEngineSession(args: {
  apiBase: string;
  symbol: string;
  startDate: string;
  dataDir?: string;
  startingBalance?: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const body = sessionStartBody(
    { symbol: args.symbol, starting_balance: args.startingBalance ?? 100000, start_date: args.startDate },
    args.dataDir,
  );

  const res = await fetch(`${args.apiBase}/api/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: args.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Session start failed (${res.status}): ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}
