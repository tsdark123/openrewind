"use client";

import { useState, useRef, useEffect } from "react";
import { Play, SkipForward, GripVertical, ChevronUp, Pause } from "lucide-react";

interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// Generate sample candlestick data similar to the image
function generateCandleData(): CandleData[] {
  const data: CandleData[] = [];
  let basePrice = 15290;

  // Generate data that creates an uptrend similar to the image
  const priceMovements = [
    // Initial consolidation phase
    0, 5, -3, 8, -5, 3, -2, 6, -4, 2,
    // Start of uptrend
    10, -5, 15, -8, 12, -3, 20, -10, 25, -5,
    // Strong uptrend (middle section)
    15, 8, -12, 18, -5, 22, -8, 30, -15, 25,
    // Peak and consolidation
    -10, 35, -20, 15, -8, 20, -12, 18, 5, -3,
    12, -5, 8, -2, 15, -8, 10, 3, -5, 8,
    // Final section
    -3, 12, -8, 5, 2, -4, 8, -2, 6, -3,
  ];

  priceMovements.forEach((movement, i) => {
    const open = basePrice;
    const close = basePrice + movement;
    const high = Math.max(open, close) + Math.random() * 8;
    const low = Math.min(open, close) - Math.random() * 8;

    data.push({
      time: i,
      open,
      high,
      low,
      close,
    });

    basePrice = close;
  });

  return data;
}

interface PlaybackControlsProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  speed: string;
  setSpeed: (speed: string) => void;
}

function PlaybackControls({
  isOpen,
  setIsOpen,
  speed,
  setSpeed,
}: PlaybackControlsProps) {
  const speeds = ["1s", "5s", "10s", "15s", "30s", "1m", "3m", "5m"];

  return (
    <div className="absolute left-1/2 top-6 z-20 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-md bg-[#2a2e39] px-2 py-1.5 shadow-lg">
        {/* Grip handle */}
        <button className="text-[#787b86] hover:text-[#d1d4dc]">
          <GripVertical className="h-4 w-4" />
        </button>

        {/* Progress slider */}
        <div className="relative h-1 w-20 rounded-full bg-[#363a45]">
          <div className="absolute left-0 top-0 h-full w-1/4 rounded-full bg-[#2962ff]" />
          <div className="absolute left-1/4 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#2962ff] bg-[#2a2e39]">
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 rounded bg-[#2962ff] px-1.5 py-0.5 text-[9px] font-medium text-white">
              1
            </span>
          </div>
        </div>

        {/* Pause/Play icons */}
        <button className="flex h-5 w-5 items-center justify-center text-[#787b86] hover:text-[#d1d4dc]">
          <Pause className="h-3.5 w-3.5" />
        </button>

        {/* Speed dropdown */}
        <div className="relative">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-0.5 text-xs text-[#d1d4dc] hover:text-white"
          >
            {speed}
            <ChevronUp className="h-3 w-3" />
          </button>

          {isOpen && (
            <div className="absolute bottom-full left-0 mb-1 rounded bg-[#2a2e39] py-1 shadow-lg">
              {speeds.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setSpeed(s);
                    setIsOpen(false);
                  }}
                  className="block w-full px-4 py-1 text-left text-xs text-[#787b86] hover:bg-[#363a45] hover:text-[#d1d4dc]"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Skip forward button */}
        <button className="flex h-5 w-5 items-center justify-center text-[#787b86] hover:text-[#d1d4dc]">
          <SkipForward className="h-3.5 w-3.5" />
        </button>

        {/* Toggle switch */}
        <button className="flex h-5 w-9 items-center rounded-full bg-[#00c896] px-0.5">
          <div className="ml-auto h-4 w-4 rounded-full bg-white" />
        </button>
      </div>
    </div>
  );
}

export function ChartArea() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [candleData] = useState<CandleData[]>(generateCandleData);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState("1m");

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    // Clear canvas with chart background
    ctx.fillStyle = "#121416";
    ctx.fillRect(0, 0, width, height);

    // Fill right sidebar with background color
    ctx.fillStyle = "#121416";
    ctx.fillRect(width - 65, 0, 65, height);

    // Calculate price range
    const prices = candleData.flatMap((c) => [c.high, c.low]);
    const minPrice = Math.min(...prices) - 10;
    const maxPrice = Math.max(...prices) + 10;
    const priceRange = maxPrice - minPrice;

    // Chart dimensions
    const chartLeft = 0;
    const chartRight = width - 65;
    const chartTop = 10;
    const chartBottom = height - 35;
    const chartWidth = chartRight - chartLeft;
    const chartHeight = chartBottom - chartTop;

    // Draw grid lines (horizontal) - very subtle
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    const priceStep = 10;
    for (
      let price = Math.floor(minPrice / priceStep) * priceStep;
      price <= maxPrice;
      price += priceStep
    ) {
      const y = chartTop + ((maxPrice - price) / priceRange) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(chartLeft, y);
      ctx.lineTo(chartRight, y);
      ctx.stroke();
    }

    // Draw grid lines (vertical)
    const timeLabels = [
      "8",
      "06:00",
      "12:00",
      "18:00",
      "9",
      "06:00",
      "12:00",
      "18:00",
      "10",
      "06:00",
      "12:00",
      "18:00",
    ];
    const verticalSpacing = chartWidth / (timeLabels.length - 1);
    timeLabels.forEach((label, i) => {
      const x = chartLeft + i * verticalSpacing;
      ctx.beginPath();
      ctx.moveTo(x, chartTop);
      ctx.lineTo(x, chartBottom);
      ctx.stroke();

      // Draw time labels
      ctx.fillStyle = "#787b86";
      ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, x, chartBottom + 18);
    });

    // Draw horizontal separator line above time labels
    ctx.strokeStyle = "#2a2e39";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartLeft, chartBottom);
    ctx.lineTo(width, chartBottom);
    ctx.stroke();

    // Draw a horizontal dashed line at current price level
    const currentPrice = 15410.12;
    const currentPriceY =
      chartTop + ((maxPrice - currentPrice) / priceRange) * chartHeight;
    ctx.strokeStyle = "#f23645";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartLeft, currentPriceY);
    ctx.lineTo(chartRight, currentPriceY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw price label for current price
    ctx.fillStyle = "#f23645";
    ctx.fillRect(chartRight, currentPriceY - 9, 65, 18);
    ctx.fillStyle = "#ffffff";
    ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(currentPrice.toFixed(2), chartRight + 4, currentPriceY + 4);

    // Draw candlesticks
    const visibleCandles = candleData.slice(-40);
    const candleAreaWidth = chartWidth * 0.7;
    const candleSpacing = candleAreaWidth / visibleCandles.length;
    const candleWidth = Math.max(3, candleSpacing * 0.6);
    const startX = chartLeft + chartWidth * 0.25;

    visibleCandles.forEach((candle, i) => {
      const x = startX + i * candleSpacing;
      const isGreen = candle.close >= candle.open;

      const openY =
        chartTop + ((maxPrice - candle.open) / priceRange) * chartHeight;
      const closeY =
        chartTop + ((maxPrice - candle.close) / priceRange) * chartHeight;
      const highY =
        chartTop + ((maxPrice - candle.high) / priceRange) * chartHeight;
      const lowY =
        chartTop + ((maxPrice - candle.low) / priceRange) * chartHeight;

      // Draw wick
      ctx.strokeStyle = isGreen ? "#2e9461" : "#ef5350";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();

      // Draw body
      ctx.fillStyle = isGreen ? "#2e9461" : "#ef5350";
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(1, Math.abs(closeY - openY));
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });

    // Draw Y-axis labels (prices)
    ctx.fillStyle = "#787b86";
    ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "left";
    for (
      let price = Math.floor(minPrice / priceStep) * priceStep;
      price <= maxPrice;
      price += priceStep
    ) {
      const y = chartTop + ((maxPrice - price) / priceRange) * chartHeight;
      if (Math.abs(price - currentPrice) > 5) {
        ctx.fillText(price.toFixed(2), chartRight + 4, y + 4);
      }
    }
  }, [candleData]);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-[#121416]">
      {/* Chart canvas area */}
      <div ref={containerRef} className="relative flex-1">
        <canvas ref={canvasRef} className="absolute inset-0" />

        {/* Playback controls */}
        <PlaybackControls
          isOpen={isDropdownOpen}
          setIsOpen={setIsDropdownOpen}
          speed={playbackSpeed}
          setSpeed={setPlaybackSpeed}
        />

        {/* TradingView watermark */}
        <div className="absolute bottom-10 left-3">
          <svg
            className="h-6 w-6 text-[#2a2e39]"
            viewBox="0 0 36 28"
            fill="currentColor"
          >
            <path d="M14 22H7V6H0V0H21V6H14V22ZM36 22H29L22 0H29L32.5 14L36 0H43L36 22Z" />
          </svg>
        </div>
      </div>

      {/* Bottom time range bar - OUTSIDE the chart canvas */}
      <div className="flex h-7 items-center justify-between border-t border-[#2a2e39] bg-[#121416] px-3">
        <div className="flex items-center gap-1 text-[11px] text-[#787b86]">
          <button className="px-1 py-0.5 hover:text-[#d1d4dc]">1D</button>
          <button className="px-1 py-0.5 hover:text-[#d1d4dc]">5D</button>
          <button className="px-1 py-0.5 hover:text-[#d1d4dc]">1M</button>
          <button className="px-1 py-0.5 hover:text-[#d1d4dc]">3M</button>
          <button className="px-1 py-0.5 hover:text-[#d1d4dc]">6M</button>
          <button className="px-1 py-0.5 hover:text-[#d1d4dc]">YTD</button>
          <button className="px-1 py-0.5 hover:text-[#d1d4dc]">1Y</button>
          <button className="px-1 py-0.5 hover:text-[#d1d4dc]">5Y</button>
          <button className="px-1 py-0.5 hover:text-[#d1d4dc]">All</button>
          <button className="ml-1 text-[#787b86] hover:text-[#d1d4dc]">
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </svg>
          </button>
        </div>

        {/* Resize handle centered */}
        <div className="flex items-center justify-center">
          <div className="flex gap-0.5">
            <div className="h-1 w-1 rounded-full bg-[#787b86]/50" />
            <div className="h-1 w-1 rounded-full bg-[#787b86]/50" />
            <div className="h-1 w-1 rounded-full bg-[#787b86]/50" />
          </div>
        </div>

        {/* Bottom right controls */}
        <div className="flex items-center gap-2 text-[11px] text-[#787b86]">
          <span>09:27:02 (UTC)</span>
          <button className="hover:text-[#d1d4dc]">log</button>
          <button className="hover:text-[#d1d4dc]">%</button>
          <button className="text-[#2962ff]">auto</button>
          <button className="hover:text-[#d1d4dc]">
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="12" cy="12" r="2" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
