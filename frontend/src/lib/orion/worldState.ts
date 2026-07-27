// =============================================================================
// worldState — Canonical snapshot of "everything Orion needs to know right now".
//
// Every Orion prompt and every tool that needs "what's the current state?"
// consumes this one object so we cannot drift from what the user actually
// sees. It is built on demand from React state + the imperative Chart handle
// (for candle context) + the persisted journal. There is intentionally no
// caching: the cost is trivial and staleness would be catastrophic during
// autonomous execution.
// =============================================================================

import type {
  ActiveSessionTrade,
  AppState,
  CandleData,
  ClosedTrade,
  PerformanceLog,
  Position,
  Order,
} from '../../types';
import type { ChartHandle } from '../../components/Chart';
import { aggregateTrades, getRecordTrades } from '../journal';

export interface WorldSession {
  symbol: string;
  date: string;
  timeframe: number;
  cursor: number;
  totalCandles: number;
  isPlaying: boolean;
  speed: number;
  direction: 'forward' | 'backward';
  currentPrice: number;
  sessionActive: boolean;
}

export interface WorldAccount {
  balance: number;
  equity: number;
  openPositions: Position[];
  pendingOrders: Order[];
}

export interface WorldIndicators {
  ema20: boolean;
  sma50: boolean;
  bollinger: boolean;
  rsi: boolean;
  macd: boolean;
  atr: boolean;
  stochastic: boolean;
}

export interface WorldJournalSummary {
  totalTrades: number;
  winRatePct: number;
  netProfit: number;
  avgR: number;
  bySymbol: Array<{ symbol: string; trades: number; winRatePct: number; netProfit: number }>;
}

export interface WorldState {
  session: WorldSession;
  account: WorldAccount;
  indicators: WorldIndicators;
  // Chronologically ordered slice of the visible chart history. Bounded by
  // `recentCandleLimit` in the builder options (default 100) so the payload
  // stays cheap even when the user has streamed hours of 1-minute data.
  recentCandles: CandleData[];
  // Live session P&L view — the trades that closed during THIS replay run.
  activeSessionTrades: ActiveSessionTrade[];
  // Ephemeral in-session trade history straight from the reducer. Same
  // symbol as `session.symbol`.
  tradeHistory: ClosedTrade[];
  // Aggregated view of everything saved across prior sessions.
  journalSummary: WorldJournalSummary;
  // Wall-clock timestamp of when this snapshot was built (epoch ms).
  builtAt: number;
}

export interface BuildWorldStateOptions {
  recentCandleLimit?: number;
}

export function buildWorldState(
  state: AppState,
  chartRef: { current: ChartHandle | null } | null,
  performanceLog: PerformanceLog,
  options: BuildWorldStateOptions = {}
): WorldState {
  const recentCandleLimit = options.recentCandleLimit ?? 100;

  const recentCandles = chartRef?.current
    ? chartRef.current.getRecentCandles(recentCandleLimit)
    : [];

  return {
    session: {
      symbol: state.symbol,
      date: state.replayDate,
      timeframe: state.timeframe,
      cursor: state.cursor,
      totalCandles: state.totalCandles,
      isPlaying: state.isPlaying,
      speed: state.speed,
      direction: state.playbackDirection,
      currentPrice: state.currentPrice,
      sessionActive: state.sessionActive,
    },
    account: {
      balance: state.balance,
      equity: state.equity,
      openPositions: state.openPositions,
      pendingOrders: state.pendingOrders,
    },
    indicators: { ...state.indicators },
    recentCandles,
    activeSessionTrades: state.activeSessionTrades,
    tradeHistory: state.tradeHistory,
    journalSummary: summarizeJournal(performanceLog),
    builtAt: Date.now(),
  };
}

// -----------------------------------------------------------------------------
// Journal aggregation — kept here (not in journal.ts) because this shape is
// specific to Orion prompts. journal.ts stays focused on the storage model.
// -----------------------------------------------------------------------------

function summarizeJournal(log: PerformanceLog): WorldJournalSummary {
  const records = Object.values(log).flat();
  if (records.length === 0) {
    return { totalTrades: 0, winRatePct: 0, netProfit: 0, avgR: 0, bySymbol: [] };
  }

  const allTrades = records.flatMap((r) => getRecordTrades(r));
  const global = aggregateTrades(allTrades);

  // Per-symbol rollup so Orion can answer "how has AAPL been going?" from a
  // single field instead of scanning the whole journal every time.
  const bySymbolMap = new Map<string, ClosedTrade[] | Array<ReturnType<typeof getRecordTrades>[number]>>();
  for (const rec of records) {
    for (const t of getRecordTrades(rec)) {
      const symbol = 'symbol' in t && t.symbol ? t.symbol : rec.symbol;
      const bucket = (bySymbolMap.get(symbol) as any[]) ?? [];
      bucket.push(t);
      bySymbolMap.set(symbol, bucket as any);
    }
  }

  const bySymbol = Array.from(bySymbolMap.entries())
    .map(([symbol, trades]) => {
      const stats = aggregateTrades(trades as any);
      return {
        symbol,
        trades: stats.trades,
        winRatePct: stats.winRate,
        netProfit: stats.profit,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    totalTrades: global.trades,
    winRatePct: global.winRate,
    netProfit: global.profit,
    avgR: global.rMultiple,
    bySymbol,
  };
}

// -----------------------------------------------------------------------------
// Human-readable snapshot renderer — used to inject the WorldState into a
// chat system prompt. Terser than the previous generateOrionContextPrompt,
// and stable across symbol switches because per-symbol data is presented
// under labeled sections instead of coerced onto the currently-loaded ticker.
// -----------------------------------------------------------------------------

function money(v: number, withSign = false): string {
  const abs = Math.abs(v);
  const sign = withSign && v !== 0 ? (v > 0 ? '+' : '-') : '';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function renderWorldStateForPrompt(w: WorldState): string {
  const lines: string[] = [];

  lines.push('SESSION');
  if (w.session.sessionActive && w.session.symbol) {
    lines.push(
      `- Symbol: ${w.session.symbol} · Date: ${w.session.date || '(none)'} · TF: ${w.session.timeframe}m`
    );
    lines.push(
      `- Cursor: ${w.session.cursor}/${w.session.totalCandles} · Playing: ${w.session.isPlaying ? 'yes' : 'no'} @ ${w.session.speed}x (${w.session.direction})`
    );
    lines.push(`- Current price: ${money(w.session.currentPrice)}`);
  } else {
    lines.push('- No active session.');
  }

  lines.push('');
  lines.push('ACCOUNT');
  lines.push(`- Balance ${money(w.account.balance)} · Equity ${money(w.account.equity)}`);
  if (w.account.openPositions.length === 0) {
    lines.push('- No open positions.');
  } else {
    for (const p of w.account.openPositions) {
      const unreal = w.session.currentPrice
        ? (w.session.currentPrice - p.entry_price) * p.quantity * (p.side === 'buy' ? 1 : -1)
        : 0;
      lines.push(
        `- ${p.side.toUpperCase()} ${p.quantity} @ ${money(p.entry_price)} · SL ${money(p.stop_loss)} · TP ${money(p.take_profit)} · unrealized ${money(unreal, true)}`
      );
    }
  }

  const activeIndicators = Object.entries(w.indicators)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (activeIndicators.length > 0) {
    lines.push('');
    lines.push(`INDICATORS: ${activeIndicators.join(', ')}`);
  }

  lines.push('');
  lines.push('SESSION TRADES (most recent first, up to 5):');
  const recentSessionTrades = [...w.activeSessionTrades]
    .sort((a, b) => b.closed_at - a.closed_at)
    .slice(0, 5);
  if (recentSessionTrades.length === 0) {
    lines.push('- (none closed yet this session)');
  } else {
    for (const t of recentSessionTrades) {
      lines.push(
        `- ${t.symbol} ${t.date} ${t.side.toUpperCase()} ${t.quantity} @ ${money(t.entry_price)} → ${money(t.exit_price)}, P&L ${money(t.realized_pnl, true)} (${t.reason})`
      );
    }
  }

  lines.push('');
  lines.push('LIFETIME JOURNAL:');
  if (w.journalSummary.totalTrades === 0) {
    lines.push('- No prior sessions saved.');
  } else {
    lines.push(
      `- Total ${w.journalSummary.totalTrades} trades · WinRate ${w.journalSummary.winRatePct}% · Net ${money(w.journalSummary.netProfit, true)} · Avg R ${w.journalSummary.avgR.toFixed(2)}`
    );
    for (const s of w.journalSummary.bySymbol) {
      lines.push(
        `  · ${s.symbol}: ${s.trades} trades, ${s.winRatePct}% wins, Net ${money(s.netProfit, true)}`
      );
    }
  }

  return lines.join('\n');
}
