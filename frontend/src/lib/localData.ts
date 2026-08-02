// Shared types and invoke wrappers for the Local Data backend commands.

export interface LocalTicker {
  symbol: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  rowCount?: number;
  timeframe?: number;
}

export interface CsvMapping {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CsvInspection {
  symbolCandidate: string;
  headers: string[];
  preview: string[][];
  mapping: CsvMapping;
  firstTimestamp?: string;
  lastTimestamp?: string;
  rowCount: number;
  intervalSeconds: number;
  confidence: number;
  ambiguous: boolean;
  canImport: boolean;
}

export interface ImportLocalCsvArgs {
  sourcePath: string;
  symbol: string;
  mapping?: CsvMapping;
  replace: boolean;
  confirmed: boolean;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function invokeTauri<T>(cmd: string, args?: Record<string, unknown> | object): Promise<T> {
  const tauri = (window as any).__TAURI_INTERNALS__;
  if (!tauri?.invoke) {
    return Promise.reject(new Error('Tauri is not available'));
  }
  return tauri.invoke(cmd, args) as Promise<T>;
}

export async function listLocalTickers(): Promise<LocalTicker[]> {
  const res = await invokeTauri<{ tickers: LocalTicker[] }>('list_local_tickers');
  return res.tickers ?? [];
}

export async function inspectLocalCsv(path: string): Promise<CsvInspection> {
  return invokeTauri<CsvInspection>('inspect_local_csv', { path });
}

export async function importLocalCsv(args: ImportLocalCsvArgs): Promise<LocalTicker> {
  return invokeTauri<LocalTicker>('import_local_csv', args);
}
