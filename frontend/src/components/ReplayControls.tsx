import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  ChevronRight,
  Gauge,
} from 'lucide-react';

// =============================================================================
// ReplayControls — Bottom bar with playback controls, speed, timeframe, progress
// =============================================================================

interface ReplayControlsProps {
  isPlaying: boolean;
  speed: number;
  timeframe: number;
  cursor: number;
  totalCandles: number;
  sessionActive: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNextCandle: () => void;
  onRewind: () => void;
  onSetSpeed: (speed: number) => void;
  onSetTimeframe: (minutes: number) => void;
}

const SPEED_OPTIONS = [1, 2, 5, 10, 25, 50];
const TIMEFRAME_OPTIONS = [
  { label: '1m', value: 1 },
  { label: '5m', value: 5 },
  { label: '15m', value: 15 },
  { label: '1H', value: 60 },
  { label: '4H', value: 240 },
  { label: '1D', value: 1440 },
];

export function ReplayControls({
  isPlaying,
  speed,
  timeframe,
  cursor,
  totalCandles,
  sessionActive,
  onPlay,
  onPause,
  onNextCandle,
  onRewind,
  onSetSpeed,
  onSetTimeframe,
}: ReplayControlsProps) {
  const progressPercent =
    totalCandles > 0 ? ((cursor + 1) / totalCandles) * 100 : 0;
  const disabled = !sessionActive;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-panel-bg border-t border-panel-border select-none">
      {/* Playback Buttons */}
      <div className="flex items-center gap-1">
        <button
          onClick={onRewind}
          disabled={disabled}
          className="p-2 rounded hover:bg-panel-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Rewind one candle"
        >
          <SkipBack size={16} />
        </button>

        <button
          onClick={isPlaying ? onPause : onPlay}
          disabled={disabled}
          className="p-2.5 rounded-lg bg-accent-blue/20 hover:bg-accent-blue/30 text-accent-blue disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>

        <button
          onClick={onNextCandle}
          disabled={disabled}
          className="p-2 rounded hover:bg-panel-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Next candle"
        >
          <SkipForward size={16} />
        </button>
      </div>

      {/* Divider */}
      <div className="w-px h-6 bg-panel-border" />

      {/* Speed Control */}
      <div className="flex items-center gap-2">
        <Gauge size={14} className="text-gray-500" />
        <div className="flex items-center gap-0.5">
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => onSetSpeed(s)}
              disabled={disabled}
              className={`px-2 py-1 text-xs rounded font-mono transition-colors ${
                speed === s
                  ? 'bg-accent-blue/20 text-accent-blue'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-panel-hover'
              } disabled:opacity-30 disabled:cursor-not-allowed`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div className="w-px h-6 bg-panel-border" />

      {/* Timeframe Selector */}
      <div className="flex items-center gap-0.5">
        {TIMEFRAME_OPTIONS.map((tf) => (
          <button
            key={tf.value}
            onClick={() => onSetTimeframe(tf.value)}
            disabled={disabled}
            className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
              timeframe === tf.value
                ? 'bg-panel-surface text-white'
                : 'text-gray-500 hover:text-gray-300 hover:bg-panel-hover'
            } disabled:opacity-30 disabled:cursor-not-allowed`}
          >
            {tf.label}
          </button>
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Progress Bar */}
      <div className="flex items-center gap-3 min-w-[280px]">
        <div className="flex-1 h-1.5 bg-panel-surface rounded-full overflow-hidden">
          <div
            className="h-full bg-accent-blue rounded-full transition-all duration-150"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <span className="text-xs text-gray-500 font-mono tabular-nums min-w-[120px] text-right">
          {sessionActive ? (
            <>
              {(cursor + 1).toLocaleString()}
              <span className="text-gray-600"> / </span>
              {totalCandles.toLocaleString()}
              <span className="text-gray-600 ml-1">
                ({progressPercent.toFixed(1)}%)
              </span>
            </>
          ) : (
            'No session'
          )}
        </span>
      </div>

      {/* Next candle hotkey hint */}
      <div className="hidden lg:flex items-center gap-1 text-[10px] text-gray-600 ml-2">
        <ChevronRight size={10} />
        <span>Ctrl+Space</span>
      </div>
    </div>
  );
}
