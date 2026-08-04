import { ChevronUp, X, Settings2 } from 'lucide-react';
import type { Side, OrdType, Position } from '../../types';

interface BottomPanelProps {
  balance: number;
  equity: number;
  currentPrice: number;
  sessionActive: boolean;
  openPositions: Position[];
  quantity: number;
  onSetQuantity: (qty: number) => void;
  onPlaceOrder: (order: {
    side: Side;
    type: OrdType;
    quantity: number;
    entry_price: number;
    stop_loss: number;
    take_profit: number;
  }) => void;
  onClosePosition: (positionId: number) => void;
  onCancelOrder: (orderId: number) => void;
  onToggleOrderPanel?: () => void;
  showHistory?: boolean;
  onToggleHistory?: () => void;
  lightMode: boolean;
}

export function BottomPanel({
  balance,
  equity,
  currentPrice,
  sessionActive,
  openPositions,
  quantity,
  onSetQuantity,
  onPlaceOrder,
  onClosePosition,
  onToggleOrderPanel,
  showHistory,
  onToggleHistory,
  lightMode,
}: BottomPanelProps) {
  const unrealizedPnl = equity - balance;

  const handleQuickOrder = (side: Side) => {
    if (!sessionActive || currentPrice === 0 || quantity <= 0) return;
    onPlaceOrder({
      side,
      type: 'market',
      quantity,
      entry_price: currentPrice,
      stop_loss: 0,
      take_profit: 0,
    });
  };

  return (
    <div className={`flex h-10 items-center justify-between border-t px-3 ${lightMode ? 'bg-white border-gray-200' : 'bg-[#121416] border-[#2a2e39]'}`}>
      <div className="flex items-center gap-2">
        {/* Buy button */}
        <button
          onClick={() => handleQuickOrder('buy')}
          disabled={!sessionActive}
          className="rounded bg-[#2e9461] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#2e9461]/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Buy
        </button>

        {/* Sell button */}
        <button
          onClick={() => handleQuickOrder('sell')}
          disabled={!sessionActive}
          className="rounded bg-[#ef5350] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#ef5350]/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Sell
        </button>

        {/* Quantity input */}
        <div className={`flex items-center gap-1.5 rounded border px-2 py-1 ${lightMode ? 'border-gray-300 bg-gray-50' : 'border-[#363a45] bg-[#1e222d]'}`}>
          <label className={`text-[10px] uppercase tracking-wide ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>Qty</label>
          <input
            type="number"
            value={quantity}
            onChange={(e) => onSetQuantity(Math.max(0, Number(e.target.value)))}
            min={1}
            step={1}
            className={`w-14 bg-transparent text-xs font-mono text-right outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}
          />
        </div>

        {/* Price display */}
        <div className={`flex items-center gap-2 rounded border px-2 py-1 ${lightMode ? 'border-gray-300 bg-gray-50' : 'border-[#363a45] bg-[#1e222d]'}`}>
          <span className={`text-[10px] ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>@</span>
          <span className={`text-xs font-mono ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
            {currentPrice > 0 ? currentPrice.toFixed(2) : '—'}
          </span>
        </div>

        {/* Advanced order panel toggle */}
        {onToggleOrderPanel && (
          <button
            onClick={onToggleOrderPanel}
            title="Advanced Order Settings"
            className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors ${lightMode ? 'border-gray-300 bg-gray-50 text-gray-600 hover:text-gray-900 hover:border-accent-blue/50' : 'border-[#363a45] bg-[#1e222d] text-[#787b86] hover:text-[#d1d4dc] hover:border-accent-blue/50'}`}
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span>Order</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-5 text-xs">
        {/* Account Balance */}
        <div className="flex items-center gap-1.5">
          <span className={lightMode ? 'text-gray-600' : 'text-[#787b86]'}>Balance:</span>
          <span className={`font-mono ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>

        {/* Equity */}
        <div className="flex items-center gap-1.5">
          <span className={lightMode ? 'text-gray-600' : 'text-[#787b86]'}>Equity:</span>
          <span className={`font-mono ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>

        {/* Unrealized PnL */}
        <div className="flex items-center gap-1.5">
          <span className={lightMode ? 'text-gray-600' : 'text-[#787b86]'}>Unrealized:</span>
          <span className={`font-mono ${unrealizedPnl >= 0 ? 'text-[#2e9461]' : 'text-[#ef5350]'}`}>
            {unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toFixed(2)}
          </span>
        </div>

        {/* Open positions count + close all */}
        {openPositions.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className={lightMode ? 'text-gray-600' : 'text-[#787b86]'}>Positions:</span>
            <span className={`font-mono ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>{openPositions.length}</span>
            <button
              onClick={() => openPositions.forEach((p) => onClosePosition(p.id))}
              title="Close all positions"
              className="ml-1 flex items-center gap-0.5 rounded border border-[#ef5350]/30 px-1.5 py-0.5 text-[10px] text-[#ef5350] hover:bg-[#ef5350]/10 transition-colors"
            >
              <X className="h-3 w-3" />
              Close All
            </button>
          </div>
        )}

        {/* Trade history toggle */}
        <button
          onClick={onToggleHistory}
          title={showHistory ? 'Hide trade history' : 'Show trade history'}
          className={`flex items-center gap-1 transition-colors ${
            showHistory ? 'text-[#3b6fff]' : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
          }`}
        >
          <ChevronUp className={`h-4 w-4 transition-transform ${showHistory ? '' : 'rotate-180'}`} />
          <span className="text-[10px]">History</span>
        </button>
      </div>
    </div>
  );
}
