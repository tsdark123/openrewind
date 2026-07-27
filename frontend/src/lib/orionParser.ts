import type { ClosedTrade, PerformanceLog, SessionRecord, TradeLog } from '../types';
import { aggregateTrades, formatMoney, getRecordTrades } from './journal';

function tradeSymbol(t: TradeLog | ClosedTrade, fallback: string): string {
  return 'symbol' in t && t.symbol ? t.symbol : fallback;
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

export function generateOrionContextPrompt(performanceLog: PerformanceLog): string {
  const records: SessionRecord[] = Object.values(performanceLog).flat();
  if (records.length === 0) {
    return 'No completed trading sessions are in the journal yet. Start and end a session to build a performance log.';
  }

  const allTrades = records.flatMap((r) => getRecordTrades(r));
  if (allTrades.length === 0) {
    return 'Trading sessions exist, but no closed trades were recorded.';
  }

  const global = aggregateTrades(allTrades);

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
      return `${symbol}: ${stats.trades} trades, WinRate ${stats.winRate}%, Net P&L: ${formatMoney(stats.profit, true)}, Avg R: ${stats.rMultiple.toFixed(2)}R`;
    });

  const recentTrades = allTrades
    .slice()
    .sort((a, b) => exitTimestamp(b) - exitTimestamp(a))
    .slice(0, 5)
    .map((t) => {
      const symbol = tradeSymbol(t, '—');
      const pnl = realizedPnl(t);
      const side = sideLabel(t);
      return `${symbol} ${side} ${formatMoney(pnl, true)}`;
    })
    .join(' | ');

  return [
    'OpenRewind Trading Telemetry (lifetime, as of latest saved session)',
    `Total Trades: ${global.trades} | WinRate: ${global.winRate}% | Net P&L: ${formatMoney(global.profit, true)} | Avg R: ${global.rMultiple.toFixed(2)}R`,
    '',
    'Assets:',
    ...assetLines.map((line) => `- ${line}`),
    '',
    `Recent Activity (last 5): ${recentTrades}`,
  ].join('\n');
}
