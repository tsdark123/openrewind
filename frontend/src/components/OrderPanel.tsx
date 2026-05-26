import { useState } from 'react';
import { ArrowUpCircle, ArrowDownCircle, Send } from 'lucide-react';
import type { Side, OrdType } from '../types';

// =============================================================================
// OrderPanel — Sidebar order entry form for placing trades.
//
// Features:
//   - Buy/Sell side toggle with color-coded highlighting
//   - Market/Limit type selector
//   - Numeric inputs for quantity, entry price, stop loss, take profit
//   - Submit button that fires the appropriate WS command
// =============================================================================

interface OrderPanelProps {
  sessionActive: boolean;
  currentPrice: number;
  onPlaceOrder: (order: {
    side: Side;
    type: OrdType;
    quantity: number;
    entry_price: number;
    stop_loss: number;
    take_profit: number;
  }) => void;
}

export function OrderPanel({
  sessionActive,
  currentPrice,
  onPlaceOrder,
}: OrderPanelProps) {
  const [side, setSide] = useState<Side>('buy');
  const [ordType, setOrdType] = useState<OrdType>('market');
  const [quantity, setQuantity] = useState('100');
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');

  const disabled = !sessionActive;
  const isBuy = side === 'buy';

  const handleSubmit = () => {
    if (disabled) return;

    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) return;

    const ep = ordType === 'market' ? 0 : parseFloat(entryPrice) || 0;
    const sl = parseFloat(stopLoss) || 0;
    const tp = parseFloat(takeProfit) || 0;

    if (ordType !== 'market' && ep <= 0) return;

    onPlaceOrder({
      side,
      type: ordType,
      quantity: qty,
      entry_price: ep,
      stop_loss: sl,
      take_profit: tp,
    });

    // Reset SL/TP after submission
    setStopLoss('');
    setTakeProfit('');
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          New Order
        </h3>
        {currentPrice > 0 && (
          <span className="text-xs font-mono text-gray-500">
            {currentPrice.toFixed(2)}
          </span>
        )}
      </div>

      {/* Side Toggle: Buy / Sell */}
      <div className="grid grid-cols-2 gap-1 p-0.5 bg-panel-surface rounded-lg">
        <button
          onClick={() => setSide('buy')}
          disabled={disabled}
          className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-semibold transition-all ${
            isBuy
              ? 'bg-accent-buy text-white shadow-lg shadow-accent-buy/20'
              : 'text-gray-500 hover:text-gray-300'
          } disabled:opacity-30 disabled:cursor-not-allowed`}
        >
          <ArrowUpCircle size={14} />
          Buy
        </button>
        <button
          onClick={() => setSide('sell')}
          disabled={disabled}
          className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-semibold transition-all ${
            !isBuy
              ? 'bg-accent-sell text-white shadow-lg shadow-accent-sell/20'
              : 'text-gray-500 hover:text-gray-300'
          } disabled:opacity-30 disabled:cursor-not-allowed`}
        >
          <ArrowDownCircle size={14} />
          Sell
        </button>
      </div>

      {/* Order Type Toggle */}
      <div className="grid grid-cols-2 gap-1 p-0.5 bg-panel-surface rounded-lg">
        {(['market', 'limit'] as OrdType[]).map((t) => (
          <button
            key={t}
            onClick={() => setOrdType(t)}
            disabled={disabled}
            className={`py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
              ordType === t
                ? 'bg-panel-hover text-white'
                : 'text-gray-500 hover:text-gray-300'
            } disabled:opacity-30 disabled:cursor-not-allowed`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Input Fields */}
      <div className="flex flex-col gap-2">
        {/* Entry Price (Limit only) */}
        {ordType !== 'market' && (
          <div>
            <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
              Entry Price
            </label>
            <input
              type="number"
              step="0.01"
              value={entryPrice}
              onChange={(e) => setEntryPrice(e.target.value)}
              disabled={disabled}
              placeholder="0.00"
              className="w-full px-3 py-2 bg-panel-surface border border-panel-border rounded-md text-sm font-mono text-gray-200 placeholder-gray-600 focus:border-accent-blue focus:outline-none disabled:opacity-30 transition-colors"
            />
          </div>
        )}

        {/* Quantity */}
        <div>
          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
            Quantity
          </label>
          <input
            type="number"
            step="1"
            min="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            disabled={disabled}
            placeholder="100"
            className="w-full px-3 py-2 bg-panel-surface border border-panel-border rounded-md text-sm font-mono text-gray-200 placeholder-gray-600 focus:border-accent-blue focus:outline-none disabled:opacity-30 transition-colors"
          />
        </div>

        {/* Stop Loss */}
        <div>
          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
            Stop Loss
          </label>
          <input
            type="number"
            step="0.01"
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            disabled={disabled}
            placeholder="Optional"
            className="w-full px-3 py-2 bg-panel-surface border border-panel-border rounded-md text-sm font-mono text-gray-200 placeholder-gray-600 focus:border-accent-sell/50 focus:outline-none disabled:opacity-30 transition-colors"
          />
        </div>

        {/* Take Profit */}
        <div>
          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">
            Take Profit
          </label>
          <input
            type="number"
            step="0.01"
            value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)}
            disabled={disabled}
            placeholder="Optional"
            className="w-full px-3 py-2 bg-panel-surface border border-panel-border rounded-md text-sm font-mono text-gray-200 placeholder-gray-600 focus:border-accent-buy/50 focus:outline-none disabled:opacity-30 transition-colors"
          />
        </div>
      </div>

      {/* Submit Button */}
      <button
        onClick={handleSubmit}
        disabled={disabled}
        className={`flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-sm font-semibold transition-all ${
          isBuy
            ? 'bg-accent-buy hover:bg-accent-buy/90 text-white shadow-lg shadow-accent-buy/20'
            : 'bg-accent-sell hover:bg-accent-sell/90 text-white shadow-lg shadow-accent-sell/20'
        } disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none`}
      >
        <Send size={14} />
        {isBuy ? 'Buy' : 'Sell'} {ordType === 'market' ? 'Market' : 'Limit'}
      </button>
    </div>
  );
}
