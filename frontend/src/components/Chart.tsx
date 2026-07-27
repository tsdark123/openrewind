import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
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
import { DrawingManager } from 'lightweight-charts-drawing';
import type { CandleData, CandleUpdatePayload, Position, ClosedTrade } from '../types';
import { calculateEMA, calculateSMA, calculateBollingerBands, calculateRSI, calculateMACD, calculateATR, calculateStochastic } from '../utils/indicators';
import { DrawingFsm } from './drawing/drawingFsm';
import type { ActiveTool } from './drawing/drawingTools';

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
// Chart — TradingView Lightweight Charts wrapper for OpenRewind.
//
// Renders a professional dark-themed candlestick chart with:
//   - Bulk setData() on session load
//   - Streaming update() during playback
//   - Dynamic SL/TP horizontal price lines (red / green dashed)
//   - Trade entry/exit arrow markers on candles
//   - Responsive resize handling
//   - Volume histogram overlay
// =============================================================================

interface ChartProps {
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
  onClearAll?: (clearHandler: () => void) => void;
  lightMode?: boolean;
}

export interface ChartHandle {
  updateCandle: (payload: CandleUpdatePayload) => void;
  setHistory: (candles: CandleData[]) => void;
  resetChart: () => void;
}

export const Chart = forwardRef<ChartHandle, ChartProps>(function Chart({
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
  onClearAll,
  lightMode = false,
}, ref) {
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

  // Drawing tool state — owned by the FSM. We track committed-drawing ids
  // separately so Backspace can pop the most-recent drawing.
  const fsmRef = useRef<DrawingFsm | null>(null);
  const drawingIdsRef = useRef<string[]>([]);

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

  // Internal candle history owned by Chart — never stored in React state.
  const candleHistoryRef = useRef<CandleData[]>([]);
  // Whether the time scale has been fitted at least once this session.
  const hasFittedRef = useRef(false);
  // Bumped whenever the history changes so the indicator effect recomputes.
  const [historyVersion, setHistoryVersion] = useState(0);
  // Cutoff timestamp for filtering "future" ghost markers on rewind.
  // Starts at Infinity so all markers are visible on a fresh session.
  const markerCutoffRef = useRef(Infinity);
  // Bumped whenever the cutoff changes so the markers effect re-runs.
  const [markerVersion, setMarkerVersion] = useState(0);
  // Timestamp of the very first bar in the loaded history (bar index 0).
  // Used for the "Max History Limit" boundary marker and scroll lock.
  const historyStartRef = useRef<number | null>(null);

  // --- Prop refs for stable event-handler closures ---
  // Updated synchronously on every render; allows the interaction
  // useEffect to register listeners ONCE (dep array []) without going stale.
  const positionsRef = useRef(positions);
  const positionSLUnlockedRef = useRef(positionSLUnlocked);
  const positionTPUnlockedRef = useRef(positionTPUnlocked);
  const pendingOrderSLRef = useRef(pendingOrderSL);
  const pendingOrderTPRef = useRef(pendingOrderTP);
  const chartLockedRef = useRef(chartLocked);
  const onPendingOrderSLChangeRef = useRef(onPendingOrderSLChange);
  const onPendingOrderTPChangeRef = useRef(onPendingOrderTPChange);
  const onPositionSLTPChangeRef = useRef(onPositionSLTPChange);
  const onPositionSLTPDragRef = useRef(onPositionSLTPDrag);
  const onActiveToolChangeRef = useRef(onActiveToolChange);
  positionsRef.current = positions;
  positionSLUnlockedRef.current = positionSLUnlocked;
  positionTPUnlockedRef.current = positionTPUnlocked;
  pendingOrderSLRef.current = pendingOrderSL;
  pendingOrderTPRef.current = pendingOrderTP;
  chartLockedRef.current = chartLocked;
  onPendingOrderSLChangeRef.current = onPendingOrderSLChange;
  onPendingOrderTPChangeRef.current = onPendingOrderTPChange;
  onPositionSLTPChangeRef.current = onPositionSLTPChange;
  onPositionSLTPDragRef.current = onPositionSLTPDrag;
  onActiveToolChangeRef.current = onActiveToolChange;

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
        tickMarkFormatter: (time: number | { timestamp: number }) => {
          // X-axis tick labels: UTC epoch → 12-hour ET via Intl API.
          const ts = typeof time === 'number' ? time : time.timestamp;
          const date = new Date(ts * 1000);
          return date.toLocaleTimeString('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });
        },
      },
      localization: {
        locale: 'en-US',
        timeFormatter: (timestamp: number) => {
          // Crosshair tooltip: show "9:30 AM · Jun 2" in ET.
          const date = new Date(timestamp * 1000);
          const timePart = date.toLocaleTimeString('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });
          const datePart = date.toLocaleDateString('en-US', {
            timeZone: 'America/New_York',
            month: 'short',
            day: 'numeric',
          });
          return `${timePart} · ${datePart}`;
        },
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

    // Initialize the placement FSM
    const fsm = new DrawingFsm(drawingManager, {
      onCommitted: (drawingId) => {
        drawingIdsRef.current.push(drawingId);
      },
      onFinalize: () => {
        // Drawing tools are sticky: after a placement we keep the same tool
        // selected so the user can keep drawing. The toolbar category icon
        // therefore stays blue and the chart stays in drawing/locked mode.
      },
    });
    fsmRef.current = fsm;

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

    // Soft scroll lock: when the chart is explicitly locked, prevent the user
    // from panning more than one bar before the first data bar so the chart
    // never shows a fully blank canvas. When unlocked, scaling/panning is free.
    let isClampingScroll = false;
    const handleRangeChange = (range: { from: number; to: number } | null) => {
      if (!chartLockedRef.current || !range || isClampingScroll || range.from >= -1) return;
      isClampingScroll = true;
      requestAnimationFrame(() => {
        chart.timeScale().setVisibleLogicalRange({ from: -1, to: range.to });
        isClampingScroll = false;
      });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange);
      resizeObserver.disconnect();
      fsm.destroy();
      drawingManager.detach();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      prevCandleLengthRef.current = 0;
      priceLinesRef.current = [];
      tradeLinksRef.current = [];
      drawingManagerRef.current = null;
      fsmRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Internal helper: push history array into the LWC series ---
  const applyHistory = useCallback((history: CandleData[]) => {
    const series = candleSeriesRef.current;
    const volSeries = volumeSeriesRef.current;
    if (!series || !volSeries) return;
    const t = lightMode ? {
      volUp: 'rgba(46,148,97,0.3)', volDown: 'rgba(239,83,80,0.3)',
      upColor: '#2e9461', downColor: '#ef5350',
    } : CHART_THEME;
    series.setData(history.map(toLWC));
    volSeries.setData(history.map((c) => ({
      time: c.timestamp as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? t.volUp : t.volDown,
    })));
    lastChartTimeRef.current = history[history.length - 1]?.timestamp ?? null;
    if (lockToEdge) chartRef.current?.timeScale().scrollToPosition(2, false);
  }, [lightMode, toLWC, lockToEdge]);

  // --- Expose imperative handle for direct chart updates from WS callback ---
  useImperativeHandle(ref, () => ({
    resetChart() {
      candleHistoryRef.current = [];
      lastChartTimeRef.current = null;
      prevCandleLengthRef.current = 0;
      hasFittedRef.current = false;
      markerCutoffRef.current = Infinity;
      historyStartRef.current = null;
      indicatorCacheRef.current.clear();
      candleSeriesRef.current?.setData([]);
      volumeSeriesRef.current?.setData([]);
      setHistoryVersion((v) => v + 1);
      setMarkerVersion((v) => v + 1);
    },

    // Authoritative history from the engine (session start, rewind, seek,
    // timeframe change). Always a full redraw via setData().
    setHistory(incoming: CandleData[]) {
      // Guarantee strictly-ascending, unique timestamps — lightweight-charts
      // silently misbehaves (overwrites one bar in place) otherwise.
      const clean = [...incoming]
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((c, i, arr) => i === 0 || c.timestamp !== arr[i - 1].timestamp);

      candleHistoryRef.current = clean;
      indicatorCacheRef.current.clear();
      // Track the very first bar for the boundary marker + scroll lock.
      historyStartRef.current = clean[0]?.timestamp ?? null;
      // Advance the marker cutoff to the last bar so we see all markers
      // that fall on or before the new frontier (handles rewind correctly).
      markerCutoffRef.current = clean[clean.length - 1]?.timestamp ?? Infinity;
      applyHistory(clean);

      // Only auto-fit the very first time we get data for a session, so
      // later resyncs (order fills, etc.) don't yank the user's zoom/pan.
      if (clean.length > 0 && !hasFittedRef.current) {
        hasFittedRef.current = true;
        chartRef.current?.timeScale().fitContent();
      }
      setHistoryVersion((v) => v + 1);
      setMarkerVersion((v) => v + 1);
    },

    updateCandle(payload: CandleUpdatePayload) {
      const series = candleSeriesRef.current;
      const volSeries = volumeSeriesRef.current;
      if (!series || !volSeries) return;

      const t = lightMode
        ? { volUp: 'rgba(46,148,97,0.3)', volDown: 'rgba(239,83,80,0.3)' }
        : CHART_THEME;

      // Bucket the incoming 1-minute bar into the active timeframe so
      // forward ticks merge into the forming bar instead of creating
      // sub-interval bars the time scale can't lay out.
      const tfSeconds = Math.max(1, timeframe) * 60;
      const bucket = Math.floor(payload.timestamp / tfSeconds) * tfSeconds;

      const history = candleHistoryRef.current;
      const last = history.length > 0 ? history[history.length - 1] : null;

      // --- Rewind: incoming bar predates our last bar -------------------
      // Never use series.update() here; going backwards with a non-ascending
      // time key makes lightweight-charts rewrite the same bar in place.
      // Truncate to everything strictly before the incoming bucket, then
      // redraw the whole past timeline with setData().
      if (last && bucket < last.timestamp) {
        let cut = history.length;
        while (cut > 0 && history[cut - 1].timestamp >= bucket) cut--;
        const truncated = history.slice(0, cut);
        truncated.push({
          timestamp: bucket,
          open: payload.open,
          high: payload.high,
          low: payload.low,
          close: payload.close,
          volume: payload.volume,
        });
        candleHistoryRef.current = truncated;
        indicatorCacheRef.current.clear();
        markerCutoffRef.current = truncated[truncated.length - 1]?.timestamp ?? Infinity;
        applyHistory(truncated);
        setHistoryVersion((v) => v + 1);
        setMarkerVersion((v) => v + 1);
        return;
      }

      // --- Forward: merge into the forming bar or append a new one ------
      let bar: CandleData;
      if (last && bucket === last.timestamp) {
        bar = {
          timestamp: bucket,
          open: last.open,
          high: Math.max(last.high, payload.high),
          low: Math.min(last.low, payload.low),
          close: payload.close,
          // At 1m the engine resends the same bar, so replace rather than sum.
          volume: tfSeconds === 60 ? payload.volume : last.volume + payload.volume,
        };
        history[history.length - 1] = bar;
      } else {
        bar = {
          timestamp: bucket,
          open: payload.open,
          high: payload.high,
          low: payload.low,
          close: payload.close,
          volume: payload.volume,
        };
        history.push(bar);
      }

      lastChartTimeRef.current = bucket;
      // Advance the cutoff so forward playback never hides newly-reached markers.
      markerCutoffRef.current = bucket;
      series.update(toLWC(bar));
      volSeries.update({
        time: bucket as UTCTimestamp,
        value: bar.volume,
        color: bar.close >= bar.open ? t.volUp : t.volDown,
      });

      // series.update() never adjusts the visible range. On a chart that has
      // never been fitted the bars land outside the viewport and nothing
      // appears to happen — fit once so playback is visible immediately.
      if (!hasFittedRef.current) {
        hasFittedRef.current = true;
        chartRef.current?.timeScale().fitContent();
      } else if (lockToEdge) {
        chartRef.current?.timeScale().scrollToRealTime();
      }

      setHistoryVersion((v) => v + 1);
    },
  }), [lightMode, toLWC, lockToEdge, applyHistory, timeframe]);

  // --- Indicator update effect (separate from locked candle rendering) ---
  useEffect(() => {
    const chart = chartRef.current;
    const emaSeries = emaSeriesRef.current;
    const smaSeries = smaSeriesRef.current;
    const bollingerUpper = bollingerUpperRef.current;
    const bollingerLower = bollingerLowerRef.current;
    const bollingerMiddle = bollingerMiddleRef.current;

    // Use the imperative history ref — candles prop is always [] now.
    const candles = candleHistoryRef.current;
    if (!chart || candles.length === 0) return;

    const cacheKey = `${candles.length}-${timeframe}-${indicators.ema20}-${indicators.sma50}-${indicators.bollinger}-${indicators.rsi}-${indicators.macd}-${indicators.atr}-${indicators.stochastic}`;

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
  }, [indicators, historyVersion]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const candles = candleHistoryRef.current;
    if (!rsiSeries || !indicators.rsi || candles.length === 0) return;

    const rsiData = calculateRSI(candles, 14);
    rsiSeries.setData(rsiData);
  }, [historyVersion, indicators.rsi]);

  // --- MACD data update effect ---
  useEffect(() => {
    const macdSeries = macdSeriesRef.current;
    const macdSignalSeries = macdSignalRef.current;
    const candles = candleHistoryRef.current;
    if (!macdSeries || !macdSignalSeries || !indicators.macd || candles.length === 0) return;

    const macdData = calculateMACD(candles);
    macdSeries.setData(macdData.macd);
    macdSignalSeries.setData(macdData.signal);
  }, [historyVersion, indicators.macd]);

  // --- ATR data update effect ---
  useEffect(() => {
    const atrSeries = atrSeriesRef.current;
    const candles = candleHistoryRef.current;
    if (!atrSeries || !indicators.atr || candles.length === 0) return;

    const atrData = calculateATR(candles);
    atrSeries.setData(atrData);
  }, [historyVersion, indicators.atr]);

  // --- Stochastic data update effect ---
  useEffect(() => {
    const stochKSeries = stochKRef.current;
    const stochDSeries = stochDRef.current;
    const candles = candleHistoryRef.current;
    if (!stochKSeries || !stochDSeries || !indicators.stochastic || candles.length === 0) return;

    const stochData = calculateStochastic(candles);
    stochKSeries.setData(stochData.k);
    stochDSeries.setData(stochData.d);
  }, [historyVersion, indicators.stochastic]);

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

  // --- Draggable SL/TP lines handling + FSM drawing placement ---
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const container = containerRef.current;
    const fsm = fsmRef.current;
    if (!chart || !series || !container || !fsm) return;

    const handleMouseDown = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Drawing tool mode - FSM handles placement
      if (fsm.isActive()) {
        const timeScale = chart.timeScale();
        const time = timeScale.coordinateToTime(x);
        const price = series.coordinateToPrice(y);

        if (time !== null && price !== null) {
          const outcome = fsm.onMouseDown({ time: time as any, price });
          if (outcome.consumed) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
      }

      // SL/TP line drag logic (unchanged)
      for (const pos of positionsRef.current) {
        if (pos.stop_loss > 0 && positionSLUnlockedRef.current) {
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
        if (pos.take_profit > 0 && positionTPUnlockedRef.current) {
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

      if (pendingOrderSLRef.current && pendingOrderSLRef.current > 0) {
        const slPrice = pendingOrderSLRef.current;
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

      if (pendingOrderTPRef.current && pendingOrderTPRef.current > 0) {
        const tpPrice = pendingOrderTPRef.current;
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
      // Drawing tool mode - FSM updates preview
      if (fsm.isPlacing()) {
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const timeScale = chart.timeScale();
        const time = timeScale.coordinateToTime(x);
        const price = series.coordinateToPrice(y);

        if (time !== null && price !== null) {
          fsm.onMouseMove({ time: time as any, price });
        }
        return;
      }

      // SL/TP drag logic (unchanged)
      if (!isDraggingSLRef.current && !isDraggingTPRef.current) return;

      const rect = container.getBoundingClientRect();
      const y = e.clientY - rect.top;

      const priceAtStart = series.coordinateToPrice(dragStartYRef.current);
      const priceAtCurrent = series.coordinateToPrice(y);

      if (priceAtStart !== null && priceAtCurrent !== null) {
        const priceDelta = priceAtCurrent - priceAtStart;
        const newPrice = Math.round((dragStartPriceRef.current + priceDelta) * 100) / 100;

        if (draggedPositionIdRef.current !== null && onPositionSLTPChangeRef.current) {
          const pos = positionsRef.current.find(p => p.id === draggedPositionIdRef.current);
          if (pos) {
            const sl = draggedSLTPRef.current === 'sl' ? newPrice : pos.stop_loss;
            const tp = draggedSLTPRef.current === 'tp' ? newPrice : pos.take_profit;
            onPositionSLTPChangeRef.current(pos.id, sl, tp);
            if (onPositionSLTPDragRef.current) {
              onPositionSLTPDragRef.current(sl, tp, draggedSLTPRef.current || 'sl');
            }
          }
        } else {
          if (isDraggingSLRef.current && onPendingOrderSLChangeRef.current) {
            onPendingOrderSLChangeRef.current(Math.max(0, newPrice));
          } else if (isDraggingTPRef.current && onPendingOrderTPChangeRef.current) {
            onPendingOrderTPChangeRef.current(Math.max(0, newPrice));
          }
        }
      }
    };

    const handleMouseUp = () => {
      // Drawing tool mode - FSM finalizes placement
      if (fsm.isPlacing()) {
        const outcome = fsm.onMouseUp();
        if (outcome.consumed) return;
      }

      // SL/TP drag cleanup (unchanged)
      isDraggingSLRef.current = false;
      isDraggingTPRef.current = false;
      draggedPositionIdRef.current = null;
      draggedSLTPRef.current = null;
    };

    container.addEventListener('mousedown', handleMouseDown, { capture: true });
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Keyboard: Backspace/Delete removes last drawing, Escape cancels placement
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const manager = drawingManagerRef.current;
        if (manager && drawingIdsRef.current.length > 0) {
          const lastDrawingId = drawingIdsRef.current[drawingIdsRef.current.length - 1];
          try {
            manager.removeDrawing(lastDrawingId);
            drawingIdsRef.current = drawingIdsRef.current.filter(id => id !== lastDrawingId);
          } catch {
            /* ignore */
          }
        }
      } else if (e.key === 'Escape') {
        fsm.cancel();
        if (onActiveToolChangeRef.current) {
          onActiveToolChangeRef.current('NONE');
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock/unlock chart based on activeTool selection and manual lock
  useEffect(() => {
    const chart = chartRef.current;
    const fsm = fsmRef.current;
    if (!chart || !fsm) return;

    // Sync FSM with prop when tool changes externally (e.g., from toolbar)
    if (activeTool !== fsm.getTool()) {
      fsm.setTool(activeTool);
    }

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

  // Handle clearAll callback from parent (e.g., toolbar trash button)
  const handleClearAll = useCallback(() => {
    const manager = drawingManagerRef.current;
    const fsm = fsmRef.current;
    if (manager) {
      manager.clearAll();
      drawingIdsRef.current = [];
    }
    if (fsm) {
      fsm.cancel();
    }
  }, []);

  // Call onClearAll when parent requests it (via callback ref)
  useEffect(() => {
    if (onClearAll) {
      onClearAll(handleClearAll);
    }
  }, [onClearAll, handleClearAll]);

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

    const cutoff = markerCutoffRef.current;
    const historyStart = historyStartRef.current;
    const raw: Marker[] = [];

    // Always pin a boundary marker at bar 0 so traders know exactly
    // where the available history begins — regardless of SL/TP changes.
    if (historyStart !== null) {
      raw.push({
        time: historyStart as UTCTimestamp,
        position: 'belowBar',
        color: '#4c525e',
        shape: 'arrowUp',
        text: '◀ Max History Limit',
        size: 0,
      });
    }

    // Open positions — small entry arrow + price only
    for (const pos of positions) {
      if ((pos.opened_at as number) > cutoff) continue;
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
      if ((trade.opened_at as number) > cutoff) continue;
      raw.push({
        time: trade.opened_at as UTCTimestamp,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: trade.side === 'buy' ? '#089981' : '#f23645',
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: trade.entry_price.toFixed(2),
        size: 1,
      });
      if ((trade.closed_at as number) > cutoff) continue;
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
  }, [positions, trades, showMarkers, markerVersion]);

  return (
    <div className="relative w-full h-full min-h-0">
      {/* Chart canvas — fills the wrapper completely */}
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
});
