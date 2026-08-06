import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectCandles,
  ohlc,
  candleShape,
  compare,
  summary,
  computeCapability,
} from '../reference/calculator.ts';
import type { ReferenceCandle } from '../reference/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '..', 'reference', 'fixtures', 'synthetic-session-1m.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { candles: ReferenceCandle[] };
const candles = fixture.candles;

describe('reference calculator', () => {
  it('loads 390 one-minute candles', () => {
    expect(candles).toHaveLength(390);
    expect(candles[0].marketTime).toBe('09:30');
    expect(candles[candles.length - 1].marketTime).toBe('15:59');
  });

  it('selects first hour with half-open range [09:30, 10:30)', () => {
    const firstHour = selectCandles(candles, { kind: 'time_range', fromTime: '09:30', toTime: '10:30' });
    expect(firstHour).toHaveLength(60);
    expect(firstHour[0].marketTime).toBe('09:30');
    expect(firstHour[firstHour.length - 1].marketTime).toBe('10:29');
  });

  it('selects last hour with half-open range [15:00, 16:00)', () => {
    const lastHour = selectCandles(candles, { kind: 'time_range', fromTime: '15:00', toTime: '16:00' });
    expect(lastHour).toHaveLength(60);
    expect(lastHour[0].marketTime).toBe('15:00');
    expect(lastHour[lastHour.length - 1].marketTime).toBe('15:59');
  });

  it('computes first hour OHLC', () => {
    const result = ohlc(selectCandles(candles, { kind: 'time_range', fromTime: '09:30', toTime: '10:30' }));
    expect(result.open).toBeCloseTo(100.0, 2);
    expect(result.close).toBeCloseTo(100.59, 2);
    expect(result.high).toBeCloseTo(100.64, 2);
    expect(result.low).toBeCloseTo(99.94, 2);
    expect(result.candleCount).toBe(60);
  });

  it('computes whole session summary', () => {
    const result = summary(candles);
    expect(result.open).toBeCloseTo(100.0, 2);
    expect(result.close).toBeCloseTo(103.89, 2);
    expect(result.high).toBeCloseTo(103.94, 2);
    expect(result.low).toBeCloseTo(99.94, 2);
    expect(result.totalVolume).toBe(1_148_550);
    expect(result.candleCount).toBe(390);
  });

  it('locates 11:30 candle at cursor 120 with zero-based indexing', () => {
    const c = candles.find((x) => x.marketTime === '11:30')!;
    const index = candles.indexOf(c);
    // 09:30 is index 0; 11:30 is 120 minutes later, so index 120.
    expect(index).toBe(120);
    expect(index).not.toBe(60);
  });

  it('computes 11:30 candle shape', () => {
    const c = candles.find((x) => x.marketTime === '11:30')!;
    const shape = candleShape(c);
    expect(shape.candle.marketTime).toBe('11:30');
    expect(shape.body.direction).toBe('up');
    expect(shape.body.size).toBeCloseTo(0.05, 6);
    expect(shape.upperWick).toBeCloseTo(0.02, 6);
    expect(shape.lowerWick).toBeCloseTo(0.02, 6);
    expect(shape.range).toBeCloseTo(0.09, 6);
  });

  it('compares first hour and last hour', () => {
    const left = selectCandles(candles, { kind: 'time_range', fromTime: '09:30', toTime: '10:30' });
    const right = selectCandles(candles, { kind: 'time_range', fromTime: '15:00', toTime: '16:00' });
    const result = compare(left, right);
    expect(result.priceDeltaAbs).toBeCloseTo(3.3, 2);
    expect(result.volumeDeltaAbs).toBe(198_000);
  });

  it('computes capabilities via dispatch', () => {
    const ohlcResult = computeCapability(candles, {
      capability: 'analysis.window_ohlc',
      window: { kind: 'time_range', fromTime: '11:30', toTime: '11:31' },
    });
    expect((ohlcResult as any).open).toBeCloseTo(101.2, 2);

    const shapeResult = computeCapability(candles, {
      capability: 'analysis.candle_shape',
      marketTime: '11:45',
    });
    expect((shapeResult as any).candle.marketTime).toBe('11:45');
  });
});
