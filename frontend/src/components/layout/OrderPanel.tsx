import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { Side, OrdType } from '../../types';

interface OrderPanelProps {
  currentPrice: number;
  sessionActive: boolean;
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
  onClose: () => void;
  onSLChange?: (price: number) => void;
  onTPChange?: (price: number) => void;
  externalSL?: number;
  externalTP?: number;
  draggedPositionSL?: number;
  draggedPositionTP?: number;
  openPositions?: any[];
  onPositionSLTPUpdate?: (sl: number, tp: number) => void;
  onUnlockPositionSL?: () => void;
  onLockPositionSL?: () => void;
  onUnlockPositionTP?: () => void;
  onLockPositionTP?: () => void;
  lightMode: boolean;
}

export function OrderPanel({
  currentPrice,
  sessionActive,
  quantity,
  onSetQuantity,
  onPlaceOrder,
  onClose,
  onSLChange,
  onTPChange,
  externalSL,
  externalTP,
  draggedPositionSL,
  draggedPositionTP,
  openPositions = [],
  onPositionSLTPUpdate,
  onUnlockPositionSL,
  onLockPositionSL,
  onUnlockPositionTP,
  onLockPositionTP,
  lightMode,
}: OrderPanelProps) {
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [side, setSide] = useState<Side>('buy');
  const [entryPrice, setEntryPrice] = useState(0);
  const [slEnabled, setSlEnabled] = useState(false);
  const [tpEnabled, setTpEnabled] = useState(false);
  const [stopLoss, setStopLoss] = useState(0);
  const [takeProfit, setTakeProfit] = useState(0);
  const [slModified, setSlModified] = useState(false);
  const [tpModified, setTpModified] = useState(false);

  // Determine if we should show "Update" or "+Add"
  const hasOpenPositions = openPositions.length > 0;

  // Sync external SL/TP changes from chart drag to local state
  useEffect(() => {
    if (externalSL !== undefined && externalSL > 0) {
      setStopLoss(externalSL);
      setSlEnabled(true);
      // Set modified flag when dragging to show Confirm button
      if (hasOpenPositions) {
        setSlModified(true);
      }
    }
  }, [externalSL, hasOpenPositions]);

  useEffect(() => {
    if (externalTP !== undefined && externalTP > 0) {
      setTakeProfit(externalTP);
      setTpEnabled(true);
      // Set modified flag when dragging to show Confirm button
      if (hasOpenPositions) {
        setTpModified(true);
      }
    }
  }, [externalTP, hasOpenPositions]);

  // Sync dragged position SL/TP from chart drag to trigger Confirm button
  useEffect(() => {
    if (draggedPositionSL !== undefined && draggedPositionSL > 0 && hasOpenPositions) {
      setStopLoss(draggedPositionSL);
      setSlEnabled(true);
      setSlModified(true);
    } else if (draggedPositionSL === 0 || !hasOpenPositions) {
      // Reset when trade ends or dragged value is cleared
      setSlModified(false);
    }
  }, [draggedPositionSL, hasOpenPositions]);

  useEffect(() => {
    if (draggedPositionTP !== undefined && draggedPositionTP > 0 && hasOpenPositions) {
      setTakeProfit(draggedPositionTP);
      setTpEnabled(true);
      setTpModified(true);
    } else if (draggedPositionTP === 0 || !hasOpenPositions) {
      // Reset when trade ends or dragged value is cleared
      setTpModified(false);
    }
  }, [draggedPositionTP, hasOpenPositions]);

  // Notify parent when SL/TP changes (for chart lines)
  const handleStopLossChange = (value: number) => {
    setStopLoss(value);
    if (hasOpenPositions) {
      setSlModified(true);
    } else if (onSLChange) {
      // Only for new orders
      onSLChange(value);
    }
  };

  const handleTakeProfitChange = (value: number) => {
    setTakeProfit(value);
    if (hasOpenPositions) {
      setTpModified(true);
    } else if (onTPChange) {
      // Only for new orders
      onTPChange(value);
    }
  };

  const confirmSLUpdate = () => {
    if (hasOpenPositions && onPositionSLTPUpdate) {
      const pos = openPositions[0];
      onPositionSLTPUpdate(stopLoss, pos.take_profit || 0);
      setSlModified(false);
      // Lock SL after confirming
      if (onLockPositionSL) onLockPositionSL();
    }
  };

  const confirmTPUpdate = () => {
    if (hasOpenPositions && onPositionSLTPUpdate) {
      const pos = openPositions[0];
      onPositionSLTPUpdate(pos.stop_loss || 0, takeProfit);
      setTpModified(false);
      // Lock TP after confirming
      if (onLockPositionTP) onLockPositionTP();
    }
  };

  const handleSubmit = () => {
    if (!sessionActive || quantity <= 0) return;
    const price = orderType === 'market' ? currentPrice : entryPrice;
    if (price <= 0) return;

    onPlaceOrder({
      side,
      type: orderType,
      quantity,
      entry_price: price,
      stop_loss: slEnabled ? stopLoss : 0,
      take_profit: tpEnabled ? takeProfit : 0,
    });
  };

  // Auto-suggest SL/TP values relative to current price
  const suggestSL = () => {
    if (hasOpenPositions) {
      // Unlock position SL for editing
      if (onUnlockPositionSL) onUnlockPositionSL();
      // Just enable the input with current position's SL value
      const pos = openPositions[0];
      if (pos.stop_loss > 0) {
        setStopLoss(formatPrice(pos.stop_loss));
        setSlEnabled(true);
        // Show Confirm button immediately when Update is clicked
        setSlModified(true);
      } else {
        // Calculate default if position has no SL
        const ref = orderType === 'limit' && entryPrice > 0 ? entryPrice : currentPrice;
        if (ref <= 0) return;
        const offset = ref * 0.01;
        const slValue = side === 'buy' ? +(ref - offset).toFixed(2) : +(ref + offset).toFixed(2);
        setStopLoss(slValue);
        setSlEnabled(true);
        setSlModified(true);
      }
    } else {
      // Set for new order
      const ref = orderType === 'limit' && entryPrice > 0 ? entryPrice : currentPrice;
      if (ref <= 0) return;
      const offset = ref * 0.01; // 1% default
      const slValue = side === 'buy' ? +(ref - offset).toFixed(2) : +(ref + offset).toFixed(2);
      handleStopLossChange(slValue);
      setSlEnabled(true);
    }
  };

  const suggestTP = () => {
    if (hasOpenPositions) {
      // Unlock position TP for editing
      if (onUnlockPositionTP) onUnlockPositionTP();
      // Just enable the input with current position's TP value
      const pos = openPositions[0];
      if (pos.take_profit > 0) {
        setTakeProfit(formatPrice(pos.take_profit));
        setTpEnabled(true);
        // Show Confirm button immediately when Update is clicked
        setTpModified(true);
      } else {
        // Calculate default if position has no TP
        const ref = orderType === 'limit' && entryPrice > 0 ? entryPrice : currentPrice;
        if (ref <= 0) return;
        const offset = ref * 0.02;
        const tpValue = side === 'buy' ? +(ref + offset).toFixed(2) : +(ref - offset).toFixed(2);
        setTakeProfit(tpValue);
        setTpEnabled(true);
        setTpModified(true);
      }
    } else {
      // Set for new order
      const ref = orderType === 'limit' && entryPrice > 0 ? entryPrice : currentPrice;
      if (ref <= 0) return;
      const offset = ref * 0.02; // 2% default
      const tpValue = side === 'buy' ? +(ref + offset).toFixed(2) : +(ref - offset).toFixed(2);
      handleTakeProfitChange(tpValue);
      setTpEnabled(true);
    }
  };

  // Format to 2 decimal places
  const formatPrice = (value: number) => {
    return parseFloat(value.toFixed(2));
  };

  // Sync with actual position SL/TP when open positions exist
  useEffect(() => {
    if (openPositions.length > 0) {
      const pos = openPositions[0];
      // Only update if not currently being edited by user
      if (!slModified && pos.stop_loss > 0) {
        setStopLoss(formatPrice(pos.stop_loss));
        setSlEnabled(true);
      } else if (!slModified && pos.stop_loss === 0) {
        setStopLoss(0);
        setSlEnabled(false);
      }
      if (!tpModified && pos.take_profit > 0) {
        setTakeProfit(formatPrice(pos.take_profit));
        setTpEnabled(true);
      } else if (!tpModified && pos.take_profit === 0) {
        setTakeProfit(0);
        setTpEnabled(false);
      }
    } else {
      // No open positions - clear SL/TP
      setStopLoss(0);
      setSlEnabled(false);
      setTakeProfit(0);
      setTpEnabled(false);
      setSlModified(false);
      setTpModified(false);
    }
  }, [openPositions, slModified, tpModified]);

  // Invert SL/TP when switching sides for new orders
  useEffect(() => {
    if (!hasOpenPositions) {
      const refPrice = orderType === 'limit' && entryPrice > 0 ? entryPrice : currentPrice;
      if (refPrice <= 0) return;

      // Invert SL if enabled
      if (slEnabled && stopLoss > 0) {
        const newSL = 2 * refPrice - stopLoss;
        setStopLoss(formatPrice(newSL));
        if (onSLChange) onSLChange(newSL);
      }

      // Invert TP if enabled
      if (tpEnabled && takeProfit > 0) {
        const newTP = 2 * refPrice - takeProfit;
        setTakeProfit(formatPrice(newTP));
        if (onTPChange) onTPChange(newTP);
      }
    }
  }, [side]);

  return (
    <div className={`flex h-full w-72 flex-col border-l ${lightMode ? 'border-gray-200 bg-white light-mode' : 'border-[#2a2e39] bg-[#121416]'}`}>
      {/* Header */}
      <div className={`flex items-center justify-between border-b px-4 py-2.5 ${lightMode ? 'border-gray-200' : 'border-[#2a2e39]'}`}>
        <h3 className={`text-sm font-medium ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>Order Ticket</h3>
        <button
          onClick={onClose}
          className={`transition-colors ${lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* Side selector */}
        <div className={`mb-4 grid grid-cols-2 gap-1 rounded-lg border p-0.5 ${lightMode ? 'border-gray-300' : 'border-[#2a2e39]'}`}>
          <button
            onClick={() => setSide('buy')}
            className={`rounded-md py-2 text-xs font-semibold transition-colors ${
              side === 'buy'
                ? 'bg-[#2e9461] text-white'
                : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
            }`}
          >
            BUY / LONG
          </button>
          <button
            onClick={() => setSide('sell')}
            className={`rounded-md py-2 text-xs font-semibold transition-colors ${
              side === 'sell'
                ? 'bg-[#ef5350] text-white'
                : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
            }`}
          >
            SELL / SHORT
          </button>
        </div>

        {/* Order type tabs */}
        <div className="mb-4">
          <label className={`mb-1.5 block text-[10px] uppercase tracking-wider ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
            Order Type
          </label>
          <div className={`grid grid-cols-2 gap-1 rounded border p-0.5 ${lightMode ? 'border-gray-300' : 'border-[#2a2e39]'}`}>
            <button
              onClick={() => setOrderType('market')}
              className={`rounded px-3 py-1.5 text-[11px] font-medium transition-colors ${
                orderType === 'market'
                  ? 'bg-[#2962ff]/15 text-[#2962ff]'
                  : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
              }`}
            >
              Market
            </button>
            <button
              onClick={() => setOrderType('limit')}
              className={`rounded px-3 py-1.5 text-[11px] font-medium transition-colors ${
                orderType === 'limit'
                  ? 'bg-[#2962ff]/15 text-[#2962ff]'
                  : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
              }`}
            >
              Limit
            </button>
          </div>
        </div>

        {/* Entry Price (for Limit orders) */}
        {orderType === 'limit' && (
          <div className="mb-4">
            <label className={`mb-1.5 block text-[10px] uppercase tracking-wider ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
              Entry Price
            </label>
            <input
              type="number"
              value={entryPrice || ''}
              onChange={(e) => setEntryPrice(Number(e.target.value))}
              placeholder={currentPrice.toFixed(2)}
              step={0.01}
              className={`w-full rounded border px-3 py-2 text-sm font-mono outline-none transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${lightMode ? 'border-gray-300 bg-gray-50 text-gray-900 placeholder-gray-500 focus:border-blue-400' : 'border-[#363a45] bg-[#1e222d] text-[#d1d4dc] placeholder-[#787b86] focus:border-[#2962ff]'}`}
            />
          </div>
        )}

        {/* Quantity */}
        <div className="mb-4">
          <label className={`mb-1.5 block text-[10px] uppercase tracking-wider ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
            Quantity (Contracts)
          </label>
          <input
            type="number"
            value={quantity}
            onChange={(e) => onSetQuantity(Math.max(0, Number(e.target.value)))}
            min={1}
            step={1}
            className={`w-full rounded border px-3 py-2 text-sm font-mono outline-none transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${lightMode ? 'border-gray-300 bg-gray-50 text-gray-900 focus:border-blue-400' : 'border-[#363a45] bg-[#1e222d] text-[#d1d4dc] focus:border-[#2962ff]'}`}
          />
          <div className="mt-1.5 flex gap-1">
            {[1, 5, 10, 25, 50, 100].map((q) => (
              <button
                key={q}
                onClick={() => onSetQuantity(q)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-mono focus:outline-none focus:ring-0 outline-none border-transparent ${
                  quantity === q
                    ? 'bg-[#2962ff]/15 text-[#2962ff]'
                    : (lightMode ? 'text-gray-600 hover:text-gray-900 border border-gray-300' : 'text-[#787b86] hover:text-[#d1d4dc] border border-[#363a45]')
                }`}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* Stop Loss */}
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between">
            <label className={`text-[10px] uppercase tracking-wider ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
              Stop Loss
            </label>
            <div className="flex items-center gap-2">
              {hasOpenPositions ? (
                // Position is open - show Update or Confirm
                slModified ? (
                  <button
                    onClick={confirmSLUpdate}
                    className="text-[10px] text-[#2e9461] hover:text-[#2e9461]/80"
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    onClick={suggestSL}
                    className="text-[10px] text-[#2962ff] hover:text-[#2962ff]/80"
                  >
                    Update
                  </button>
                )
              ) : (
                // No position - show Add/Remove
                !slEnabled ? (
                  <button
                    onClick={suggestSL}
                    className="text-[10px] text-[#2962ff] hover:text-[#2962ff]/80"
                  >
                    + Add
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setSlEnabled(false);
                      setStopLoss(0);
                      setSlModified(false);
                      if (onSLChange) onSLChange(0);
                    }}
                    className="text-[10px] text-[#ef5350] hover:text-[#ef5350]/80"
                  >
                    Remove
                  </button>
                )
              )}
            </div>
          </div>
          {hasOpenPositions || slEnabled ? (
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={stopLoss || ''}
                onChange={(e) => handleStopLossChange(Number(e.target.value))}
                step={0.01}
                placeholder="Price"
                className={`flex-1 rounded border px-3 py-1.5 text-sm font-mono outline-none transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${lightMode ? 'border-red-200 bg-red-50 text-gray-900 placeholder-gray-500 focus:border-red-400' : 'border-[#ef5350]/30 bg-[#1e222d] text-[#d1d4dc] placeholder-[#787b86] focus:border-[#ef5350]'}`}
              />
              <span className="text-[10px] text-[#ef5350]">
                {stopLoss > 0 && currentPrice > 0
                  ? `${side === 'buy' ? '-' : '+'}${Math.abs(((stopLoss - currentPrice) / currentPrice) * 100).toFixed(1)}%`
                  : ''}
              </span>
            </div>
          ) : null}
        </div>

        {/* Take Profit */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between">
            <label className={`text-[10px] uppercase tracking-wider ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
              Take Profit
            </label>
            <div className="flex items-center gap-2">
              {hasOpenPositions ? (
                // Position is open - show Update or Confirm
                tpModified ? (
                  <button
                    onClick={confirmTPUpdate}
                    className="text-[10px] text-[#2e9461] hover:text-[#2e9461]/80"
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    onClick={suggestTP}
                    className="text-[10px] text-[#2962ff] hover:text-[#2962ff]/80"
                  >
                    Update
                  </button>
                )
              ) : (
                // No position - show Add/Remove
                !tpEnabled ? (
                  <button
                    onClick={suggestTP}
                    className="text-[10px] text-[#2962ff] hover:text-[#2962ff]/80"
                  >
                    + Add
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setTpEnabled(false);
                      setTakeProfit(0);
                      setTpModified(false);
                      if (onTPChange) onTPChange(0);
                    }}
                    className="text-[10px] text-[#ef5350] hover:text-[#ef5350]/80"
                  >
                    Remove
                  </button>
                )
              )}
            </div>
          </div>
          {hasOpenPositions || tpEnabled ? (
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={takeProfit || ''}
                onChange={(e) => handleTakeProfitChange(Number(e.target.value))}
                step={0.01}
                placeholder="Price"
                className={`flex-1 rounded border px-3 py-1.5 text-sm font-mono outline-none transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${lightMode ? 'border-green-200 bg-green-50 text-gray-900 placeholder-gray-500 focus:border-green-400' : 'border-[#2e9461]/30 bg-[#1e222d] text-[#d1d4dc] placeholder-[#787b86] focus:border-[#2e9461]'}`}
              />
              <span className="text-[10px] text-[#2e9461]">
                {takeProfit > 0 && currentPrice > 0
                  ? `${side === 'buy' ? '+' : '-'}${Math.abs(((takeProfit - currentPrice) / currentPrice) * 100).toFixed(1)}%`
                  : ''}
              </span>
            </div>
          ) : null}
        </div>

        {/* Risk summary */}
        {(slEnabled || tpEnabled) && currentPrice > 0 && quantity > 0 && (
          <div className={`mb-4 rounded border p-2.5 ${lightMode ? 'border-gray-200 bg-gray-50' : 'border-[#2a2e39] bg-[#1e222d]'}`}>
            <div className={`text-[10px] uppercase tracking-wider mb-1.5 ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>Risk Summary</div>
            {slEnabled && stopLoss > 0 && (
              <div className="flex justify-between text-[11px]">
                <span className={lightMode ? 'text-gray-600' : 'text-[#787b86]'}>Max Loss:</span>
                <span className="font-mono text-[#ef5350]">
                  -${(Math.abs(stopLoss - (orderType === 'limit' && entryPrice > 0 ? entryPrice : currentPrice)) * quantity).toFixed(2)}
                </span>
              </div>
            )}
            {tpEnabled && takeProfit > 0 && (
              <div className="flex justify-between text-[11px] mt-0.5">
                <span className={lightMode ? 'text-gray-600' : 'text-[#787b86]'}>Target Profit:</span>
                <span className="font-mono text-[#2e9461]">
                  +${(Math.abs(takeProfit - (orderType === 'limit' && entryPrice > 0 ? entryPrice : currentPrice)) * quantity).toFixed(2)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Price info */}
        <div className={`mb-4 flex items-center justify-between rounded border px-3 py-2 ${lightMode ? 'border-gray-200 bg-gray-50' : 'border-[#2a2e39] bg-[#1e222d]'}`}>
          <span className={`text-[10px] ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>Current Price</span>
          <span className={`text-sm font-mono ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
            {currentPrice > 0 ? currentPrice.toFixed(2) : '—'}
          </span>
        </div>
      </div>

      {/* Submit button (pinned to bottom) */}
      <div className={`border-t px-4 py-3 ${lightMode ? 'border-gray-200' : 'border-[#2a2e39]'}`}>
        <button
          onClick={handleSubmit}
          disabled={!sessionActive || quantity <= 0}
          className={`w-full rounded-lg py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            side === 'buy'
              ? 'bg-[#2e9461] hover:bg-[#2e9461]/90'
              : 'bg-[#ef5350] hover:bg-[#ef5350]/90'
          }`}
        >
          {side === 'buy' ? 'Buy' : 'Sell'} {quantity} @ {orderType === 'market' ? 'Market' : entryPrice > 0 ? entryPrice.toFixed(2) : 'Set Price'}
        </button>
      </div>
    </div>
  );
}
