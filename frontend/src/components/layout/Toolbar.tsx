import { Search, Plus, RotateCcw, Settings, Lock, Unlock, Eye, EyeOff, Sun, Moon } from 'lucide-react';
import { IndicatorsDropdown } from '../IndicatorsDropdown';
import { useState } from 'react';

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
}

export function Toolbar({ symbol, timeframe, lockToEdge, showMarkers, lightMode, indicators, onSetTimeframe, onToggleLock, onToggleMarkers, onToggleLightMode, onToggleIndicator, onReset }: ToolbarProps) {
  const [indicatorsDropdownOpen, setIndicatorsDropdownOpen] = useState(false);

  return (
    <div className={`flex h-9 items-center justify-between border-b px-3 ${lightMode ? 'bg-white border-gray-200' : 'bg-[#121416] border-[#2a2e39]'}`}>
      <div className="flex items-center gap-3">
        {/* Symbol search */}
        <button className={`flex items-center gap-1.5 text-[13px] ${lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}`}>
          <Search className="h-4 w-4" />
          <span className={`font-medium ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>{symbol || 'SYMBOL'}</span>
          <span className={`flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${lightMode ? 'border-gray-300' : 'border-[#363a45]'}`}>
            <Plus className="h-2.5 w-2.5" />
          </span>
        </button>

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

        {/* Chart type icon - candlestick */}
        <button className={lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <rect x="5" y="4" width="2" height="16" />
            <rect x="11" y="8" width="2" height="12" />
            <rect x="17" y="2" width="2" height="18" />
          </svg>
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
