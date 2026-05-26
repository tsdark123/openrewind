import { X, Trash2 } from 'lucide-react';
import type { ClosedTrade } from '../../types';

interface TradeHistoryDrawerProps {
  trades: ClosedTrade[];
  onClearHistory: () => void;
  onClose: () => void;
  lightMode: boolean;
}

function formatTs(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TradeHistoryDrawer({ trades, onClearHistory, onClose, lightMode }: TradeHistoryDrawerProps) {
  const totalPnl = trades.reduce((sum, t) => sum + t.realized_pnl, 0);

  return (
    <div className={`border-t animate-in slide-in-from-bottom duration-200 ${lightMode ? 'border-gray-200 bg-white' : 'border-[#2a2e39] bg-[#121416]'}`}>
      {/* Header */}
      <div className={`flex items-center justify-between border-b px-4 py-2 ${lightMode ? 'border-gray-200' : 'border-[#2a2e39]'}`}>
        <div className="flex items-center gap-4">
          <h3 className={`text-xs font-medium ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>Position History</h3>
          <span className={`text-[10px] ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>{trades.length} trades</span>
          <span className={`text-[11px] font-mono ${totalPnl >= 0 ? 'text-[#2e9461]' : 'text-[#ef5350]'}`}>
            Total: {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onClearHistory}
            title="Clear trade history"
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] transition-colors ${lightMode ? 'text-gray-600 hover:text-red-600 hover:bg-red-50' : 'text-[#787b86] hover:text-[#ef5350] hover:bg-[#ef5350]/10'}`}
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
          <button
            onClick={onClose}
            className={`transition-colors ${lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="max-h-48 overflow-y-auto">
        {trades.length === 0 ? (
          <div className={`flex items-center justify-center py-6 text-xs ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
            No closed trades yet
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className={`border-b text-[10px] uppercase tracking-wider ${lightMode ? 'border-gray-200 text-gray-600' : 'border-[#2a2e39] text-[#787b86]'}`}>
                <th className="px-3 py-1.5 text-left font-medium">#</th>
                <th className="px-3 py-1.5 text-left font-medium">Side</th>
                <th className="px-3 py-1.5 text-right font-medium">Entry</th>
                <th className="px-3 py-1.5 text-right font-medium">Exit</th>
                <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                <th className="px-3 py-1.5 text-right font-medium">PnL</th>
                <th className="px-3 py-1.5 text-center font-medium">Reason</th>
                <th className="px-3 py-1.5 text-right font-medium">Opened</th>
                <th className="px-3 py-1.5 text-right font-medium">Closed</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade, idx) => (
                <tr
                  key={trade.id}
                  className={`border-b transition-colors ${lightMode ? 'border-gray-100 hover:bg-gray-50' : 'border-[#1e222d] hover:bg-[#1e222d]/50'}`}
                >
                  <td className={`px-3 py-1.5 font-mono ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>{idx + 1}</td>
                  <td className="px-3 py-1.5">
                    <span className={`font-medium ${trade.side === 'buy' ? 'text-[#2e9461]' : 'text-[#ef5350]'}`}>
                      {trade.side === 'buy' ? 'BUY' : 'SELL'}
                    </span>
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
                    {trade.entry_price.toFixed(2)}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
                    {trade.exit_price.toFixed(2)}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
                    {trade.quantity}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono font-medium ${
                    trade.realized_pnl >= 0 ? 'text-[#2e9461]' : 'text-[#ef5350]'
                  }`}>
                    {trade.realized_pnl >= 0 ? '+' : ''}{trade.realized_pnl.toFixed(2)}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${
                      trade.reason === 'sl'
                        ? 'bg-[#ef5350]/10 text-[#ef5350]'
                        : trade.reason === 'tp'
                        ? 'bg-[#2e9461]/10 text-[#2e9461]'
                        : 'bg-[#2962ff]/10 text-[#2962ff]'
                    }`}>
                      {trade.reason === 'sl' ? 'Stop Loss' : trade.reason === 'tp' ? 'Take Profit' : 'Manual'}
                    </span>
                  </td>
                  <td className={`px-3 py-1.5 text-right ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
                    {formatTs(trade.opened_at)}
                  </td>
                  <td className={`px-3 py-1.5 text-right ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
                    {formatTs(trade.closed_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
