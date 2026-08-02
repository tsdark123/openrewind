import { RotateCcw, Settings, Lock, Unlock, Eye, EyeOff, Sun, Moon, CalendarDays, Calendar, Bot } from 'lucide-react';
import { IndicatorsDropdown } from '../IndicatorsDropdown';
import { TickerSearchInput } from '../TickerSearchInput';
import { useState, useMemo } from 'react';
import { CalendarPicker } from './CalendarPicker';

const TIMEFRAME_OPTIONS = [
  { label: '1m', value: 1 },
  { label: '5m', value: 5 },
  { label: '15m', value: 15 },
  { label: '1H', value: 60 },
  { label: '4H', value: 240 },
  { label: '1D', value: 1440 },
];

interface ToolbarProps {
  symbol: string;
  availableTickers: string[];
  onSymbolChange: (symbol: string) => void;
  replayDate: string;
  onDateChange: (date: string) => void;
  timeframe: number;
  lockToEdge: boolean;
  showMarkers: boolean;
  lightMode: boolean;
  indicators: {
    ema20: boolean;
    sma50: boolean;
    bollinger: boolean;
    rsi: boolean;
    macd: boolean;
    atr: boolean;
    stochastic: boolean;
  };
  onSetTimeframe: (minutes: number) => void;
  onToggleLock: () => void;
  onToggleMarkers: () => void;
  onToggleLightMode: () => void;
  onToggleIndicator: (indicator: 'ema20' | 'sma50' | 'bollinger' | 'rsi' | 'macd' | 'atr' | 'stochastic') => void;
  onReset?: () => void;
  onOpenCalendar?: () => void;
  orionOpen?: boolean;
  onToggleOrion?: () => void;
  /** Inline error for the symbol picker, shown below the input. */
  error?: string;
}

export function Toolbar({ symbol, availableTickers, onSymbolChange, replayDate, onDateChange, timeframe, lockToEdge, showMarkers, lightMode, indicators, onSetTimeframe, onToggleLock, onToggleMarkers, onToggleLightMode, onToggleIndicator, onReset, onOpenCalendar, orionOpen, onToggleOrion, error }: ToolbarProps) {
  const [indicatorsDropdownOpen, setIndicatorsDropdownOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  console.log('[Orion Diagnostic] Toolbar render', { symbol, availableTickers: availableTickers.length, replayDate, lightMode, orionOpen });

  // Rolling 30-day window — matches the yfinance data retention in fetch_data.py.
  const { todayStr, minDateStr } = useMemo(() => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const min = new Date(now);
    min.setDate(now.getDate() - 30);
    return { todayStr, minDateStr: min.toISOString().slice(0, 10) };
  }, []);

  return (
    <div className={`flex h-9 items-center justify-between border-b px-3 ${lightMode ? 'bg-white border-gray-200' : 'bg-[#121416] border-[#2a2e39]'}`}>
      <div className="flex items-center gap-3">
        {/* Symbol search — TradingView-style autocomplete. Selecting a
            ticker triggers a session reload on the C++ engine, so the
            chart resets to the new symbol's stream. */}
        <div className="w-32">
          <TickerSearchInput
            tickers={availableTickers}
            value={symbol}
            onCommit={onSymbolChange}
            placeholder="Search"
            size="sm"
            lightMode={lightMode}
            error={error}
          />
        </div>

        {/* Date picker — selects the backtesting day. Changing this restarts
            the session filtered to core market hours (09:30–16:00 ET) for
            that exact calendar date. Controls stay locked until a date is
            chosen for the current ticker. */}
        <div className="relative z-30 flex items-center gap-1">
          <CalendarDays className={`h-3.5 w-3.5 flex-shrink-0 ${lightMode ? 'text-gray-400' : 'text-[#4c525e]'}`} />
          <button
            type="button"
            onClick={() => setCalendarOpen((v) => !v)}
            title="Select backtesting date (09:30–16:00 ET)"
            className={`h-6 rounded border px-2 text-[11px] font-mono tabular-nums whitespace-nowrap
              focus:outline-none focus:ring-1 focus:ring-[#2962ff] transition-colors
              ${
                lightMode
                  ? 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                  : 'bg-[#1e222d] border-[#363a45] text-[#d1d4dc] hover:bg-[#2a2e39]'
              }
              ${!replayDate ? (lightMode ? 'border-amber-400' : 'border-[#f59e0b]/60') : ''}
            `}
          >
            {replayDate || '— select date —'}
          </button>
          {calendarOpen && (
            <div className="absolute top-full left-0 mt-1 z-50">
              <CalendarPicker
                value={replayDate}
                onChange={(d) => { onDateChange(d); setCalendarOpen(false); }}
                minDate={minDateStr}
                maxDate={todayStr}
                onClose={() => setCalendarOpen(false)}
                lightMode={lightMode}
              />
            </div>
          )}
        </div>

        {/* Timeframe buttons */}
        <div className="flex items-center gap-0.5">
          {TIMEFRAME_OPTIONS.map((tf) => (
            <button
              key={tf.value}
              onClick={() => onSetTimeframe(tf.value)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                timeframe === tf.value
                  ? 'bg-[#2962ff]/20 text-[#2962ff]'
                  : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {/* Performance calendar icon */}
        <button
          type="button"
          onClick={() => onOpenCalendar?.()}
          title="Open performance calendar"
          className={lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}
        >
          <Calendar className="h-4 w-4" />
        </button>

        {/* Indicators */}
        <div className="relative">
          <button
            onClick={() => setIndicatorsDropdownOpen(!indicatorsDropdownOpen)}
            className={`flex items-center gap-1.5 text-[11px] ${lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}`}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3v18h18" />
              <path d="M7 14l4-4 4 4 5-5" />
            </svg>
            Indicators
          </button>
          <IndicatorsDropdown
            isOpen={indicatorsDropdownOpen}
            onClose={() => setIndicatorsDropdownOpen(false)}
            indicators={indicators}
            onToggle={onToggleIndicator}
            lightMode={lightMode}
          />
        </div>

        {/* Reset / Nuke session */}
        <button
          onClick={onReset}
          title="Reset session to start"
          className={`transition-colors ${lightMode ? 'text-gray-600 hover:text-red-600' : 'text-[#787b86] hover:text-[#ef5350]'}`}
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        {/* Orion toggle */}
        {onToggleOrion && (
          <button
            type="button"
            onClick={onToggleOrion}
            title="Toggle Orion AI coach"
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
              orionOpen ? 'text-[#ff3700]' : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
            }`}
          >
            <Bot className="h-4 w-4" />
          </button>
        )}

        {/* Markers toggle */}
        <button
          onClick={onToggleMarkers}
          title={showMarkers ? 'Hide trade markers' : 'Show trade markers'}
          className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
            showMarkers ? 'text-[#2962ff]' : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
          }`}
        >
          {showMarkers ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>

        {/* Lock to edge toggle */}
        <button
          onClick={onToggleLock}
          title={lockToEdge ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
            lockToEdge ? 'text-[#2962ff]' : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
          }`}
        >
          {lockToEdge ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
        </button>

        {/* Light/Dark mode toggle */}
        <button
          onClick={onToggleLightMode}
          title={lightMode ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
          className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
            lightMode ? 'text-[#f59e0b]' : 'text-[#787b86] hover:text-[#d1d4dc]'
          }`}
        >
          {lightMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* Settings gear */}
        <button className={lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}>
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
