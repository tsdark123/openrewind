import type {
  ReferenceCandle,
  ReferenceWindow,
  ReferenceOhlc,
  ReferenceChange,
  ReferenceVolume,
  ReferenceCandleShape,
  ReferenceCompare,
  ReferenceSummary,
  BodyDirection,
} from './types.ts';

export function selectCandles(
  candles: readonly ReferenceCandle[],
  window: ReferenceWindow,
): ReferenceCandle[] {
  switch (window.kind) {
    case 'whole_session':
      return [...candles];
    case 'up_to_cursor': {
      const cursor = window.cursor ?? Infinity;
      return candles.filter((c) => c.timestamp <= cursor);
    }
    case 'time_range': {
      const from = window.fromTime ?? '00:00';
      const to = window.toTime ?? '23:59';
      const start = candles.findIndex((c) => c.marketTime >= from);
      const end = candles.findIndex((c) => c.marketTime >= to);
      if (start === -1) return [];
      return candles.slice(start, end === -1 ? undefined : end);
    }
    default: {
      const _exhaustive: never = window as never;
      throw new Error(`Unknown window kind: ${_exhaustive}`);
    }
  }
}

function direction(open: number, close: number): BodyDirection {
  if (close > open) return 'up';
  if (close < open) return 'down';
  return 'flat';
}

export function ohlc(candles: readonly ReferenceCandle[]): ReferenceOhlc {
  if (candles.length === 0) {
    throw new Error('ohlc requires at least one candle');
  }
  const first = candles[0];
  const last = candles[candles.length - 1];
  let high = -Infinity;
  let low = Infinity;
  let highAt = '';
  let lowAt = '';
  for (const c of candles) {
    if (c.high > high) {
      high = c.high;
      highAt = c.marketTime;
    }
    if (c.low < low) {
      low = c.low;
      lowAt = c.marketTime;
    }
  }
  return {
    open: first.open,
    high,
    low,
    close: last.close,
    candleCount: candles.length,
    firstMarketTime: first.marketTime,
    lastMarketTime: last.marketTime,
    highAt,
    lowAt,
  };
}

export function change(candles: readonly ReferenceCandle[]): ReferenceChange {
  const base = ohlc(candles);
  const absoluteChange = base.close - base.open;
  const percentChange =
    base.open === 0 ? 0 : (absoluteChange / Math.abs(base.open)) * 100;
  return {
    ...base,
    absoluteChange,
    percentChange,
    direction: direction(base.open, base.close),
  };
}

export function volume(candles: readonly ReferenceCandle[]): ReferenceVolume {
  if (candles.length === 0) {
    throw new Error('volume requires at least one candle');
  }
  const first = candles[0];
  const last = candles[candles.length - 1];
  let total = 0;
  let largest = -Infinity;
  let largestAt = '';
  for (const c of candles) {
    total += c.volume;
    if (c.volume > largest) {
      largest = c.volume;
      largestAt = c.marketTime;
    }
  }
  return {
    candleCount: candles.length,
    firstMarketTime: first.marketTime,
    lastMarketTime: last.marketTime,
    totalVolume: total,
    averageVolume: total / candles.length,
    largestVolume: largest,
    largestVolumeAt: largestAt,
  };
}

export function candleShape(c: ReferenceCandle): ReferenceCandleShape {
  const top = Math.max(c.open, c.close);
  const bottom = Math.min(c.open, c.close);
  return {
    candle: {
      marketTime: c.marketTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    },
    body: {
      direction: direction(c.open, c.close),
      size: top - bottom,
      topPrice: top,
      bottomPrice: bottom,
    },
    upperWick: c.high - top,
    lowerWick: bottom - c.low,
    range: c.high - c.low,
  };
}

export function compare(
  left: readonly ReferenceCandle[],
  right: readonly ReferenceCandle[],
): ReferenceCompare {
  const leftOhlc = ohlc(left);
  const rightOhlc = ohlc(right);
  const leftVol = volume(left);
  const rightVol = volume(right);
  const priceDeltaAbs = rightOhlc.close - leftOhlc.close;
  const priceDeltaPercent =
    leftOhlc.close === 0
      ? 0
      : (priceDeltaAbs / Math.abs(leftOhlc.close)) * 100;
  const volumeDeltaAbs = rightVol.totalVolume - leftVol.totalVolume;
  const volumeDeltaPercent =
    leftVol.totalVolume === 0
      ? 0
      : (volumeDeltaAbs / Math.abs(leftVol.totalVolume)) * 100;
  return {
    priceDeltaAbs,
    priceDeltaPercent,
    volumeDeltaAbs,
    volumeDeltaPercent,
  };
}

export function summary(candles: readonly ReferenceCandle[]): ReferenceSummary {
  const base = ohlc(candles);
  const ch = change(candles);
  const vol = volume(candles);
  let totalBody = 0;
  let totalUpper = 0;
  let totalLower = 0;
  for (const c of candles) {
    const top = Math.max(c.open, c.close);
    const bottom = Math.min(c.open, c.close);
    totalBody += top - bottom;
    totalUpper += c.high - top;
    totalLower += bottom - c.low;
  }
  return {
    ...base,
    ...ch,
    ...vol,
    averageBody: totalBody / candles.length,
    averageUpperWick: totalUpper / candles.length,
    averageLowerWick: totalLower / candles.length,
  };
}

export type CapabilityResult =
  | ReferenceOhlc
  | ReferenceChange
  | ReferenceVolume
  | ReferenceCandleShape
  | ReferenceCompare
  | ReferenceSummary;

export interface CapabilityRequest {
  capability: string;
  window?: ReferenceWindow;
  left?: ReferenceWindow;
  right?: ReferenceWindow;
  marketTime?: string;
}

export function computeCapability(
  candles: readonly ReferenceCandle[],
  req: CapabilityRequest,
): CapabilityResult {
  switch (req.capability) {
    case 'analysis.window_ohlc':
      return ohlc(selectCandles(candles, req.window ?? { kind: 'whole_session' }));
    case 'analysis.window_change':
      return change(selectCandles(candles, req.window ?? { kind: 'whole_session' }));
    case 'analysis.window_volume':
      return volume(selectCandles(candles, req.window ?? { kind: 'whole_session' }));
    case 'analysis.window_summary':
      return summary(selectCandles(candles, req.window ?? { kind: 'whole_session' }));
    case 'analysis.candle_shape': {
      if (!req.marketTime) {
        throw new Error('candle_shape requires marketTime');
      }
      const c = candles.find((x) => x.marketTime === req.marketTime);
      if (!c) {
        throw new Error(`No candle at marketTime ${req.marketTime}`);
      }
      return candleShape(c);
    }
    case 'analysis.window_compare': {
      const left = selectCandles(
        candles,
        req.left ?? { kind: 'whole_session' },
      );
      const right = selectCandles(
        candles,
        req.right ?? { kind: 'whole_session' },
      );
      return compare(left, right);
    }
    default:
      throw new Error(`Unsupported capability for reference calculation: ${req.capability}`);
  }
}
