import { describe, it, expect } from 'vitest';
import { toEngineTs } from '../../planner';
import type { CandleData } from '../../../../types';
import {
  validateCandle,
  validateCandles,
  computeWindowOhlc,
  computeWindowChange,
  computeWindowVolume,
  computeCandleShape,
  computeWindowCompare,
  computeWindowSummary,
  formatPercent,
  formatWindowOhlcMessage,
  formatWindowChangeMessage,
  formatWindowVolumeMessage,
  formatCandleShapeMessage,
  formatWindowCompareMessage,
  formatWindowSummaryMessage,
  type ResolvedWindowMeta,
} from '../analysis';

const FIXTURE_DATE = '2026-07-10';
const FIXTURE_SYMBOL = 'AAPL';
const FIXTURE_TF = 1;

function metaFor(candles: CandleData[], kind: ResolvedWindowMeta['kind'] = 'whole_session', fromTime?: string, toTime?: string): ResolvedWindowMeta {
  return {
    kind,
    fromTime,
    toTime,
    requestedDate: FIXTURE_DATE,
    resolvedDate: FIXTURE_DATE,
    sessionPolicy: 'engine_returned_candles_for_requested_date',
    symbol: FIXTURE_SYMBOL,
    timeframe: FIXTURE_TF,
    candleCount: candles.length,
    firstTimestamp: candles[0].timestamp,
    firstMarketTime: '09:30',
    lastTimestamp: candles[candles.length - 1].timestamp,
    lastMarketTime: '09:34',
  };
}

function buildMinuteCandles(count: number, startHour = 9, startMinute = 30): CandleData[] {
  const start = toEngineTs(FIXTURE_DATE, startHour, startMinute);
  const candles: CandleData[] = [];
  for (let i = 0; i < count; i++) {
    const ts = start + i * 60;
    candles.push({
      timestamp: ts,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

function buildTieCandles(): CandleData[] {
  const start = toEngineTs(FIXTURE_DATE, 9, 30);
  return [
    { timestamp: start, open: 100, high: 105, low: 99, close: 102, volume: 1000 },
    { timestamp: start + 60, open: 102, high: 105, low: 98, close: 104, volume: 2000 },
    { timestamp: start + 120, open: 104, high: 105, low: 98, close: 101, volume: 2000 },
  ];
}

const baseCandles = buildMinuteCandles(5);

function allMessageNumbers(message: string): string[] {
  // Matches signed/unsigned decimals like +1.25, -3.00, 100.50
  return (message.match(/[+-]?\d+(?:\.\d+)?/g) ?? []).map((s) => s.replace(/\+$/, ''));
}

describe('validateCandle', () => {
  it('passes for a coherent candle', () => {
    expect(validateCandle(baseCandles[0]).ok).toBe(true);
  });

  it('fails for high below low', () => {
    const c = { ...baseCandles[0], high: 98 };
    expect(validateCandle(c).ok).toBe(false);
  });

  it('fails for high below close', () => {
    const c = { ...baseCandles[0], high: 100.2, close: 101 };
    expect(validateCandle(c).ok).toBe(false);
  });

  it('fails for low above open', () => {
    const c = { ...baseCandles[0], low: 100.5, open: 100 };
    expect(validateCandle(c).ok).toBe(false);
  });

  it('fails for negative volume', () => {
    const c = { ...baseCandles[0], volume: -1 };
    expect(validateCandle(c).ok).toBe(false);
  });

  it('fails for non-finite fields', () => {
    const c = { ...baseCandles[0], close: NaN };
    expect(validateCandle(c).ok).toBe(false);
  });
});

describe('validateCandles', () => {
  it('reports the time and index of an invalid candle', () => {
    const candles = [...baseCandles];
    candles[2] = { ...candles[2], high: 90 };
    const v = validateCandles(candles, FIXTURE_DATE);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/09:32/);
    expect(v.message).toMatch(/\(2\)/);
  });
});

describe('formatPercent', () => {
  it('formats percentage points with % symbol', () => {
    expect(formatPercent(1.25)).toBe('1.25%');
  });

  it('returns n/a for null', () => {
    expect(formatPercent(null)).toBe('n/a');
  });
});

describe('computeWindowOhlc', () => {
  it('returns the first candle open and last candle close', () => {
    const r = computeWindowOhlc(baseCandles, metaFor(baseCandles));
    expect(r.open).toBe(baseCandles[0].open);
    expect(r.close).toBe(baseCandles[baseCandles.length - 1].close);
    expect(r.candleCount).toBe(5);
  });

  it('uses the earliest candle tying for the high', () => {
    const candles = buildTieCandles();
    const r = computeWindowOhlc(candles, metaFor(candles));
    expect(r.high).toBe(105);
    expect(r.highAt).toBe('09:30');
  });

  it('uses the earliest candle tying for the low', () => {
    const candles = buildTieCandles();
    const r = computeWindowOhlc(candles, metaFor(candles));
    expect(r.low).toBe(98);
    expect(r.lowAt).toBe('09:31');
  });

  it('rejects malformed window data', () => {
    const candles = [...baseCandles];
    candles[1] = { ...candles[1], high: 90 };
    expect(() => computeWindowOhlc(candles, metaFor(candles))).toThrow(/high/);
  });
});

describe('computeWindowChange', () => {
  it('calculates absolute and percentage change', () => {
    const candles = buildMinuteCandles(5);
    const r = computeWindowChange(candles, metaFor(candles));
    expect(r.absoluteChange).toBe(candles[4].close - candles[0].open);
    expect(r.percentChange).toBe((r.absoluteChange / Math.abs(candles[0].open)) * 100);
    expect(r.direction).toBe('up');
  });

  it('returns null percent when open is zero', () => {
    const candles = [
      { timestamp: toEngineTs(FIXTURE_DATE, 9, 30), open: 0, high: 1, low: 0, close: 1, volume: 100 },
      { timestamp: toEngineTs(FIXTURE_DATE, 9, 31), open: 1, high: 2, low: 1, close: 2, volume: 100 },
    ];
    const r = computeWindowChange(candles, metaFor(candles));
    expect(r.percentChange).toBeNull();
  });

  it('detects flat, up and down directions', () => {
    const up = buildMinuteCandles(2);
    expect(computeWindowChange(up, metaFor(up)).direction).toBe('up');

    const flat: CandleData[] = [
      { timestamp: toEngineTs(FIXTURE_DATE, 9, 30), open: 100, high: 101, low: 99, close: 100, volume: 100 },
      { timestamp: toEngineTs(FIXTURE_DATE, 9, 31), open: 100, high: 101, low: 99, close: 100, volume: 100 },
    ];
    expect(computeWindowChange(flat, metaFor(flat)).direction).toBe('flat');

    const down: CandleData[] = [
      { timestamp: toEngineTs(FIXTURE_DATE, 9, 30), open: 100, high: 101, low: 99, close: 100, volume: 100 },
      { timestamp: toEngineTs(FIXTURE_DATE, 9, 31), open: 100, high: 101, low: 99, close: 99, volume: 100 },
    ];
    expect(computeWindowChange(down, metaFor(down)).direction).toBe('down');
  });
});

describe('computeWindowVolume', () => {
  it('computes total, average and largest volume', () => {
    const candles = buildMinuteCandles(5);
    const r = computeWindowVolume(candles, metaFor(candles));
    const total = candles.reduce((sum, c) => sum + c.volume, 0);
    expect(r.totalVolume).toBe(total);
    expect(r.averageVolume).toBe(total / candles.length);
    expect(r.largestVolume).toBe(candles[candles.length - 1].volume);
  });

  it('uses the earliest candle tying for largest volume', () => {
    const candles = buildTieCandles();
    const r = computeWindowVolume(candles, metaFor(candles));
    expect(r.largestVolume).toBe(2000);
    expect(r.largestVolumeAt).toBe('09:31');
  });
});

describe('computeCandleShape', () => {
  it('computes an up body, upper and lower wicks', () => {
    const c = baseCandles[0];
    const r = computeCandleShape(c, FIXTURE_SYMBOL, FIXTURE_DATE, FIXTURE_TF);
    expect(r.body.direction).toBe('up');
    expect(r.body.size).toBe(c.close - c.open);
    expect(r.body.topPrice).toBe(c.close);
    expect(r.body.bottomPrice).toBe(c.open);
    expect(r.upperWick).toBe(c.high - c.close);
    expect(r.lowerWick).toBe(c.open - c.low);
    expect(r.range).toBe(c.high - c.low);
  });

  it('computes a down body', () => {
    const c: CandleData = { ...baseCandles[0], close: baseCandles[0].open - 1 };
    const r = computeCandleShape(c, FIXTURE_SYMBOL, FIXTURE_DATE, FIXTURE_TF);
    expect(r.body.direction).toBe('down');
    expect(r.body.size).toBe(c.open - c.close);
    expect(r.body.topPrice).toBe(c.open);
    expect(r.body.bottomPrice).toBe(c.close);
  });

  it('computes a flat body', () => {
    const c: CandleData = { ...baseCandles[0], close: baseCandles[0].open };
    const r = computeCandleShape(c, FIXTURE_SYMBOL, FIXTURE_DATE, FIXTURE_TF);
    expect(r.body.direction).toBe('flat');
    expect(r.body.size).toBe(0);
  });

  it('rejects malformed candle geometry', () => {
    const c = { ...baseCandles[0], high: 98 };
    expect(() => computeCandleShape(c, FIXTURE_SYMBOL, FIXTURE_DATE, FIXTURE_TF)).toThrow(/high/);
  });
});

describe('computeWindowCompare', () => {
  it('returns close and volume deltas as percentage points', () => {
    const left = buildMinuteCandles(2, 9, 30);
    const right = buildMinuteCandles(2, 10, 0);
    const leftMeta = metaFor(left, 'time_range', '09:30', '09:32');
    const rightMeta = metaFor(right, 'time_range', '10:00', '10:02');
    // Adjust market times to match actual windows
    leftMeta.firstMarketTime = '09:30';
    leftMeta.lastMarketTime = '09:31';
    rightMeta.firstMarketTime = '10:00';
    rightMeta.lastMarketTime = '10:01';

    const r = computeWindowCompare(left, leftMeta, right, rightMeta);
    expect(r.priceDeltaAbs).toBe(right[right.length - 1].close - left[left.length - 1].close);
    expect(r.priceDeltaPercent).toBe((r.priceDeltaAbs / Math.abs(left[left.length - 1].close)) * 100);

    const leftVol = left.reduce((s, c) => s + c.volume, 0);
    const rightVol = right.reduce((s, c) => s + c.volume, 0);
    expect(r.volumeDeltaAbs).toBe(rightVol - leftVol);
    expect(r.volumeDeltaPercent).toBe((r.volumeDeltaAbs / Math.abs(leftVol)) * 100);
  });

  it('returns null percentage when the left denominator is zero', () => {
    const left: CandleData[] = [
      { timestamp: toEngineTs(FIXTURE_DATE, 9, 30), open: 0, high: 1, low: 0, close: 0, volume: 0 },
    ];
    const right: CandleData[] = [
      { timestamp: toEngineTs(FIXTURE_DATE, 9, 31), open: 0, high: 2, low: 0, close: 2, volume: 100 },
    ];
    const leftMeta = metaFor(left);
    const rightMeta = metaFor(right);
    const r = computeWindowCompare(left, leftMeta, right, rightMeta);
    expect(r.priceDeltaPercent).toBeNull();
    expect(r.volumeDeltaPercent).toBeNull();
  });
});

describe('computeWindowSummary', () => {
  it('includes all required summary fields', () => {
    const candles = buildMinuteCandles(60, 9, 30);
    const r = computeWindowSummary(candles, metaFor(candles, 'whole_session', undefined, undefined));
    expect(r.candleCount).toBe(60);
    expect(r.open).toBe(candles[0].open);
    expect(r.close).toBe(candles[candles.length - 1].close);
    expect(r.high).toBe(candles[candles.length - 1].high);
    expect(r.low).toBe(candles[0].low);
    expect(r.absoluteChange).toBe(r.close - r.open);
    expect(r.totalVolume).toBe(candles.reduce((s, c) => s + c.volume, 0));
    expect(r.averageVolume).toBe(r.totalVolume / 60);
    expect(r.averageBody).toBeGreaterThan(0);
    expect(r.averageUpperWick).toBeGreaterThan(0);
    expect(r.averageLowerWick).toBeGreaterThan(0);
  });

  it('rejects malformed data', () => {
    const candles = [...baseCandles];
    candles[2] = { ...candles[2], volume: -1 };
    expect(() => computeWindowSummary(candles, metaFor(candles))).toThrow(/volume/);
  });
});

describe('window receipt formatters', () => {
  it('formatWindowOhlcMessage contains only values from the result', () => {
    const r = computeWindowOhlc(baseCandles, metaFor(baseCandles));
    const msg = formatWindowOhlcMessage(r);
    const numbers = allMessageNumbers(msg);
    expect(numbers).toContain(r.open.toFixed(2));
    expect(numbers).toContain(r.high.toFixed(2));
    expect(numbers).toContain(r.low.toFixed(2));
    expect(numbers).toContain(r.close.toFixed(2));
    expect(msg).toContain(r.highAt);
    expect(msg).toContain(r.lowAt);
  });

  it('formatWindowChangeMessage contains the percent and direction', () => {
    const r = computeWindowChange(baseCandles, metaFor(baseCandles));
    const msg = formatWindowChangeMessage(r);
    if (r.percentChange !== null) {
      expect(msg).toContain(`${r.percentChange.toFixed(2)}%`);
    } else {
      expect(msg).toContain('n/a');
    }
    expect(msg).toContain(r.direction);
  });

  it('formatWindowVolumeMessage contains total, average and largest', () => {
    const r = computeWindowVolume(baseCandles, metaFor(baseCandles));
    const msg = formatWindowVolumeMessage(r);
    expect(msg).toContain(r.totalVolume.toFixed(2));
    expect(msg).toContain(r.averageVolume.toFixed(2));
    expect(msg).toContain(r.largestVolume.toFixed(2));
  });

  it('formatCandleShapeMessage contains body, wick and range values', () => {
    const c = baseCandles[0];
    const r = computeCandleShape(c, FIXTURE_SYMBOL, FIXTURE_DATE, FIXTURE_TF);
    const msg = formatCandleShapeMessage(r);
    expect(msg).toContain(r.body.direction);
    expect(msg).toContain(r.body.size.toFixed(2));
    expect(msg).toContain(r.upperWick.toFixed(2));
    expect(msg).toContain(r.lowerWick.toFixed(2));
    expect(msg).toContain(r.range.toFixed(2));
  });

  it('formatWindowCompareMessage contains both windows and deltas', () => {
    const left = buildMinuteCandles(2, 9, 30);
    const right = buildMinuteCandles(2, 10, 0);
    const leftMeta = metaFor(left, 'time_range', '09:30', '09:32');
    const rightMeta = metaFor(right, 'time_range', '10:00', '10:02');
    leftMeta.firstMarketTime = '09:30';
    leftMeta.lastMarketTime = '09:31';
    rightMeta.firstMarketTime = '10:00';
    rightMeta.lastMarketTime = '10:01';
    const r = computeWindowCompare(left, leftMeta, right, rightMeta);
    const msg = formatWindowCompareMessage(r);
    expect(msg).toContain(r.left.firstMarketTime);
    expect(msg).toContain(r.right.firstMarketTime);
    expect(msg).toContain(r.priceDeltaAbs.toFixed(2));
    expect(msg).toContain(r.volumeDeltaAbs.toFixed(2));
  });

  it('formatWindowSummaryMessage is exactly derived from structured data', () => {
    const candles = buildMinuteCandles(10, 9, 30);
    const r = computeWindowSummary(candles, metaFor(candles, 'whole_session'));
    const msg = formatWindowSummaryMessage(r);

    // Every numeric field that is displayed should appear with the same formatting.
    expect(msg).toContain(r.open.toFixed(2));
    expect(msg).toContain(r.close.toFixed(2));
    expect(msg).toContain(r.high.toFixed(2));
    expect(msg).toContain(r.low.toFixed(2));
    expect(msg).toContain(r.absoluteChange.toFixed(2));
    expect(msg).toContain(r.totalVolume.toFixed(2));
    expect(msg).toContain(r.averageVolume.toFixed(2));
    expect(msg).toContain(r.largestVolume.toFixed(2));
    expect(msg).toContain(r.averageBody.toFixed(2));
    expect(msg).toContain(r.averageUpperWick.toFixed(2));
    expect(msg).toContain(r.averageLowerWick.toFixed(2));
    expect(msg).toContain(r.highAt);
    expect(msg).toContain(r.lowAt);
    expect(msg).toContain(r.largestVolumeAt);
    expect(msg).toContain(r.direction);
    expect(msg).toContain(r.window.sessionPolicy);
  });
});
