import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, SkipForward, SkipBack, GripVertical, ChevronUp } from 'lucide-react';

const SPEED_OPTIONS = [1, 2, 5, 10, 25, 50];

interface PlaybackControlsProps {
  isPlaying: boolean;
  speed: number;
  cursor: number;
  totalCandles: number;
  sessionActive: boolean;
  playbackDirection: 'forward' | 'backward';
  onPlay: () => void;
  onPause: () => void;
  onNextCandle: () => void;
  onRewind: () => void;
  onSetSpeed: (speed: number) => void;
  lightMode: boolean;
}

export function PlaybackControls({
  isPlaying,
  speed,
  cursor,
  totalCandles,
  sessionActive,
  playbackDirection,
  onPlay,
  onPause,
  onNextCandle,
  onRewind,
  onSetSpeed,
  lightMode,
}: PlaybackControlsProps) {
  const [isSpeedOpen, setIsSpeedOpen] = useState(false);
  // Default position: horizontally centred, ~80% down the chart area
  const [pos, setPos] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const progressPercent = totalCandles > 0 ? ((cursor + 1) / totalCandles) * 100 : 0;
  const disabled = !sessionActive;

  const onGripMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragging.current = true;
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const parent = containerRef.current.parentElement;
      if (!parent) return;
      const parentRect = parent.getBoundingClientRect();
      const elRect = containerRef.current.getBoundingClientRect();
      const newX = e.clientX - parentRect.left - dragOffset.current.x + elRect.width / 2;
      const newY = e.clientY - parentRect.top - dragOffset.current.y;
      // Clamp within parent bounds
      const maxX = parentRect.width;
      const maxY = parentRect.height - elRect.height;
      setPos({
        x: Math.max(elRect.width / 2, Math.min(newX, maxX - elRect.width / 2)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Use absolute pixel position when dragged, otherwise default to bottom-centre via CSS
  const style = pos.x !== null && pos.y !== null
    ? { left: pos.x, top: pos.y, transform: 'translateX(-50%)' }
    : { left: '50%', bottom: '48px', transform: 'translateX(-50%)' };

  return (
    <div ref={containerRef} className="absolute z-20" style={style}>
      <div className={`flex items-center gap-2 rounded-md px-3 py-2 shadow-lg backdrop-blur-sm border ${lightMode ? 'bg-gray-200/95 border-gray-300' : 'bg-[#2a2e39]/95 border-[#363a45]/60'}`}>
        {/* Grip handle — drag to move */}
        <div
          onMouseDown={onGripMouseDown}
          className={`cursor-grab active:cursor-grabbing select-none ${lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}`}
          title="Drag to reposition"
        >
          <GripVertical className="h-4 w-4" />
        </div>

        {/* Progress bar */}
        <div className={`relative h-1 w-24 rounded-full ${lightMode ? 'bg-gray-300' : 'bg-[#363a45]'}`}>
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-[#2962ff] transition-all duration-150"
            style={{ width: `${progressPercent}%` }}
          />
          <div
            className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#2962ff] transition-all duration-150 ${lightMode ? 'bg-white' : 'bg-[#2a2e39]'}`}
            style={{ left: `${progressPercent}%` }}
          />
        </div>

        {/* Rewind */}
        <button
          onClick={onRewind}
          disabled={disabled}
          className={`flex h-5 w-5 items-center justify-center disabled:opacity-30 ${
            playbackDirection === 'backward'
              ? 'text-[#2962ff]'
              : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
          }`}
        >
          <SkipBack className="h-3.5 w-3.5" />
        </button>

        {/* Play/Pause */}
        <button
          onClick={isPlaying ? onPause : onPlay}
          disabled={disabled}
          className="flex h-6 w-6 items-center justify-center rounded-full bg-[#2962ff] text-white hover:bg-[#2962ff]/90 disabled:opacity-40"
        >
          {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3 ml-0.5" />}
        </button>

        {/* Next candle */}
        <button
          onClick={onNextCandle}
          disabled={disabled}
          className={`flex h-5 w-5 items-center justify-center disabled:opacity-30 ${
            playbackDirection === 'forward'
              ? 'text-[#2962ff]'
              : (lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]')
          }`}
        >
          <SkipForward className="h-3.5 w-3.5" />
        </button>

        {/* Speed dropdown — opens upward */}
        <div className="relative">
          <button
            onClick={() => setIsSpeedOpen(!isSpeedOpen)}
            disabled={disabled}
            className={`flex items-center gap-0.5 text-xs font-mono disabled:opacity-30 ${lightMode ? 'text-gray-900 hover:text-gray-700' : 'text-[#d1d4dc] hover:text-white'}`}
          >
            {speed}x
            <ChevronUp className={`h-3 w-3 transition-transform ${isSpeedOpen ? '' : 'rotate-180'}`} />
          </button>

          {isSpeedOpen && (
            <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 rounded border py-1 shadow-xl min-w-[52px] ${lightMode ? 'bg-white border-gray-300' : 'bg-[#1e222d] border-[#363a45]'}`}>
              {SPEED_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => { onSetSpeed(s); setIsSpeedOpen(false); }}
                  className={`block w-full px-3 py-1 text-center text-xs font-mono transition-colors ${
                    speed === s
                      ? 'text-[#2962ff] bg-[#2962ff]/10'
                      : (lightMode ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-[#787b86] hover:bg-[#363a45] hover:text-[#d1d4dc]')
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Progress text */}
        <span className={`text-[10px] font-mono tabular-nums ml-1 ${lightMode ? 'text-gray-600' : 'text-[#787b86]'}`}>
          {sessionActive ? `${(cursor + 1).toLocaleString()}/${totalCandles.toLocaleString()}` : '—'}
        </span>
      </div>
    </div>
  );
}
