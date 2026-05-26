import { useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { DrawingManager, TrendLine, Rectangle, FibRetracement } from 'lightweight-charts-drawing';
import type { CandleData, Position, ClosedTrade } from '../types';
import { calculateEMA, calculateSMA, calculateBollingerBands, calculateRSI, calculateMACD, calculateATR, calculateStochastic } from '../utils/indicators';

// ============================================================
// Theme Configs — TradingView institutional palette
// ============================================================

interface ChartTheme {
  bg: string;
  text: string;
  grid: string;
  crosshair: string;
  crosshairLabel: string;
  border: string;
  upColor: string;
  downColor: string;
  volUp: string;
  volDown: string;
}

const CHART_THEME: ChartTheme = {
  bg: '#121416',
  text: '#787b86',
  grid: '#1e222d',
  crosshair: '#4c525e',
  crosshairLabel: '#2a2e39',
  border: '#2a2e39',
  upColor: '#2e9461',
  downColor: '#ef5350',
  volUp: 'rgba(46,148,97,0.3)',
  volDown: 'rgba(239,83,80,0.3)',
};

// =============================================================================
// Chart — TradingView Lightweight Charts wrapper for OpenReplay.
//
// Renders a professional dark-themed candlestick chart with:
//   - Bulk setData() on session load
//   - Streaming update() during playback
//   - Dynamic SL/TP horizontal price lines (red / green dashed)
//   - Trade entry/exit arrow markers on candles
//   - Responsive resize handling
//   - Volume histogram overlay
// =============================================================================

type ActiveTool = 'NONE' | 'FIB' | 'RECTANGLE' | 'TEXT' | 'BRUSH' | 'LINE';

interface ChartProps {
  candles: CandleData[];
  positions: Position[];
  trades: ClosedTrade[];
  currentPrice: number;
  showMarkers?: boolean;
  lockToEdge?: boolean;
  timeframe: number;
  indicators: {
    ema20: boolean;
    sma50: boolean;
    bollinger: boolean;
    rsi: boolean;
    macd: boolean;
    atr: boolean;
    stochastic: boolean;
  };
  pendingOrderSL?: number;
  pendingOrderTP?: number;
  onPendingOrderSLChange?: (price: number) => void;
  onPendingOrderTPChange?: (price: number) => void;
  onPositionSLTPChange?: (positionId: number, sl: number, tp: number) => void;
  onPositionSLTPDrag?: (sl: number, tp: number, type: 'sl' | 'tp') => void;
  positionSLUnlocked?: boolean;
  positionTPUnlocked?: boolean;
  onDrawingManagerReady?: (manager: DrawingManager | null) => void;
  activeTool?: ActiveTool;
  onActiveToolChange?: (tool: ActiveTool) => void;
  chartLocked?: boolean;
  onChartLockedChange?: (locked: boolean) => void;
  lightMode?: boolean;
}

export function Chart({
  candles,
  positions,
  trades,
  showMarkers = true,
  lockToEdge = false,
  timeframe,
  indicators,
  pendingOrderSL,
  pendingOrderTP,
  onPendingOrderSLChange,
  onPendingOrderTPChange,
  onPositionSLTPChange,
  onPositionSLTPDrag,
  positionSLUnlocked = false,
  positionTPUnlocked = false,
  onDrawingManagerReady,
  activeTool = 'NONE',
  onActiveToolChange,
  chartLocked = false,
  onChartLockedChange,
  lightMode = false,
}: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const prevCandleLengthRef = useRef(0);
  const lastChartTimeRef = useRef<number | null>(null);
  const priceLinesRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>[]>([]);
  const tradeLinksRef = useRef<ISeriesApi<'Line'>[]>([]);
  const pendingSLLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const pendingTPLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const isDraggingSLRef = useRef(false);
  const isDraggingTPRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartPriceRef = useRef(0);
  const draggedPositionIdRef = useRef<number | null>(null);
  const draggedSLTPRef = useRef<'sl' | 'tp' | null>(null);
  const drawingManagerRef = useRef<DrawingManager | null>(null);

  // Drawing tool state
  const isDrawingRef = useRef(false);
  const drawingStartPointRef = useRef<{ time: number; price: number } | null>(null);
  const drawingEndPointRef = useRef<{ time: number; price: number } | null>(null);
  const tempDrawingIdRef = useRef<string | null>(null);
  const activeToolRef = useRef<'NONE' | 'FIB' | 'RECTANGLE' | 'TEXT' | 'BRUSH' | 'LINE'>('NONE');
  const drawingIdsRef = useRef<string[]>([]);
  const hasDraggedRef = useRef(false);

  // Indicator series refs
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const smaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollingerUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollingerLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollingerMiddleRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<'Line'> | null>(null);
  const atrSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const stochKRef = useRef<ISeriesApi<'Line'> | null>(null);
  const stochDRef = useRef<ISeriesApi<'Line'> | null>(null);

  // Playback buffering cache
  const indicatorCacheRef = useRef<Map<string, {
    ema?: LineData[];
    sma?: LineData[];
    bbUpper?: LineData[];
    bbLower?: LineData[];
    bbMiddle?: LineData[];
    rsi?: LineData[];
    macd?: LineData[];
    macdSignal?: LineData[];
    atr?: LineData[];
    stochK?: LineData[];
    stochD?: LineData[];
  }>>(new Map());

  // --- Convert our CandleData to lightweight-charts format ---
  const toLWC = useCallback((c: CandleData): CandlestickData => {
    return {
      time: c.timestamp as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    };
  }, []);

  // --- Initialize chart on mount ---
  useEffect(() => {
    if (!containerRef.current) return;
    const t = lightMode ? {
      bg: '#ffffff',
      text: '#6b7280',
      grid: '#e5e7eb',
      crosshair: '#6b7280',
      crosshairLabel: '#f3f4f6',
      border: '#d1d5db',
      upColor: '#2e9461',
      downColor: '#ef5350',
      volUp: 'rgba(46,148,97,0.3)',
      volDown: 'rgba(239,83,80,0.3)',
    } : CHART_THEME;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: t.bg },
        textColor: t.text,
        fontSize: 12,
        fontFamily: "'Inter', sans-serif",
      },
      grid: {
        vertLines: { color: t.grid },
        horzLines: { color: t.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: t.crosshair, labelBackgroundColor: t.crosshairLabel, style: LineStyle.Dashed },
        horzLine: { color: t.crosshair, labelBackgroundColor: t.crosshairLabel, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: t.border,
        scaleMargins: { top: 0.1, bottom: 0.25 },
      },
      timeScale: {
        borderColor: t.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 8,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    // Initialize indicator series FIRST (so they render behind candles)
    const emaSeries = chart.addLineSeries({
      color: '#2962ff',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const smaSeries = chart.addLineSeries({
      color: '#ff9800',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const bollingerUpper = chart.addLineSeries({
      color: 'rgba(100, 149, 237, 0.5)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const bollingerLower = chart.addLineSeries({
      color: 'rgba(100, 149, 237, 0.5)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const bollingerMiddle = chart.addLineSeries({
      color: 'rgba(100, 149, 237, 0.3)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // Add candlestick series LAST (so it renders on top of indicators)
    const candleSeries = chart.addCandlestickSeries({
      upColor: t.upColor,
      downColor: t.downColor,
      borderVisible: false,
      wickUpColor: t.upColor,
      wickDownColor: t.downColor,
    });

    const volumeSeries = chart.addHistogramSeries({
      color: t.volUp,
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    emaSeriesRef.current = emaSeries;
    smaSeriesRef.current = smaSeries;
    bollingerUpperRef.current = bollingerUpper;
    bollingerLowerRef.current = bollingerLower;
    bollingerMiddleRef.current = bollingerMiddle;
    prevCandleLengthRef.current = 0;

    // Initialize DrawingManager for drawing tools
    const drawingManager = new DrawingManager();
    drawingManager.attach(chart, candleSeries, containerRef.current);
    drawingManagerRef.current = drawingManager;

    // Notify parent that DrawingManager is ready
    if (onDrawingManagerReady) {
      onDrawingManagerReady(drawingManager);
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      drawingManager.detach();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      prevCandleLengthRef.current = 0;
      priceLinesRef.current = [];
      tradeLinksRef.current = [];
      drawingManagerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Update candle data (new simple approach - always setData, no view preservation) ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    const volSeries = volumeSeriesRef.current;
    if (!series || !volSeries) return;

    const t = lightMode ? {
      bg: '#ffffff',
      text: '#6b7280',
      grid: '#e5e7eb',
      crosshair: '#6b7280',
      crosshairLabel: '#f3f4f6',
      border: '#d1d5db',
      upColor: '#2e9461',
      downColor: '#ef5350',
      volUp: 'rgba(46,148,97,0.3)',
      volDown: 'rgba(239,83,80,0.3)',
    } : CHART_THEME;

    // If candles array is empty, clear the chart
    if (candles.length === 0) {
      series.setData([]);
      volSeries.setData([]);
      lastChartTimeRef.current = null;
      prevCandleLengthRef.current = 0;
      return;
    }

    // Helper: deduplicate and sort candles
    const prepareCandles = (candleData: CandleData[]) => {
      const uniqueCandles = candleData.filter((c, idx, self) =>
        self.findIndex((item) => item.timestamp === c.timestamp) === idx
      );
      uniqueCandles.sort((a, b) => a.timestamp - b.timestamp);
      return uniqueCandles;
    };

    const cleanHistory = prepareCandles(candles);

    // Always use setData - let chart auto-fit to content
    series.setData(cleanHistory.map(toLWC));
    volSeries.setData(cleanHistory.map((c) => ({
      time: c.timestamp as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? t.volUp : t.volDown,
    })));

    lastChartTimeRef.current = cleanHistory[cleanHistory.length - 1]?.timestamp ?? null;
    prevCandleLengthRef.current = candles.length;

    // Auto-scroll to right edge only when lockToEdge is enabled
    // When unlocked, users can freely pan/zoom during playback
    if (lockToEdge) {
      chartRef.current?.timeScale().scrollToPosition(2, false);
    }
  }, [candles, toLWC, lockToEdge]);

  // --- Indicator update effect (separate from locked candle rendering) ---
  useEffect(() => {
    const chart = chartRef.current;
    const emaSeries = emaSeriesRef.current;
    const smaSeries = smaSeriesRef.current;
    const bollingerUpper = bollingerUpperRef.current;
    const bollingerLower = bollingerLowerRef.current;
    const bollingerMiddle = bollingerMiddleRef.current;

    if (!chart || candles.length === 0) return;

    const lastChartTime = lastChartTimeRef.current;
    const cacheKey = `${candles.length}-${timeframe}-${indicators.ema20}-${indicators.sma50}-${indicators.bollinger}-${indicators.rsi}-${indicators.macd}-${indicators.atr}-${indicators.stochastic}`;

    // Timestamp guard: detect rewind and clear cache (but don't skip calculation)
    if (lastChartTime !== null && candles.length > 0) {
      const currentLastTime = candles[candles.length - 1].timestamp;
      if (currentLastTime < lastChartTime) {
        // Rewind detected: clear cache so indicators recalculate for new candle array
        indicatorCacheRef.current.clear();
        lastChartTimeRef.current = currentLastTime;
        // Continue to recalculate indicators for the shorter array
      }
    }

    // Check cache first for playback buffering
    if (indicatorCacheRef.current.has(cacheKey)) {
      const cached = indicatorCacheRef.current.get(cacheKey);
      if (indicators.ema20 && emaSeries) emaSeries.setData(cached?.ema || []);
      if (indicators.sma50 && smaSeries) smaSeries.setData(cached?.sma || []);
      if (indicators.bollinger && bollingerUpper && bollingerLower && bollingerMiddle) {
        bollingerUpper.setData(cached?.bbUpper || []);
        bollingerLower.setData(cached?.bbLower || []);
        bollingerMiddle.setData(cached?.bbMiddle || []);
      }
      if (indicators.rsi && rsiSeriesRef.current) rsiSeriesRef.current.setData(cached?.rsi || []);
      if (indicators.macd && macdSeriesRef.current) macdSeriesRef.current.setData(cached?.macd || []);
      if (indicators.macd && macdSignalRef.current) macdSignalRef.current.setData(cached?.macdSignal || []);
      if (indicators.atr && atrSeriesRef.current) atrSeriesRef.current.setData(cached?.atr || []);
      if (indicators.stochastic && stochKRef.current) stochKRef.current.setData(cached?.stochK || []);
      if (indicators.stochastic && stochDRef.current) stochDRef.current.setData(cached?.stochD || []);
      return;
    }

    // Calculate indicators (deep-copy isolation - never mutate source array)
    const cacheEntry: {
      ema?: LineData[];
      sma?: LineData[];
      bbUpper?: LineData[];
      bbLower?: LineData[];
      bbMiddle?: LineData[];
      rsi?: LineData[];
      macd?: LineData[];
      macdSignal?: LineData[];
      atr?: LineData[];
      stochK?: LineData[];
      stochD?: LineData[];
    } = {};

    if (indicators.ema20 && emaSeries) {
      const emaData = calculateEMA(candles, 20);
      emaSeries.setData(emaData);
      cacheEntry.ema = emaData;
    } else if (emaSeries) {
      emaSeries.setData([]);
    }

    if (indicators.sma50 && smaSeries) {
      const smaData = calculateSMA(candles, 50);
      smaSeries.setData(smaData);
      cacheEntry.sma = smaData;
    } else if (smaSeries) {
      smaSeries.setData([]);
    }

    if (indicators.bollinger && bollingerUpper && bollingerLower && bollingerMiddle) {
      const bbData = calculateBollingerBands(candles, 20, 2);
      bollingerUpper.setData(bbData.upper);
      bollingerLower.setData(bbData.lower);
      bollingerMiddle.setData(bbData.middle);
      cacheEntry.bbUpper = bbData.upper;
      cacheEntry.bbLower = bbData.lower;
      cacheEntry.bbMiddle = bbData.middle;
    } else {
      bollingerUpper?.setData([]);
      bollingerLower?.setData([]);
      bollingerMiddle?.setData([]);
    }

    if (indicators.macd && macdSeriesRef.current && macdSignalRef.current) {
      const macdData = calculateMACD(candles);
      macdSeriesRef.current.setData(macdData.macd);
      macdSignalRef.current.setData(macdData.signal);
      cacheEntry.macd = macdData.macd;
      cacheEntry.macdSignal = macdData.signal;
    } else {
      macdSeriesRef.current?.setData([]);
      macdSignalRef.current?.setData([]);
    }

    if (indicators.atr && atrSeriesRef.current) {
      const atrData = calculateATR(candles);
      atrSeriesRef.current.setData(atrData);
      cacheEntry.atr = atrData;
    } else {
      atrSeriesRef.current?.setData([]);
    }

    if (indicators.stochastic && stochKRef.current && stochDRef.current) {
      const stochData = calculateStochastic(candles);
      stochKRef.current.setData(stochData.k);
      stochDRef.current.setData(stochData.d);
      cacheEntry.stochK = stochData.k;
      cacheEntry.stochD = stochData.d;
    } else {
      stochKRef.current?.setData([]);
      stochDRef.current?.setData([]);
    }

    // Store in cache
    indicatorCacheRef.current.set(cacheKey, cacheEntry);

    // Update last chart time
    lastChartTimeRef.current = candles[candles.length - 1]?.timestamp ?? null;
  }, [candles, indicators]);

  // --- RSI sub-pane lifecycle ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (indicators.rsi && !rsiSeriesRef.current) {
      // Create RSI series on main chart with separate price scale
      const rsiSeries = chart.addLineSeries({
        color: '#785bf7',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        priceScaleId: 'rsi',
      });

      // Configure RSI price scale
      rsiSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });

      rsiSeriesRef.current = rsiSeries;

      // Add 30/70 reference lines
      rsiSeries.createPriceLine({
        price: 30,
        color: 'rgba(120, 91, 247, 0.3)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
      });

      rsiSeries.createPriceLine({
        price: 70,
        color: 'rgba(120, 91, 247, 0.3)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
      });
    } else if (!indicators.rsi && rsiSeriesRef.current) {
      // Remove RSI series
      try {
        chart.removeSeries(rsiSeriesRef.current);
      } catch { /* already removed */ }
      rsiSeriesRef.current = null;
    }
  }, [indicators.rsi]);

  // --- MACD sub-pane lifecycle ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (indicators.macd && !macdSeriesRef.current) {
      // Create MACD line series
      const macdSeries = chart.addLineSeries({
        color: '#2962ff',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        priceScaleId: 'macd',
      });

      // Create MACD signal line series
      const macdSignalSeries = chart.addLineSeries({
        color: '#ff6d00',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        priceScaleId: 'macd',
      });

      // Configure MACD price scale
      macdSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });

      macdSeriesRef.current = macdSeries;
      macdSignalRef.current = macdSignalSeries;
    } else if (!indicators.macd && macdSeriesRef.current) {
      try {
        chart.removeSeries(macdSeriesRef.current);
        chart.removeSeries(macdSignalRef.current!);
      } catch { /* already removed */ }
      macdSeriesRef.current = null;
      macdSignalRef.current = null;
    }
  }, [indicators.macd]);

  // --- ATR sub-pane lifecycle ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (indicators.atr && !atrSeriesRef.current) {
      // Create ATR series
      const atrSeries = chart.addLineSeries({
        color: '#9c27b0',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        priceScaleId: 'atr',
      });

      // Configure ATR price scale
      atrSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });

      atrSeriesRef.current = atrSeries;
    } else if (!indicators.atr && atrSeriesRef.current) {
      try {
        chart.removeSeries(atrSeriesRef.current);
      } catch { /* already removed */ }
      atrSeriesRef.current = null;
    }
  }, [indicators.atr]);

  // --- Stochastic sub-pane lifecycle ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (indicators.stochastic && !stochKRef.current) {
      // Create Stochastic %K series
      const stochKSeries = chart.addLineSeries({
        color: '#00bcd4',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        priceScaleId: 'stochastic',
      });

      // Create Stochastic %D series
      const stochDSeries = chart.addLineSeries({
        color: '#e91e63',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        priceScaleId: 'stochastic',
      });

      // Configure Stochastic price scale
      stochKSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });

      // Add 20/80 reference lines
      stochKSeries.createPriceLine({
        price: 20,
        color: 'rgba(0, 188, 212, 0.3)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
      });

      stochKSeries.createPriceLine({
        price: 80,
        color: 'rgba(0, 188, 212, 0.3)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
      });

      stochKRef.current = stochKSeries;
      stochDRef.current = stochDSeries;
    } else if (!indicators.stochastic && stochKRef.current) {
      try {
        chart.removeSeries(stochKRef.current);
        chart.removeSeries(stochDRef.current!);
      } catch { /* already removed */ }
      stochKRef.current = null;
      stochDRef.current = null;
    }
  }, [indicators.stochastic]);

  // --- RSI data update effect ---
  useEffect(() => {
    const rsiSeries = rsiSeriesRef.current;
    if (!rsiSeries || !indicators.rsi || candles.length === 0) return;

    const rsiData = calculateRSI(candles, 14);
    rsiSeries.setData(rsiData);
  }, [candles, indicators.rsi]);

  // --- MACD data update effect ---
  useEffect(() => {
    const macdSeries = macdSeriesRef.current;
    const macdSignalSeries = macdSignalRef.current;
    if (!macdSeries || !macdSignalSeries || !indicators.macd || candles.length === 0) return;

    const macdData = calculateMACD(candles);
    macdSeries.setData(macdData.macd);
    macdSignalSeries.setData(macdData.signal);
  }, [candles, indicators.macd]);

  // --- ATR data update effect ---
  useEffect(() => {
    const atrSeries = atrSeriesRef.current;
    if (!atrSeries || !indicators.atr || candles.length === 0) return;

    const atrData = calculateATR(candles);
    atrSeries.setData(atrData);
  }, [candles, indicators.atr]);

  // --- Stochastic data update effect ---
  useEffect(() => {
    const stochKSeries = stochKRef.current;
    const stochDSeries = stochDRef.current;
    if (!stochKSeries || !stochDSeries || !indicators.stochastic || candles.length === 0) return;

    const stochData = calculateStochastic(candles);
    stochKSeries.setData(stochData.k);
    stochDSeries.setData(stochData.d);
  }, [candles, indicators.stochastic]);

  // --- SL/TP price lines for open positions ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const line of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* already removed */ }
    }
    priceLinesRef.current = [];

    positions.forEach((pos) => {
      if (pos.stop_loss > 0) {
        const slColor = positionSLUnlocked ? '#f23645' : 'rgba(242, 54, 69, 0.4)'; // Dimmed when locked
        priceLinesRef.current.push(series.createPriceLine({
          price: pos.stop_loss,
          color: slColor,
          lineWidth: positionSLUnlocked ? 1 : 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'SL',
        }));
      }
      if (pos.take_profit > 0) {
        const tpColor = positionTPUnlocked ? '#089981' : 'rgba(8, 153, 129, 0.4)'; // Dimmed when locked
        priceLinesRef.current.push(series.createPriceLine({
          price: pos.take_profit,
          color: tpColor,
          lineWidth: positionTPUnlocked ? 1 : 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'TP',
        }));
      }
    });
  }, [positions, positionSLUnlocked, positionTPUnlocked]);

  // --- Pending order SL/TP lines (draggable) ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    // Remove existing pending lines
    if (pendingSLLineRef.current) {
      try { series.removePriceLine(pendingSLLineRef.current); } catch { /* already removed */ }
      pendingSLLineRef.current = null;
    }
    if (pendingTPLineRef.current) {
      try { series.removePriceLine(pendingTPLineRef.current); } catch { /* already removed */ }
      pendingTPLineRef.current = null;
    }

    // Create SL line if set
    if (pendingOrderSL && pendingOrderSL > 0) {
      pendingSLLineRef.current = series.createPriceLine({
        price: pendingOrderSL,
        color: '#f23645',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'SL',
      });
    }

    // Create TP line if set
    if (pendingOrderTP && pendingOrderTP > 0) {
      pendingTPLineRef.current = series.createPriceLine({
        price: pendingOrderTP,
        color: '#089981',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'TP',
      });
    }
  }, [pendingOrderSL, pendingOrderTP]);

  // --- Draggable SL/TP lines handling ---
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const container = containerRef.current;
    if (!chart || !series || !container) return;

    const handleMouseDown = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Drawing tool mode - intercept clicks when active tool is selected
      if (activeToolRef.current !== 'NONE') {
        const timeScale = chart.timeScale();
        const time = timeScale.coordinateToTime(x);
        const price = series.coordinateToPrice(y);

        if (time !== null && price !== null) {
          isDrawingRef.current = true;
          drawingStartPointRef.current = { time: time as any, price };
          hasDraggedRef.current = false; // Reset drag flag
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Only allow drag if clicking near the right edge (label area)
      // Labels are typically on the right side of the chart
      const labelAreaWidth = 80; // pixels from right edge
      const isInLabelArea = x > rect.width - labelAreaWidth;

      // Check if click is near open position SL/TP lines (allow anywhere on chart for position lines)
      // Only allow drag if the specific line is unlocked
      for (const pos of positions) {
        if (pos.stop_loss > 0 && positionSLUnlocked) {
          const slY = series.priceToCoordinate(pos.stop_loss);
          if (slY !== null && Math.abs(y - slY) < 30) {
            isDraggingSLRef.current = true;
            dragStartYRef.current = y;
            dragStartPriceRef.current = pos.stop_loss;
            draggedPositionIdRef.current = pos.id;
            draggedSLTPRef.current = 'sl';
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        if (pos.take_profit > 0 && positionTPUnlocked) {
          const tpY = series.priceToCoordinate(pos.take_profit);
          if (tpY !== null && Math.abs(y - tpY) < 30) {
            isDraggingTPRef.current = true;
            dragStartYRef.current = y;
            dragStartPriceRef.current = pos.take_profit;
            draggedPositionIdRef.current = pos.id;
            draggedSLTPRef.current = 'tp';
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
      }

      if (!isInLabelArea) return;

      // Check if click is near pending order SL line
      if (pendingOrderSL && pendingOrderSL > 0) {
        const slPrice = pendingOrderSL;
        const slY = series.priceToCoordinate(slPrice);
        if (slY !== null && Math.abs(y - slY) < 20) {
          isDraggingSLRef.current = true;
          dragStartYRef.current = y;
          dragStartPriceRef.current = slPrice;
          draggedPositionIdRef.current = null;
          draggedSLTPRef.current = null;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Check if click is near pending order TP line
      if (pendingOrderTP && pendingOrderTP > 0) {
        const tpPrice = pendingOrderTP;
        const tpY = series.priceToCoordinate(tpPrice);
        if (tpY !== null && Math.abs(y - tpY) < 20) {
          isDraggingTPRef.current = true;
          dragStartYRef.current = y;
          dragStartPriceRef.current = tpPrice;
          draggedPositionIdRef.current = null;
          draggedSLTPRef.current = null;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      // Drawing tool mode - update drawing while dragging
      if (isDrawingRef.current && drawingStartPointRef.current) {
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const timeScale = chart.timeScale();
        const time = timeScale.coordinateToTime(x);
        const price = series.coordinateToPrice(y);

        if (time !== null && price !== null) {
          // Mark that user has dragged
          hasDraggedRef.current = true;

          // Update end point for final drawing creation
          drawingEndPointRef.current = { time: time as any, price };

          // Update live preview with unique ID to avoid conflicts
          const manager = drawingManagerRef.current;
          if (manager && drawingStartPointRef.current) {
            const start = drawingStartPointRef.current;
            const tempId = `temp-drawing-${Date.now()}`;

            // Remove previous temp drawing if it exists
            if (tempDrawingIdRef.current) {
              try {
                manager.removeDrawing(tempDrawingIdRef.current);
              } catch (e) {
                // Drawing might not exist yet, ignore
              }
            }

            // Create new temp drawing with unique ID
            tempDrawingIdRef.current = tempId;

            if (activeToolRef.current === 'LINE') {
              const tempLine = new TrendLine(tempId, [
                { time: start.time as any, price: start.price },
                { time: time as any, price },
              ], {
                lineColor: '#2962FF',
                lineWidth: 2,
              });
              manager.addDrawing(tempLine);
            } else if (activeToolRef.current === 'RECTANGLE') {
              const tempRect = new Rectangle(tempId, [
                { time: start.time as any, price: start.price },
                { time: time as any, price },
              ], {
                lineColor: '#2962FF',
                lineWidth: 2,
              });
              manager.addDrawing(tempRect);
            } else if (activeToolRef.current === 'FIB') {
              const tempFib = new FibRetracement(tempId, [
                { time: start.time as any, price: start.price },
                { time: time as any, price },
              ]);
              manager.addDrawing(tempFib);
            }
          }
        }
        return;
      }

      if (!isDraggingSLRef.current && !isDraggingTPRef.current) return;

      const rect = container.getBoundingClientRect();
      const y = e.clientY - rect.top;

      // Convert pixel delta to price delta using the series
      const priceAtStart = series.coordinateToPrice(dragStartYRef.current);
      const priceAtCurrent = series.coordinateToPrice(y);

      if (priceAtStart !== null && priceAtCurrent !== null) {
        const priceDelta = priceAtCurrent - priceAtStart;
        const newPrice = Math.round((dragStartPriceRef.current + priceDelta) * 100) / 100;

        if (draggedPositionIdRef.current !== null && onPositionSLTPChange) {
          // Dragging open position SL/TP - send to backend immediately
          // Also call onPositionSLTPDrag to update order panel state for confirmation
          const pos = positions.find(p => p.id === draggedPositionIdRef.current);
          if (pos) {
            const sl = draggedSLTPRef.current === 'sl' ? newPrice : pos.stop_loss;
            const tp = draggedSLTPRef.current === 'tp' ? newPrice : pos.take_profit;
            onPositionSLTPChange(pos.id, sl, tp);
            if (onPositionSLTPDrag) {
              onPositionSLTPDrag(sl, tp, draggedSLTPRef.current || 'sl');
            }
          }
        } else {
          // Dragging pending order SL/TP
          if (isDraggingSLRef.current && onPendingOrderSLChange) {
            onPendingOrderSLChange(Math.max(0, newPrice));
          } else if (isDraggingTPRef.current && onPendingOrderTPChange) {
            onPendingOrderTPChange(Math.max(0, newPrice));
          }
        }
      }
    };

    const handleMouseUp = () => {
      // Drawing tool mode - finalize drawing on mouse up
      if (isDrawingRef.current && drawingStartPointRef.current && drawingEndPointRef.current) {
        // Only create drawing if user actually dragged (not just click-click)
        if (!hasDraggedRef.current) {
          // User clicked without dragging - just reset state
          isDrawingRef.current = false;
          drawingStartPointRef.current = null;
          drawingEndPointRef.current = null;
          if (tempDrawingIdRef.current) {
            const manager = drawingManagerRef.current;
            if (manager) {
              try {
                manager.removeDrawing(tempDrawingIdRef.current);
              } catch (e) {
                // Drawing might not exist, ignore
              }
            }
            tempDrawingIdRef.current = null;
          }
          return;
        }

        const manager = drawingManagerRef.current;

        if (manager) {
          const start = drawingStartPointRef.current;
          const end = drawingEndPointRef.current;
          const drawingId = `drawing-${Date.now()}`;

          // Create final drawing first (to prevent blink)
          if (activeToolRef.current === 'LINE') {
            const trendLine = new TrendLine(drawingId, [
              { time: start.time as any, price: start.price },
              { time: end.time as any, price: end.price },
            ], {
              lineColor: '#2962FF',
              lineWidth: 2,
            });
            manager.addDrawing(trendLine);
            drawingIdsRef.current.push(drawingId);
          } else if (activeToolRef.current === 'RECTANGLE') {
            const rect = new Rectangle(drawingId, [
              { time: start.time as any, price: start.price },
              { time: end.time as any, price: end.price },
            ], {
              lineColor: '#2962FF',
              lineWidth: 2,
            });
            manager.addDrawing(rect);
            drawingIdsRef.current.push(drawingId);
          } else if (activeToolRef.current === 'FIB') {
            const fib = new FibRetracement(drawingId, [
              { time: start.time as any, price: start.price },
              { time: end.time as any, price: end.price },
            ]);
            manager.addDrawing(fib);
            drawingIdsRef.current.push(drawingId);
          }

          // Remove temp drawing after final is created (to prevent blink)
          // Use requestAnimationFrame to ensure final drawing is rendered first
          if (tempDrawingIdRef.current) {
            const tempId = tempDrawingIdRef.current;
            requestAnimationFrame(() => {
              try {
                manager.removeDrawing(tempId);
              } catch (e) {
                // Drawing might not exist, ignore
              }
              tempDrawingIdRef.current = null;
            });
          }
        }

        // Reset drawing state and revert to NONE mode
        isDrawingRef.current = false;
        drawingStartPointRef.current = null;
        drawingEndPointRef.current = null;
        if (onActiveToolChange) {
          onActiveToolChange('NONE');
        }
        // Auto-unlock chart after placement
        if (onChartLockedChange) {
          onChartLockedChange(false);
        }
        return;
      }

      isDraggingSLRef.current = false;
      isDraggingTPRef.current = false;
      draggedPositionIdRef.current = null;
      draggedSLTPRef.current = null;
    };

    container.addEventListener('mousedown', handleMouseDown, { capture: true });
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Keyboard event listener for deleting selected drawings
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const manager = drawingManagerRef.current;
        if (manager && drawingIdsRef.current.length > 0) {
          // Delete the most recently created drawing
          // Since the library doesn't expose selection state, we delete the last one
          const lastDrawingId = drawingIdsRef.current[drawingIdsRef.current.length - 1];
          try {
            manager.removeDrawing(lastDrawingId);
            drawingIdsRef.current = drawingIdsRef.current.filter(id => id !== lastDrawingId);
          } catch (e) {
            // Drawing might not exist, ignore
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown, { capture: true } as any);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [pendingOrderSL, pendingOrderTP, onPendingOrderSLChange, onPendingOrderTPChange, onPositionSLTPChange, positions, positionSLUnlocked, positionTPUnlocked, activeTool, onActiveToolChange, candles]);

  // Lock/unlock chart based on activeTool selection and manual lock
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Sync ref with prop for immediate access in mouse handlers
    activeToolRef.current = activeTool;

    if (activeTool !== 'NONE' || chartLocked) {
      chart.applyOptions({ handleScroll: false, handleScale: false });
    } else {
      chart.applyOptions({ handleScroll: true, handleScale: true });
    }
  }, [activeTool, chartLocked]);

  // Update chart theme when lightMode changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const t = lightMode ? {
      bg: '#ffffff',
      text: '#6b7280',
      grid: '#e5e7eb',
      crosshair: '#6b7280',
      crosshairLabel: '#f3f4f6',
      border: '#d1d5db',
      upColor: '#2e9461',
      downColor: '#ef5350',
      volUp: 'rgba(46,148,97,0.3)',
      volDown: 'rgba(239,83,80,0.3)',
    } : CHART_THEME;

    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: t.bg },
        textColor: t.text,
      },
      grid: {
        vertLines: { color: t.grid },
        horzLines: { color: t.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: t.crosshair, labelBackgroundColor: t.crosshairLabel, style: LineStyle.Dashed },
        horzLine: { color: t.crosshair, labelBackgroundColor: t.crosshairLabel, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: t.border,
      },
      timeScale: {
        borderColor: t.border,
      },
    });
  }, [lightMode]);

  // --- Entry-to-exit dashed link lines for closed trades ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const s of tradeLinksRef.current) {
      try { chart.removeSeries(s); } catch { /* already removed */ }
    }
    tradeLinksRef.current = [];

    for (const trade of trades) {
      if (trade.opened_at >= trade.closed_at) continue;
      const isProfit = trade.realized_pnl >= 0;
      const lineColor = isProfit ? 'rgba(8,153,129,0.55)' : 'rgba(242,54,69,0.55)';

      const seg = chart.addLineSeries({
        color: lineColor,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      seg.setData([
        { time: trade.opened_at as UTCTimestamp, value: trade.entry_price },
        { time: trade.closed_at as UTCTimestamp, value: trade.entry_price },
      ]);
      tradeLinksRef.current.push(seg);
    }
  }, [trades]);

  // --- Trade markers (compact, deduplicated, toggleable) ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    if (!showMarkers) {
      series.setMarkers([]);
      return;
    }

    type Marker = {
      time: UTCTimestamp;
      position: 'aboveBar' | 'belowBar';
      color: string;
      shape: 'arrowUp' | 'arrowDown' | 'circle';
      text: string;
      size: number;
    };

    const raw: Marker[] = [];

    // Open positions — small entry arrow + price only
    for (const pos of positions) {
      raw.push({
        time: pos.opened_at as UTCTimestamp,
        position: pos.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: pos.side === 'buy' ? '#089981' : '#f23645',
        shape: pos.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: pos.entry_price.toFixed(2),
        size: 1,
      });
    }

    // Closed trades — entry arrow + exit circle with short PnL
    for (const trade of trades) {
      raw.push({
        time: trade.opened_at as UTCTimestamp,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: trade.side === 'buy' ? '#089981' : '#f23645',
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: trade.entry_price.toFixed(2),
        size: 1,
      });
      const pnl = Math.round(trade.realized_pnl);
      raw.push({
        time: trade.closed_at as UTCTimestamp,
        position: trade.side === 'buy' ? 'aboveBar' : 'belowBar',
        color: trade.realized_pnl >= 0 ? '#089981' : '#f23645',
        shape: 'circle',
        text: (pnl >= 0 ? '+' : '') + pnl,
        size: 1,
      });
    }

    // Sort required by lightweight-charts
    raw.sort((a, b) => (a.time as number) - (b.time as number));

    // Deduplicate: merge markers that share time + position + shape to avoid overlap
    const merged: Marker[] = [];
    for (const m of raw) {
      const existing = merged.find(
        (x) => x.time === m.time && x.position === m.position && x.shape === m.shape
      );
      if (existing) {
        existing.text = existing.text + ' / ' + m.text;
      } else {
        merged.push({ ...m });
      }
    }

    series.setMarkers(merged);
  }, [positions, trades, showMarkers]);

  return <div ref={containerRef} className="w-full h-full min-h-0" />;
}
