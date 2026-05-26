import { useEffect, useRef } from 'react';

interface IndicatorsDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  indicators: {
    ema20: boolean;
    sma50: boolean;
    bollinger: boolean;
    rsi: boolean;
    macd: boolean;
    atr: boolean;
    stochastic: boolean;
  };
  onToggle: (indicator: 'ema20' | 'sma50' | 'bollinger' | 'rsi' | 'macd' | 'atr' | 'stochastic') => void;
  lightMode: boolean;
}

export function IndicatorsDropdown({ isOpen, onClose, indicators, onToggle, lightMode }: IndicatorsDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={dropdownRef}
      className={`absolute top-full left-0 mt-1 w-48 rounded-lg border shadow-xl z-50 ${lightMode ? 'border-gray-300 bg-white' : 'border-[#2a2e39] bg-[#1e222d]'}`}
    >
      <div className="p-2">
        <div className={`mb-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
          Trend Indicators
        </div>

        <button
          onClick={() => onToggle('ema20')}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] transition-colors ${lightMode ? 'text-gray-900 hover:bg-gray-100' : 'text-[#d1d4dc] hover:bg-[#2a2e39]'}`}
        >
          <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${indicators.ema20 ? 'bg-[#2962ff] border-[#2962ff]' : (lightMode ? 'border-gray-300' : 'border-[#363a45]')}`}>
            {indicators.ema20 && <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>}
          </div>
          <span>EMA 20</span>
        </button>

        <button
          onClick={() => onToggle('sma50')}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] transition-colors ${lightMode ? 'text-gray-900 hover:bg-gray-100' : 'text-[#d1d4dc] hover:bg-[#2a2e39]'}`}
        >
          <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${indicators.sma50 ? 'bg-[#ff9800] border-[#ff9800]' : (lightMode ? 'border-gray-300' : 'border-[#363a45]')}`}>
            {indicators.sma50 && <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>}
          </div>
          <span>SMA 50</span>
        </button>

        <button
          onClick={() => onToggle('bollinger')}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] transition-colors ${lightMode ? 'text-gray-900 hover:bg-gray-100' : 'text-[#d1d4dc] hover:bg-[#2a2e39]'}`}
        >
          <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${indicators.bollinger ? 'bg-[#6495ed] border-[#6495ed]' : (lightMode ? 'border-gray-300' : 'border-[#363a45]')}`}>
            {indicators.bollinger && <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>}
          </div>
          <span>Bollinger Bands</span>
        </button>

        <div className={`my-2 border-t ${lightMode ? 'border-gray-200' : 'border-[#2a2e39]'}`} />

        <div className={`mb-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
          Momentum
        </div>

        <button
          onClick={() => onToggle('rsi')}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] transition-colors ${lightMode ? 'text-gray-900 hover:bg-gray-100' : 'text-[#d1d4dc] hover:bg-[#2a2e39]'}`}
        >
          <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${indicators.rsi ? 'bg-[#785bf7] border-[#785bf7]' : (lightMode ? 'border-gray-300' : 'border-[#363a45]')}`}>
            {indicators.rsi && <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>}
          </div>
          <span>RSI 14</span>
        </button>

        <button
          onClick={() => onToggle('macd')}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] transition-colors ${lightMode ? 'text-gray-900 hover:bg-gray-100' : 'text-[#d1d4dc] hover:bg-[#2a2e39]'}`}
        >
          <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${indicators.macd ? 'bg-[#2962ff] border-[#2962ff]' : (lightMode ? 'border-gray-300' : 'border-[#363a45]')}`}>
            {indicators.macd && <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>}
          </div>
          <span>MACD (12, 26, 9)</span>
        </button>

        <button
          onClick={() => onToggle('atr')}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] transition-colors ${lightMode ? 'text-gray-900 hover:bg-gray-100' : 'text-[#d1d4dc] hover:bg-[#2a2e39]'}`}
        >
          <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${indicators.atr ? 'bg-[#9c27b0] border-[#9c27b0]' : (lightMode ? 'border-gray-300' : 'border-[#363a45]')}`}>
            {indicators.atr && <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>}
          </div>
          <span>ATR 14</span>
        </button>

        <button
          onClick={() => onToggle('stochastic')}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] transition-colors ${lightMode ? 'text-gray-900 hover:bg-gray-100' : 'text-[#d1d4dc] hover:bg-[#2a2e39]'}`}
        >
          <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${indicators.stochastic ? 'bg-[#00bcd4] border-[#00bcd4]' : (lightMode ? 'border-gray-300' : 'border-[#363a45]')}`}>
            {indicators.stochastic && <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>}
          </div>
          <span>Stochastic (14, 3)</span>
        </button>
      </div>
    </div>
  );
}
