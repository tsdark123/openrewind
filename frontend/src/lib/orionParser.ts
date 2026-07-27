import type { ActiveSessionTrade, CloseReason, ClosedTrade, PerformanceLog, Position, SessionRecord, TradeLog } from '../types';
import { aggregateTrades, getRecordTrades } from './journal';

export interface LiveContext {
  symbol: string;
  replayDate: string;
  sessionActive: boolean;
  currentPrice: number;
  balance: number;
  equity: number;
  openPositions: Position[];
  activeSessionTrades: ActiveSessionTrade[];
  tradeHistory: ClosedTrade[];
}

// Never coerce a foreign trade to the currently-loaded ticker. If a trade
// record does not carry its own symbol, mark it explicitly as unknown so
// Orion cannot silently mislabel it as the active symbol during context
// prompt generation (this was the root cause of cross-symbol answers).
function tradeSymbol(t: TradeLog | ClosedTrade, fallback: string): string {
  if ('symbol' in t && t.symbol) return t.symbol;
  return fallback || '?';
}

function exitTimestamp(t: TradeLog | ClosedTrade): number {
  return 'exitTime' in t ? t.exitTime : (t as ClosedTrade).closed_at;
}

function realizedPnl(t: TradeLog | ClosedTrade): number {
  return 'realizedPnl' in t ? t.realizedPnl : (t as ClosedTrade).realized_pnl;
}

function sideLabel(t: TradeLog | ClosedTrade): string {
  return 'action' in t ? t.action : (t as ClosedTrade).side.toUpperCase();
}

function entryPrice(t: TradeLog | ClosedTrade): number {
  if ('entryPrice' in t) return (t as TradeLog).entryPrice;
  return (t as ClosedTrade).entry_price;
}

function exitPrice(t: TradeLog | ClosedTrade): number {
  if ('exitPrice' in t) return (t as TradeLog).exitPrice;
  return (t as ClosedTrade).exit_price;
}

function quantity(t: TradeLog | ClosedTrade): number {
  return 'quantity' in t ? t.quantity : 0;
}

function tradeReason(t: TradeLog | ClosedTrade): CloseReason | undefined {
  if ('reason' in t) return (t as ClosedTrade).reason;
  return undefined;
}

function reasonLabel(reason?: CloseReason): string {
  switch (reason) {
    case 'sl':
      return 'stop loss';
    case 'tp':
      return 'take profit';
    case 'manual':
      return 'manual';
    default:
      return reason ? String(reason) : 'unknown';
  }
}

function formatDollars(value: number, withSign = false): string {
  const sign = withSign ? (value > 0 ? '+' : value < 0 ? '-' : '') : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function positionPnl(p: Position, currentPrice: number): number {
  const diff = currentPrice - p.entry_price;
  return p.side === 'buy' ? diff * p.quantity : -diff * p.quantity;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatJournalMoney(value: number, withSign = false): string {
  const abs = Math.abs(value);
  const sign = withSign && value !== 0 ? (value > 0 ? '+' : '-') : '';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatTrade(t: TradeLog | ClosedTrade, fallbackSymbol: string): string {
  const symbol = tradeSymbol(t, fallbackSymbol);
  const side = sideLabel(t);
  const qty = quantity(t);
  const entry = entryPrice(t);
  const exit = exitPrice(t);
  const pnl = realizedPnl(t);
  const reason = tradeReason(t);
  const ts = exitTimestamp(t);
  const parts = [
    `${symbol} ${side} ${qty} @ ${formatDollars(entry)} → ${formatDollars(exit)}`,
    `realized ${formatDollars(pnl, true)}`,
  ];
  if (reason) parts.push(`reason: ${reasonLabel(reason)}`);
  parts.push(`time ${formatTime(ts)}`);
  return parts.join(', ');
}

function findLatestTrade(
  liveTrades: ActiveSessionTrade[],
  journalTrades: (TradeLog | ClosedTrade)[]
): TradeLog | ClosedTrade | ActiveSessionTrade | undefined {
  const all = [...liveTrades, ...journalTrades];
  if (all.length === 0) return undefined;
  return all.reduce((latest, t) => (exitTimestamp(t) > exitTimestamp(latest) ? t : latest));
}

export function generateOrionContextPrompt(performanceLog: PerformanceLog, live: LiveContext): string {
  const liveLines: string[] = [];

  liveLines.push(
    `Currently replaying ${live.symbol} on ${live.replayDate}. Session active: ${live.sessionActive ? 'yes' : 'no'}. Current price ${formatDollars(live.currentPrice)}. Balance ${formatDollars(live.balance)} / Equity ${formatDollars(live.equity)}.`
  );

  if (live.openPositions.length === 0) {
    liveLines.push('No open position.');
  } else {
    liveLines.push('Open positions:');
    for (const p of live.openPositions) {
      const pnl = positionPnl(p, live.currentPrice);
      liveLines.push(
        `${p.side.toUpperCase()} ${p.quantity} ${live.symbol} @ ${formatDollars(p.entry_price)}, unrealized ${formatDollars(pnl, true)}, SL ${formatDollars(p.stop_loss)}, TP ${formatDollars(p.take_profit)}`
      );
    }
  }

  const sessionTrades = [...live.activeSessionTrades].sort((a, b) => b.closed_at - a.closed_at).slice(0, 5);
  if (sessionTrades.length === 0) {
    liveLines.push('No trades closed in this session yet.');
  } else {
    liveLines.push('Trades closed this session (most recent first):');
    for (const t of sessionTrades) {
      liveLines.push(`- ${formatTrade(t, live.symbol)}`);
    }
  }

  const records: SessionRecord[] = Object.values(performanceLog).flat();
  const journalLines: string[] = [];
  let allJournalTrades: (TradeLog | ClosedTrade)[] = [];

  if (records.length > 0) {
    allJournalTrades = records.flatMap((r) => getRecordTrades(r));
    if (allJournalTrades.length > 0) {
      const global = aggregateTrades(allJournalTrades);
      const bySymbol: Record<string, (TradeLog | ClosedTrade)[]> = {};
      for (const r of records) {
        for (const t of getRecordTrades(r)) {
          const symbol = tradeSymbol(t, r.symbol);
          if (!bySymbol[symbol]) bySymbol[symbol] = [];
          bySymbol[symbol].push(t);
        }
      }

      const assetLines = Object.keys(bySymbol)
        .sort((a, b) => a.localeCompare(b))
        .map((symbol) => {
          const stats = aggregateTrades(bySymbol[symbol]);
          return `${symbol}: ${stats.trades} trades, WinRate ${stats.winRate}%, Net P&L: ${formatJournalMoney(stats.profit, true)}, Avg R: ${stats.rMultiple.toFixed(2)}R`;
        });

      const recentTrades = allJournalTrades
        .slice()
        .sort((a, b) => exitTimestamp(b) - exitTimestamp(a))
        .slice(0, 5)
        .map((t) => formatTrade(t, '—'))
        .join(' | ');

      journalLines.push(
        '',
        'Lifetime journal (saved sessions):',
        `Total Trades: ${global.trades} | WinRate: ${global.winRate}% | Net P&L: ${formatJournalMoney(global.profit, true)} | Avg R: ${global.rMultiple.toFixed(2)}R`,
        '',
        'Assets:',
        ...assetLines.map((line) => `- ${line}`),
        '',
        `Recent Activity (last 5): ${recentTrades}`
      );
    } else {
      journalLines.push('', 'Lifetime journal exists but has no closed trades.');
    }
  } else {
    journalLines.push('', 'No completed sessions in the saved journal yet.');
  }

  const latest = findLatestTrade(live.activeSessionTrades, allJournalTrades);
  const latestLine = latest
    ? `Latest closed trade overall: ${formatTrade(latest, live.symbol)}`
    : 'Latest closed trade overall: none yet.';

  return [
    'Live telemetry (what is happening right now):',
    '',
    ...liveLines,
    '',
    latestLine,
    ...journalLines,
  ].join('\n');
}
