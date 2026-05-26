import { EMA, SMA, BollingerBands, RSI, MACD, ATR, Stochastic } from 'technicalindicators';
import type { CandleData } from '../types';
import type { LineData } from 'lightweight-charts';

/**
 * Calculate EMA (Exponential Moving Average)
 * Returns lightweight-charts formatted LineData array with proper timestamp alignment
 * Note: Adjusts period downward if not enough candles available
 */
export function calculateEMA(candles: CandleData[], period: number): LineData[] {
  if (candles.length === 0) return [];

  // Adjust period if we don't have enough candles
  const adjustedPeriod = Math.min(period, candles.length);
  if (adjustedPeriod < 2) return []; // Need at least 2 candles

  const closePrices = candles.map(c => c.close);
  const emaValues = EMA.calculate({ period: adjustedPeriod, values: closePrices });

  // Warmup index realignment: map timestamps back using offset
  const offset = candles.length - emaValues.length;
  return emaValues.map((val, index) => ({
    time: candles[index + offset].timestamp as any,
    value: val,
  }));
}

/**
 * Calculate SMA (Simple Moving Average)
 * Returns lightweight-charts formatted LineData array with proper timestamp alignment
 * Note: Adjusts period downward if not enough candles available
 */
export function calculateSMA(candles: CandleData[], period: number): LineData[] {
  if (candles.length === 0) return [];

  // Adjust period if we don't have enough candles
  const adjustedPeriod = Math.min(period, candles.length);
  if (adjustedPeriod < 2) return []; // Need at least 2 candles

  const closePrices = candles.map(c => c.close);
  const smaValues = SMA.calculate({ period: adjustedPeriod, values: closePrices });

  // Warmup index realignment: map timestamps back using offset
  const offset = candles.length - smaValues.length;
  return smaValues.map((val, index) => ({
    time: candles[index + offset].timestamp as any,
    value: val,
  }));
}

/**
 * Calculate Bollinger Bands
 * Returns upper, lower, and middle band arrays with proper timestamp alignment
 * Note: Adjusts period downward if not enough candles available
 */
export function calculateBollingerBands(
  candles: CandleData[],
  period: number,
  stdDev: number
): { upper: LineData[]; lower: LineData[]; middle: LineData[] } {
  if (candles.length === 0) {
    return { upper: [], lower: [], middle: [] };
  }

  // Adjust period if we don't have enough candles
  const adjustedPeriod = Math.min(period, candles.length);
  if (adjustedPeriod < 2) return { upper: [], lower: [], middle: [] }; // Need at least 2 candles

  const closePrices = candles.map(c => c.close);
  const bbValues = BollingerBands.calculate({ period: adjustedPeriod, stdDev, values: closePrices });

  // Warmup index realignment: map timestamps back using offset
  const offset = candles.length - bbValues.length;

  const upper = bbValues.map((val, index) => ({
    time: candles[index + offset].timestamp as any,
    value: val.upper,
  }));

  const lower = bbValues.map((val, index) => ({
    time: candles[index + offset].timestamp as any,
    value: val.lower,
  }));

  const middle = bbValues.map((val, index) => ({
    time: candles[index + offset].timestamp as any,
    value: val.middle,
  }));

  return { upper, lower, middle };
}

/**
 * Calculate RSI (Relative Strength Index)
 * Returns lightweight-charts formatted LineData array with proper timestamp alignment
 * Note: Adjusts period downward if not enough candles available
 */
export function calculateRSI(candles: CandleData[], period: number): LineData[] {
  if (candles.length === 0) return [];

  // Adjust period if we don't have enough candles
  const adjustedPeriod = Math.min(period, candles.length);
  if (adjustedPeriod < 2) return []; // Need at least 2 candles

  const closePrices = candles.map(c => c.close);
  const rsiValues = RSI.calculate({ period: adjustedPeriod, values: closePrices });

  // Warmup index realignment: map timestamps back using offset
  const offset = candles.length - rsiValues.length;
  return rsiValues.map((val, index) => ({
    time: candles[index + offset].timestamp as any,
    value: val,
  }));
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 * Returns MACD line, signal line, and histogram with proper timestamp alignment
 */
export function calculateMACD(
  candles: CandleData[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { macd: LineData[]; signal: LineData[]; histogram: LineData[] } {
  if (candles.length === 0) return { macd: [], signal: [], histogram: [] };

  const closePrices = candles.map(c => c.close);
  const macdValues = MACD.calculate({
    fastPeriod,
    slowPeriod,
    signalPeriod,
    values: closePrices,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const offset = candles.length - macdValues.length;

  const macd = macdValues
    .map((val, index) => ({
      time: candles[index + offset].timestamp as any,
      value: val.MACD,
    }))
    .filter((item): item is LineData => item.value !== undefined);

  const signal = macdValues
    .map((val, index) => ({
      time: candles[index + offset].timestamp as any,
      value: val.signal,
    }))
    .filter((item): item is LineData => item.value !== undefined);

  const histogram = macdValues
    .map((val, index) => ({
      time: candles[index + offset].timestamp as any,
      value: val.histogram,
    }))
    .filter((item): item is LineData => item.value !== undefined);

  return { macd, signal, histogram };
}

/**
 * Calculate ATR (Average True Range)
 * Returns lightweight-charts formatted LineData array with proper timestamp alignment
 */
export function calculateATR(candles: CandleData[], period: number = 14): LineData[] {
  if (candles.length === 0) return [];

  const adjustedPeriod = Math.min(period, candles.length);
  if (adjustedPeriod < 2) return [];

  const atrValues = ATR.calculate({
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
    period: adjustedPeriod,
  });

  const offset = candles.length - atrValues.length;
  return atrValues.map((val, index) => ({
    time: candles[index + offset].timestamp as any,
    value: val,
  }));
}

/**
 * Calculate Stochastic Oscillator
 * Returns %K and %D lines with proper timestamp alignment
 */
export function calculateStochastic(
  candles: CandleData[],
  period: number = 14,
  signalPeriod: number = 3
): { k: LineData[]; d: LineData[] } {
  if (candles.length === 0) return { k: [], d: [] };

  const adjustedPeriod = Math.min(period, candles.length);
  if (adjustedPeriod < 2) return { k: [], d: [] };

  const stochValues = Stochastic.calculate({
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
    period: adjustedPeriod,
    signalPeriod,
  });

  const offset = candles.length - stochValues.length;

  const k = stochValues.map((val, index) => ({
    time: candles[index + offset].timestamp as any,
    value: val.k,
  }));

  const d = stochValues.map((val, index) => ({
    time: candles[index + offset].timestamp as any,
    value: val.d,
  }));

  return { k, d };
}
