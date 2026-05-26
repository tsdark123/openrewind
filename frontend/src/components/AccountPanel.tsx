import { useState } from 'react';
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  History,
  BarChart3,
  X,
} from 'lucide-react';
import type { Position, ClosedTrade } from '../types';

// =============================================================================
// AccountPanel — Sidebar section displaying account metrics, open positions,
// and closed trade history.
// =============================================================================

interface AccountPanelProps {
  balance: number;
  equity: number;
  openPositions: Position[];
  tradeHistory: ClosedTrade[];
  currentPrice: number;
  sessionActive: boolean;
  onClosePosition: (positionId: number) => void;
  onCancelOrder: (orderId: number) => void;
}

type Tab = 'positions' | 'history';

export function AccountPanel({
  balance,
  equity,
  openPositions,
  tradeHistory,
  currentPrice,
  sessionActive,
  onClosePosition,
}: AccountPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('positions');

  const unrealizedPnl = equity - balance;
  const totalRealizedPnl = tradeHistory.reduce(
    (sum, t) => sum + t.realized_pnl,
    0
  );

  const pnlColor = (v: number) =>
    v > 0 ? 'text-accent-buy' : v < 0 ? 'text-accent-sell' : 'text-gray-400';

  const formatPnl = (v: number) => {
    const prefix = v > 0 ? '+' : '';
    return `${prefix}${v.toFixed(2)}`;
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Account Metrics */}
      <div className="grid grid-cols-2 gap-2 p-3 border-b border-panel-border">
        {/* Balance */}
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1 text-[10px] text-gray-500 uppercase tracking-wider">
            <Wallet size={10} />
            Balance
          </div>
          <span className="text-sm font-semibold font-mono tabular-nums">
            ${sessionActive ? balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
          </span>
        </div>

        {/* Equity */}
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1 text-[10px] text-gray-500 uppercase tracking-wider">
            <BarChart3 size={10} />
            Equity
          </div>
          <span className={`text-sm font-semibold font-mono tabular-nums ${sessionActive ? pnlColor(unrealizedPnl) : ''}`}>
            ${sessionActive ? equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
          </span>
        </div>

        {/* Open P&L */}
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1 text-[10px] text-gray-500 uppercase tracking-wider">
            {unrealizedPnl >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
            Open P&L
          </div>
          <span className={`text-sm font-semibold font-mono tabular-nums ${pnlColor(unrealizedPnl)}`}>
            {sessionActive ? formatPnl(unrealizedPnl) : '—'}
          </span>
        </div>

        {/* Realized P&L */}
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1 text-[10px] text-gray-500 uppercase tracking-wider">
            <History size={10} />
            Realized
          </div>
          <span className={`text-sm font-semibold font-mono tabular-nums ${pnlColor(totalRealizedPnl)}`}>
            {sessionActive ? formatPnl(totalRealizedPnl) : '—'}
          </span>
        </div>
      </div>

      {/* Tab Header */}
      <div className="flex border-b border-panel-border">
        <button
          onClick={() => setActiveTab('positions')}
          className={`flex-1 py-2 text-xs font-medium text-center transition-colors ${
            activeTab === 'positions'
              ? 'text-white border-b-2 border-accent-blue'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Positions ({openPositions.length})
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`flex-1 py-2 text-xs font-medium text-center transition-colors ${
            activeTab === 'history'
              ? 'text-white border-b-2 border-accent-blue'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          History ({tradeHistory.length})
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'positions' && (
          <div className="flex flex-col">
            {openPositions.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-xs text-gray-600">
                No open positions
              </div>
            ) : (
              openPositions.map((pos) => {
                const pnl =
                  pos.side === 'buy'
                    ? (currentPrice - pos.entry_price) * pos.quantity
                    : (pos.entry_price - currentPrice) * pos.quantity;

                return (
                  <div
                    key={pos.id}
                    className="flex flex-col gap-1.5 p-3 border-b border-panel-border/50 hover:bg-panel-hover/30 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                            pos.side === 'buy'
                              ? 'bg-accent-buy/20 text-accent-buy'
                              : 'bg-accent-sell/20 text-accent-sell'
                          }`}
                        >
                          {pos.side}
                        </span>
                        <span className="text-xs text-gray-400 font-mono">
                          #{pos.id}
                        </span>
                      </div>
                      <button
                        onClick={() => onClosePosition(pos.id)}
                        className="p-1 rounded hover:bg-accent-sell/20 text-gray-500 hover:text-accent-sell transition-colors"
                        title="Close position"
                      >
                        <X size={12} />
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-1 text-[10px]">
                      <div>
                        <span className="text-gray-600">Entry</span>
                        <div className="font-mono text-gray-300">
                          {pos.entry_price.toFixed(2)}
                        </div>
                      </div>
                      <div>
                        <span className="text-gray-600">Qty</span>
                        <div className="font-mono text-gray-300">
                          {pos.quantity}
                        </div>
                      </div>
                      <div>
                        <span className="text-gray-600">P&L</span>
                        <div className={`font-mono font-semibold ${pnlColor(pnl)}`}>
                          {formatPnl(pnl)}
                        </div>
                      </div>
                    </div>

                    {(pos.stop_loss > 0 || pos.take_profit > 0) && (
                      <div className="flex gap-3 text-[10px]">
                        {pos.stop_loss > 0 && (
                          <span className="text-accent-sell font-mono">
                            SL {pos.stop_loss.toFixed(2)}
                          </span>
                        )}
                        {pos.take_profit > 0 && (
                          <span className="text-accent-buy font-mono">
                            TP {pos.take_profit.toFixed(2)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div className="flex flex-col">
            {tradeHistory.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-xs text-gray-600">
                No closed trades
              </div>
            ) : (
              [...tradeHistory].reverse().map((trade) => (
                <div
                  key={`${trade.id}-${trade.closed_at}`}
                  className="flex flex-col gap-1 p-3 border-b border-panel-border/50"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                          trade.side === 'buy'
                            ? 'bg-accent-buy/20 text-accent-buy'
                            : 'bg-accent-sell/20 text-accent-sell'
                        }`}
                      >
                        {trade.side}
                      </span>
                      <span className="text-[10px] text-gray-500 uppercase font-medium">
                        {trade.reason === 'sl'
                          ? 'Stop Loss'
                          : trade.reason === 'tp'
                            ? 'Take Profit'
                            : 'Manual'}
                      </span>
                    </div>
                    <span
                      className={`text-xs font-mono font-semibold ${pnlColor(trade.realized_pnl)}`}
                    >
                      {formatPnl(trade.realized_pnl)}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-1 text-[10px]">
                    <div>
                      <span className="text-gray-600">Entry</span>
                      <div className="font-mono text-gray-400">
                        {trade.entry_price.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-600">Exit</span>
                      <div className="font-mono text-gray-400">
                        {trade.exit_price.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-600">Qty</span>
                      <div className="font-mono text-gray-400">
                        {trade.quantity}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
