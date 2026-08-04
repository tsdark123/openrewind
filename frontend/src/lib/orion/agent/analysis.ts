// =============================================================================
// analysis — Pure, deterministic window and candle-shape calculations.
//
// No fetch, React state, LLM, registry or side effects live here. The
// capability layer resolves candles from the chart or engine and passes them
// into these functions. Result shapes are fully typed and every formatted
// receipt message is derived only from those results.
// =============================================================================

import type { CandleData } from '../../../types';
import { toEtTime, formatTime } from '../planner';

export type AnalysisWindow =
  | { kind: 'whole_session' }
  | { kind: 'up_to_cursor' }
  | { kind: 'time_range'; fromTime: string; toTime: string };

export type BodyDirection = 'up' | 'down' | 'flat';
export type SessionPolicy = 'engine_returned_candles_for_requested_date' | 'chart_buffer_up_to_cursor';

export interface ResolvedWindowMeta {
  kind: 'whole_session' | 'up_to_cursor' | 'time_range';
  fromTime?: string;
  toTime?: string;
  requestedDate: string;
  resolvedDate: string;
  sessionPolicy: SessionPolicy;
  symbol: string;
  timeframe: number;
  candleCount: number;
  firstTimestamp: number;
  firstMarketTime: string;
  lastTimestamp: number;
  lastMarketTime: string;
}

export interface CandleInfo {
  symbol: string;
  date: string;
  timeframe: number;
  timestamp: number;
  marketTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface WindowOhlcResult {
  window: ResolvedWindowMeta;
  symbol: string;
  timeframe: number;
  candleCount: number;
  firstTimestamp: number;
  firstMarketTime: string;
  lastTimestamp: number;
  lastMarketTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  highAt: string;
  lowAt: string;
}

export interface WindowChangeResult {
  window: ResolvedWindowMeta;
  symbol: string;
  timeframe: number;
  candleCount: number;
  firstTimestamp: number;
  firstMarketTime: string;
  lastTimestamp: number;
  lastMarketTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  absoluteChange: number;
  percentChange: number | null;
  direction: BodyDirection;
}

export interface WindowVolumeResult {
  window: ResolvedWindowMeta;
  symbol: string;
  timeframe: number;
  candleCount: number;
  firstTimestamp: number;
  firstMarketTime: string;
  lastTimestamp: number;
  lastMarketTime: string;
  totalVolume: number;
  averageVolume: number;
  largestVolume: number;
  largestVolumeAt: string;
}

export interface CandleBody {
  direction: BodyDirection;
  size: number;
  topPrice: number;
  bottomPrice: number;
}

export interface CandleShapeResult {
  candle: CandleInfo;
  body: CandleBody;
  upperWick: number;
  lowerWick: number;
  range: number;
}

export interface WindowCompareResult {
  left: ResolvedWindowMeta;
  right: ResolvedWindowMeta;
  priceDeltaAbs: number;
  priceDeltaPercent: number | null;
  volumeDeltaAbs: number;
  volumeDeltaPercent: number | null;
}

export interface WindowSummaryResult {
  window: ResolvedWindowMeta;
  symbol: string;
  timeframe: number;
  candleCount: number;
  firstTimestamp: number;
  firstMarketTime: string;
  lastTimestamp: number;
  lastMarketTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  highAt: string;
  lowAt: string;
  absoluteChange: number;
  percentChange: number | null;
  direction: BodyDirection;
  totalVolume: number;
  averageVolume: number;
  largestVolume: number;
  largestVolumeAt: string;
  averageBody: number;
  averageUpperWick: number;
  averageLowerWick: number;
}

export type ValidationError = { ok: false; message: string };
export type ValidationSuccess = { ok: true };

function asFinite(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function validateCandle(c: CandleData): ValidationSuccess | ValidationError {
  const open = asFinite(c.open);
  const high = asFinite(c.high);
  const low = asFinite(c.low);
  const close = asFinite(c.close);
  const volume = asFinite(c.volume);
  const ts = asFinite(c.timestamp);

  if (open === null || high === null || low === null || close === null || volume === null || ts === null) {
    return { ok: false, message: 'Candle contains non-finite fields.' };
  }
  if (volume < 0) {
    return { ok: false, message: 'Candle volume is negative.' };
  }
  if (high < Math.max(open, close, low)) {
    return { ok: false, message: 'Candle high is below open, close or low.' };
  }
  if (low > Math.min(open, close, high)) {
    return { ok: false, message: 'Candle low is above open, close or high.' };
  }
  return { ok: true };
}

export function validateCandles(candles: CandleData[], date: string): ValidationSuccess | ValidationError {
  for (let i = 0; i < candles.length; i++) {
    const v = validateCandle(candles[i]);
    if (!v.ok) {
      const t = formatTime(toEtTime(candles[i].timestamp, date));
      return { ok: false, message: `Candle at ${t} (${i}): ${v.message}` };
    }
  }
  return { ok: true };
}

function marketTime(ts: number, date: string): string {
  return formatTime(toEtTime(ts, date));
}

export function computeWindowOhlc(candles: CandleData[], meta: ResolvedWindowMeta): WindowOhlcResult {
  if (candles.length === 0) {
    throw new Error('computeWindowOhlc requires at least one candle.');
  }
  const v = validateCandles(candles, meta.resolvedDate);
  if (!v.ok) {
    throw new Error(v.message);
  }

  let high = -Infinity;
  let low = Infinity;
  let highTs = 0;
  let lowTs = 0;

  for (const c of candles) {
    if (c.high > high) {
      high = c.high;
      highTs = c.timestamp;
    }
    if (c.low < low) {
      low = c.low;
      lowTs = c.timestamp;
    }
  }

  const first = candles[0];
  const last = candles[candles.length - 1];

  return {
    window: meta,
    symbol: meta.symbol,
    timeframe: meta.timeframe,
    candleCount: meta.candleCount,
    firstTimestamp: meta.firstTimestamp,
    firstMarketTime: meta.firstMarketTime,
    lastTimestamp: meta.lastTimestamp,
    lastMarketTime: meta.lastMarketTime,
    open: first.open,
    high,
    low,
    close: last.close,
    highAt: marketTime(highTs, meta.resolvedDate),
    lowAt: marketTime(lowTs, meta.resolvedDate),
  };
}

export function computeWindowChange(candles: CandleData[], meta: ResolvedWindowMeta): WindowChangeResult {
  if (candles.length === 0) {
    throw new Error('computeWindowChange requires at least one candle.');
  }
  const v = validateCandles(candles, meta.resolvedDate);
  if (!v.ok) {
    throw new Error(v.message);
  }
  const ohlc = computeWindowOhlc(candles, meta);
  const open = ohlc.open;
  const close = ohlc.close;
  const absoluteChange = close - open;
  const percentChange = open === 0 ? null : (absoluteChange / Math.abs(open)) * 100;
  const direction: BodyDirection = close > open ? 'up' : close < open ? 'down' : 'flat';

  return {
    ...ohlc,
    absoluteChange,
    percentChange,
    direction,
  };
}

export function computeWindowVolume(candles: CandleData[], meta: ResolvedWindowMeta): WindowVolumeResult {
  if (candles.length === 0) {
    throw new Error('computeWindowVolume requires at least one candle.');
  }
  const v = validateCandles(candles, meta.resolvedDate);
  if (!v.ok) {
    throw new Error(v.message);
  }

  let total = 0;
  let largest = -Infinity;
  let largestTs = 0;

  for (const c of candles) {
    total += c.volume;
    if (c.volume > largest) {
      largest = c.volume;
      largestTs = c.timestamp;
    }
  }

  return {
    window: meta,
    symbol: meta.symbol,
    timeframe: meta.timeframe,
    candleCount: meta.candleCount,
    firstTimestamp: meta.firstTimestamp,
    firstMarketTime: meta.firstMarketTime,
    lastTimestamp: meta.lastTimestamp,
    lastMarketTime: meta.lastMarketTime,
    totalVolume: total,
    averageVolume: total / candles.length,
    largestVolume: largest,
    largestVolumeAt: marketTime(largestTs, meta.resolvedDate),
  };
}

export function computeCandleShape(
  candle: CandleData,
  symbol: string,
  date: string,
  timeframe: number
): CandleShapeResult {
  const v = validateCandle(candle);
  if (!v.ok) {
    throw new Error(v.message);
  }

  const open = candle.open;
  const close = candle.close;
  const high = candle.high;
  const low = candle.low;
  const top = Math.max(open, close);
  const bottom = Math.min(open, close);
  const direction: BodyDirection = close > open ? 'up' : close < open ? 'down' : 'flat';

  return {
    candle: {
      symbol,
      date,
      timeframe,
      timestamp: candle.timestamp,
      marketTime: marketTime(candle.timestamp, date),
      open,
      high,
      low,
      close,
      volume: candle.volume,
    },
    body: {
      direction,
      size: top - bottom,
      topPrice: top,
      bottomPrice: bottom,
    },
    upperWick: high - top,
    lowerWick: bottom - low,
    range: high - low,
  };
}

export function computeWindowCompare(
  leftCandles: CandleData[],
  leftMeta: ResolvedWindowMeta,
  rightCandles: CandleData[],
  rightMeta: ResolvedWindowMeta
): WindowCompareResult {
  if (leftCandles.length === 0 || rightCandles.length === 0) {
    throw new Error('computeWindowCompare requires non-empty windows.');
  }
  const lv = validateCandles(leftCandles, leftMeta.resolvedDate);
  if (!lv.ok) {
    throw new Error(lv.message);
  }
  const rv = validateCandles(rightCandles, rightMeta.resolvedDate);
  if (!rv.ok) {
    throw new Error(rv.message);
  }

  const leftOhlc = computeWindowOhlc(leftCandles, leftMeta);
  const rightOhlc = computeWindowOhlc(rightCandles, rightMeta);
  const leftVol = computeWindowVolume(leftCandles, leftMeta);
  const rightVol = computeWindowVolume(rightCandles, rightMeta);

  const priceDeltaAbs = rightOhlc.close - leftOhlc.close;
  const priceDeltaPercent = leftOhlc.close === 0 ? null : (priceDeltaAbs / Math.abs(leftOhlc.close)) * 100;

  const volumeDeltaAbs = rightVol.totalVolume - leftVol.totalVolume;
  const volumeDeltaPercent = leftVol.totalVolume === 0 ? null : (volumeDeltaAbs / Math.abs(leftVol.totalVolume)) * 100;

  return {
    left: leftMeta,
    right: rightMeta,
    priceDeltaAbs,
    priceDeltaPercent,
    volumeDeltaAbs,
    volumeDeltaPercent,
  };
}

export function computeWindowSummary(candles: CandleData[], meta: ResolvedWindowMeta): WindowSummaryResult {
  if (candles.length === 0) {
    throw new Error('computeWindowSummary requires at least one candle.');
  }
  const v = validateCandles(candles, meta.resolvedDate);
  if (!v.ok) {
    throw new Error(v.message);
  }

  const ohlc = computeWindowOhlc(candles, meta);
  const change = computeWindowChange(candles, meta);
  const vol = computeWindowVolume(candles, meta);

  let totalBody = 0;
  let totalUpperWick = 0;
  let totalLowerWick = 0;

  for (const c of candles) {
    const top = Math.max(c.open, c.close);
    const bottom = Math.min(c.open, c.close);
    totalBody += top - bottom;
    totalUpperWick += c.high - top;
    totalLowerWick += bottom - c.low;
  }

  return {
    ...ohlc,
    absoluteChange: change.absoluteChange,
    percentChange: change.percentChange,
    direction: change.direction,
    totalVolume: vol.totalVolume,
    averageVolume: vol.averageVolume,
    largestVolume: vol.largestVolume,
    largestVolumeAt: vol.largestVolumeAt,
    averageBody: totalBody / candles.length,
    averageUpperWick: totalUpperWick / candles.length,
    averageLowerWick: totalLowerWick / candles.length,
  };
}

// ---------------------------------------------------------------------------
// Deterministic receipt formatters — every token is derived from the result.
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toFixed(2);
}

export function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`;
}

export function formatWindowOhlcMessage(r: WindowOhlcResult): string {
  return `${r.candleCount} candles for ${r.symbol} on ${r.window.resolvedDate} (${r.window.sessionPolicy}): open ${fmt(r.open)}, high ${fmt(r.high)} at ${r.highAt}, low ${fmt(r.low)} at ${r.lowAt}, close ${fmt(r.close)}.`;
}

export function formatWindowChangeMessage(r: WindowChangeResult): string {
  return `Change: open ${fmt(r.open)} to close ${fmt(r.close)} = ${fmt(r.absoluteChange)} (${formatPercent(r.percentChange)}), direction ${r.direction}.`;
}

export function formatWindowVolumeMessage(r: WindowVolumeResult): string {
  return `Volume over ${r.candleCount} candles: total ${fmt(r.totalVolume)}, average ${fmt(r.averageVolume)}, largest ${fmt(r.largestVolume)} at ${r.largestVolumeAt}.`;
}

export function formatCandleShapeMessage(r: CandleShapeResult): string {
  return `Candle at ${r.candle.marketTime}: ${r.body.direction} body ${fmt(r.body.size)}, upper wick ${fmt(r.upperWick)}, lower wick ${fmt(r.lowerWick)}, range ${fmt(r.range)}.`;
}

export function formatWindowCompareMessage(r: WindowCompareResult): string {
  const left = `${r.left.candleCount} candles (${r.left.firstMarketTime}–${r.left.lastMarketTime})`;
  const right = `${r.right.candleCount} candles (${r.right.firstMarketTime}–${r.right.lastMarketTime})`;
  return `${left} vs ${right}: close delta ${fmt(r.priceDeltaAbs)} (${formatPercent(r.priceDeltaPercent)}), volume delta ${fmt(r.volumeDeltaAbs)} (${formatPercent(r.volumeDeltaPercent)}).`;
}

export function formatWindowSummaryMessage(r: WindowSummaryResult): string {
  return `${r.candleCount} candles for ${r.symbol} on ${r.window.resolvedDate} (${r.window.sessionPolicy}): open ${fmt(r.open)}, close ${fmt(r.close)} (${r.direction} ${fmt(r.absoluteChange)}, ${formatPercent(r.percentChange)}). High ${fmt(r.high)} at ${r.highAt}, low ${fmt(r.low)} at ${r.lowAt}. Volume total ${fmt(r.totalVolume)}, average ${fmt(r.averageVolume)}, largest ${fmt(r.largestVolume)} at ${r.largestVolumeAt}. Average body ${fmt(r.averageBody)}, upper wick ${fmt(r.averageUpperWick)}, lower wick ${fmt(r.averageLowerWick)}.`;
}
