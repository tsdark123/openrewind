import type { ActiveSessionTrade, ClosedTrade, PerformanceLog, SessionRecord, TradeLog } from '../types';

export type Metric = 'dollar' | 'percent' | 'rmultiple' | 'trades';

export type DayStats = {
  profit: number;
  trades: number;
  winRate: number;
  rMultiple: number;
};

export type MonthStats = {
  profit: number;
  trades: number;
  sessions: number;
  winRate: number;
  rMultiple: number;
};

export const METRICS: { id: Metric; label: string }[] = [
  { id: 'dollar', label: 'Dollar profit' },
  { id: 'percent', label: 'Win rate' },
  { id: 'rmultiple', label: 'R multiple' },
  { id: 'trades', label: 'Trade count' },
];

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const tauri = (window as any).__TAURI_INTERNALS__;
  return tauri.invoke(cmd, args);
}

function storageKey(): string {
  return 'openrewind:journal';
}

export async function loadPerformanceLog(): Promise<PerformanceLog> {
  try {
    if (isTauri()) {
      const raw = (await invoke('read_journal')) as string;
      return JSON.parse(raw || '{}') as PerformanceLog;
    }
    const raw = localStorage.getItem(storageKey());
    return raw ? (JSON.parse(raw) as PerformanceLog) : {};
  } catch (e) {
    console.error('[OpenRewind] Failed to load journal:', e);
    return {};
  }
}

export async function writePerformanceLog(log: PerformanceLog): Promise<void> {
  const json = JSON.stringify(log);
  try {
    if (isTauri()) {
      await invoke('write_journal', { contents: json });
    } else {
      localStorage.setItem(storageKey(), json);
    }
  } catch (e) {
    console.error('[OpenRewind] Failed to write journal:', e);
  }
}

export function makeSessionKey(symbol: string, date: string): string {
  return `${symbol}:${date}`;
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function computeTradeR(trade: ClosedTrade): number {
  if (!trade.stop_loss || trade.stop_loss === 0) return 0;
  const risk = Math.abs(trade.entry_price - trade.stop_loss) * trade.quantity;
  if (risk === 0) return 0;
  return trade.realized_pnl / risk;
}

function realizedPnl(t: TradeLog | ClosedTrade): number {
  return 'realizedPnl' in t ? t.realizedPnl : (t as ClosedTrade).realized_pnl;
}

function entryPrice(t: TradeLog | ClosedTrade): number {
  return 'entryPrice' in t ? t.entryPrice : (t as ClosedTrade).entry_price;
}

function stopLoss(t: TradeLog | ClosedTrade): number | undefined {
  return 'stopLoss' in t ? t.stopLoss : (t as ClosedTrade).stop_loss;
}

export function tradeRMultiple(t: TradeLog | ClosedTrade): number {
  if ('rMultiple' in t && typeof t.rMultiple === 'number') return t.rMultiple;
  const sl = stopLoss(t);
  if (!sl || sl === 0) return 0;
  const risk = Math.abs(entryPrice(t) - sl) * t.quantity;
  return risk === 0 ? 0 : realizedPnl(t) / risk;
}

export function getRecordTrades(record: SessionRecord): (TradeLog | ClosedTrade)[] {
  return (record.trades ?? record.closedTrades ?? []) as (TradeLog | ClosedTrade)[];
}

export function aggregateTrades(trades: (TradeLog | ClosedTrade)[]): DayStats {
  const total = trades.length;
  const profit = trades.reduce((sum, t) => sum + realizedPnl(t), 0);
  const wins = trades.filter((t) => realizedPnl(t) > 0).length;
  const rTotal = trades.reduce((sum, t) => sum + tradeRMultiple(t), 0);
  const rMultiple = total > 0 ? rTotal / total : 0;
  return {
    profit,
    trades: total,
    winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
    rMultiple: Number(rMultiple.toFixed(2)),
  };
}

export async function endSession(activeSessionTrades: ActiveSessionTrade[]): Promise<PerformanceLog> {
  const log = await loadPerformanceLog();
  const now = Date.now();

  // Group trades by symbol + date bucket. Orion-driven automated trades are
  // dropped here so the persisted journal only reflects the user's real
  // decisions. Automated fills still appeared on the chart during the run
  // and were reported through the Orion result card — they simply never
  // enter the long-term performance log.
  const humanTrades = activeSessionTrades.filter((t) => t.is_automated !== true);

  const buckets: Record<string, { symbol: string; date: string; trades: ActiveSessionTrade[] }> = {};
  for (const t of humanTrades) {
    const key = makeSessionKey(t.symbol, t.date);
    if (!buckets[key]) {
      buckets[key] = { symbol: t.symbol, date: t.date, trades: [] };
    }
    buckets[key].trades.push(t);
  }

  for (const key in buckets) {
    const bucket = buckets[key];
    const startedAt = bucket.trades[0]?.opened_at
      ? bucket.trades[0].opened_at * 1000
      : now;

    const tradeLogs: TradeLog[] = bucket.trades.map((t) => ({
      id: String(t.id),
      symbol: t.symbol,
      date: t.date,
      action: t.side === 'buy' ? 'BUY' : 'SELL',
      entryTime: t.opened_at,
      exitTime: t.closed_at,
      entryPrice: t.entry_price,
      exitPrice: t.exit_price,
      quantity: t.quantity,
      realizedPnl: t.realized_pnl,
      stopLoss: t.stop_loss,
      takeProfit: t.take_profit,
      rMultiple: Number(computeTradeR(t).toFixed(2)),
    }));

    const stats = aggregateTrades(tradeLogs);

    const record: SessionRecord = {
      id: uuid(),
      symbol: bucket.symbol,
      date: bucket.date,
      startedAt,
      endedAt: now,
      startingBalance: 0, // v1: per-bucket starting balance not tracked
      endingBalance: stats.profit, // v1 placeholder = net profit for the session
      trades: tradeLogs,
    };

    if (!log[key]) log[key] = [];
    log[key].push(record);
  }

  await writePerformanceLog(log);
  return log;
}

export function getRecordsForDate(log: PerformanceLog, y: number, m: number, d: number): SessionRecord[] {
  const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const out: SessionRecord[] = [];
  for (const key in log) {
    for (const rec of log[key]) {
      if (rec.date === dateStr) out.push(rec);
    }
  }
  return out;
}

export function getRecordsForMonth(log: PerformanceLog, y: number, m: number): SessionRecord[] {
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
  const out: SessionRecord[] = [];
  for (const key in log) {
    for (const rec of log[key]) {
      if (rec.date.startsWith(prefix)) out.push(rec);
    }
  }
  return out;
}

export function getDayStats(log: PerformanceLog, y: number, m: number, d: number): DayStats | null {
  const recs = getRecordsForDate(log, y, m, d);
  if (recs.length === 0) return null;
  const trades = recs.flatMap(getRecordTrades);
  return aggregateTrades(trades);
}

export function getMonthStats(log: PerformanceLog, y: number, m: number): MonthStats {
  const recs = getRecordsForMonth(log, y, m);
  const trades = recs.flatMap(getRecordTrades);
  const dayStats = aggregateTrades(trades);
  return {
    ...dayStats,
    sessions: recs.length,
  };
}

export function buildMonthGrid(y: number, m: number) {
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(y, m, 1 - offset);
  const total = Math.ceil((offset + new Date(y, m + 1, 0).getDate()) / 7) * 7;
  return Array.from({ length: total }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { date, outside: date.getMonth() !== m };
  });
}

export function formatMoney(value: number, withSign = false) {
  const abs = Math.abs(value);
  const sign = withSign && value !== 0 ? (value > 0 ? '+' : '-') : '';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatMetric(metric: Metric, s: DayStats): string {
  switch (metric) {
    case 'percent':
      return `${s.winRate}%`;
    case 'rmultiple':
      return `${s.rMultiple.toFixed(2)}R`;
    case 'trades':
      return `${s.trades}`;
    default:
      return formatMoney(s.profit, true);
  }
}

export function intensity(profit: number): 0 | 1 | 2 {
  const abs = Math.abs(profit);
  if (abs === 0) return 0;
  if (abs < 1500) return 1;
  return 2;
}

type Tone = 'none' | 'flat' | 'profit' | 'profit-strong' | 'loss' | 'loss-strong';

export function dayTone(profit: number | undefined): Tone {
  if (profit === undefined) return 'none';
  const abs = Math.abs(profit);
  if (abs === 0) return 'flat';
  if (profit > 0) return abs < 500 ? 'profit' : 'profit-strong';
  return abs < 500 ? 'loss' : 'loss-strong';
}
