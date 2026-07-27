// =============================================================================
// strategies — Registry of deterministic trading strategies Orion can run.
//
// Each strategy is a pure function of a candle array + parameters. They are
// intentionally isolated from the live matching engine so a strategy.run call
// can backtest / warm-up on any symbol/date without mutating the user's
// active replay session. When the agent wants to trade the live session, it
// uses the separate `placeOrder` / `closePosition` tools.
//
// Every strategy carries a default `EndCondition` guardrail. Callers may
// override individual fields, but the defaults are always enforced as a
// ceiling so an open-ended run cannot spiral.
// =============================================================================

import type { CandleData, CloseReason, Side } from '../../types';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface StrategyTrade {
  id: number;
  side: Side;
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  realizedPnl: number;
  stopLoss?: number;
  takeProfit?: number;
  reason: CloseReason;
  openedAt: number;
  closedAt: number;
}

export interface EndCondition {
  /** Max closed trades before the runner stops. */
  maxTrades?: number;
  /** Max candles to process (including warmup). */
  maxBars?: number;
  /** Dollar loss floor (negative number). */
  maxLoss?: number;
  /** Dollar profit ceiling. */
  profitTarget?: number;
  /** Wall-clock timeout in milliseconds. */
  maxDurationMs?: number;
}

export interface StrategyResult {
  ok: boolean;
  trades: StrategyTrade[];
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  endReason: string;
  guardrailTriggered: boolean;
  barsProcessed: number;
  error?: string;
}

export type StrategyExecutor = (
  candles: CandleData[],
  params: Record<string, unknown>,
  endCondition: EndCondition
) => StrategyResult;

export interface StrategyDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  defaultEndCondition: EndCondition;
  execute: StrategyExecutor;
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const registry = new Map<string, StrategyDefinition>();

export function registerStrategy(def: StrategyDefinition): void {
  registry.set(def.name, def);
}

export function listStrategies(): StrategyDefinition[] {
  return Array.from(registry.values());
}

export function getStrategy(name: string): StrategyDefinition | undefined {
  return registry.get(name);
}

export function runStrategy(
  name: string,
  candles: CandleData[],
  params: Record<string, unknown> = {},
  endCondition?: EndCondition
): StrategyResult {
  const def = getStrategy(name);
  if (!def) {
    return {
      ok: false,
      trades: [],
      totalPnl: 0,
      winRate: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      endReason: 'unknown-strategy',
      guardrailTriggered: true,
      barsProcessed: 0,
      error: `Unknown strategy: ${name}`,
    };
  }
  if (candles.length === 0) {
    return {
      ok: false,
      trades: [],
      totalPnl: 0,
      winRate: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      endReason: 'no-data',
      guardrailTriggered: true,
      barsProcessed: 0,
      error: 'No candles provided',
    };
  }
  const merged: EndCondition = {
    ...def.defaultEndCondition,
    ...endCondition,
  };
  // Explicit guardrail: never allow unlimited runs.
  if (typeof merged.maxTrades !== 'number') merged.maxTrades = 50;
  if (typeof merged.maxBars !== 'number') merged.maxBars = 5000;
  if (typeof merged.maxDurationMs !== 'number') merged.maxDurationMs = 30_000;
  return def.execute(candles, params, merged);
}

// -----------------------------------------------------------------------------
// Indicator helpers
// -----------------------------------------------------------------------------

export function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length === 0 || period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i + 1 >= period) {
      out.push(sum / period);
    } else {
      out.push(null);
    }
  }
  return out;
}

export function stddev(values: number[], period: number): (number | null)[] {
  const mean = sma(values, period);
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (mean[i] === null) {
      out.push(null);
      continue;
    }
    let sumSq = 0;
    const start = Math.max(0, i - period + 1);
    const count = i - start + 1;
    for (let j = start; j <= i; j++) {
      const d = values[j] - (mean[i] as number);
      sumSq += d * d;
    }
    out.push(Math.sqrt(sumSq / count));
  }
  return out;
}

export function atr(candles: CandleData[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].open;
    const tr1 = candles[i].high - candles[i].low;
    const tr2 = Math.abs(candles[i].high - prevClose);
    const tr3 = Math.abs(candles[i].low - prevClose);
    const tr = Math.max(tr1, tr2, tr3);
    sum += tr;
    if (i >= period) {
      sum -= Math.max(
        candles[i - period].high - candles[i - period].low,
        Math.abs(candles[i - period].high - (i - period > 0 ? candles[i - period - 1].close : candles[i - period].open)),
        Math.abs(candles[i - period].low - (i - period > 0 ? candles[i - period - 1].close : candles[i - period].open))
      );
    }
    if (i + 1 >= period) {
      out.push(sum / period);
    } else {
      out.push(null);
    }
  }
  return out;
}

export function rangeOf(candles: CandleData[], start: number, end: number) {
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i <= end && i < candles.length; i++) {
    high = Math.max(high, candles[i].high);
    low = Math.min(low, candles[i].low);
  }
  return { high, low };
}

// -----------------------------------------------------------------------------
// Simulation runner internals
// -----------------------------------------------------------------------------

interface RunnerState {
  candles: CandleData[];
  trades: StrategyTrade[];
  position: {
    side: Side;
    entryIndex: number;
    entryPrice: number;
    quantity: number;
    stopLoss?: number;
    takeProfit?: number;
  } | null;
  pnl: number;
  endCondition: EndCondition;
  startMs: number;
  endReason: string;
  guardrail: boolean;
}

function createRunner(candles: CandleData[], endCondition: EndCondition): RunnerState {
  return {
    candles,
    trades: [],
    position: null,
    pnl: 0,
    endCondition,
    startMs: Date.now(),
    endReason: 'completed',
    guardrail: false,
  };
}

function checkTimeGuard(r: RunnerState): boolean {
  if (r.endCondition.maxDurationMs && Date.now() - r.startMs > r.endCondition.maxDurationMs) {
    r.endReason = 'max-duration';
    r.guardrail = true;
    return true;
  }
  return false;
}

function checkPnlGuard(r: RunnerState): boolean {
  if (r.endCondition.maxLoss !== undefined && r.pnl <= r.endCondition.maxLoss) {
    r.endReason = 'max-loss';
    r.guardrail = true;
    return true;
  }
  if (r.endCondition.profitTarget !== undefined && r.pnl >= r.endCondition.profitTarget) {
    r.endReason = 'profit-target';
    r.guardrail = true;
    return true;
  }
  if (r.endCondition.maxTrades !== undefined && r.trades.length >= r.endCondition.maxTrades) {
    r.endReason = 'max-trades';
    r.guardrail = true;
    return true;
  }
  return false;
}

function enter(
  r: RunnerState,
  i: number,
  side: Side,
  price: number,
  quantity: number,
  stopLoss?: number,
  takeProfit?: number
) {
  r.position = { side, entryIndex: i, entryPrice: price, quantity, stopLoss, takeProfit };
}

function exit(r: RunnerState, i: number, price: number, reason: CloseReason) {
  if (!r.position) return;
  const p = r.position;
  const rawPnl =
    p.side === 'buy'
      ? (price - p.entryPrice) * p.quantity
      : (p.entryPrice - price) * p.quantity;
  const tradePnl = Number(rawPnl.toFixed(2));
  r.pnl += tradePnl;
  r.trades.push({
    id: r.trades.length + 1,
    side: p.side,
    entryIndex: p.entryIndex,
    exitIndex: i,
    entryPrice: Number(p.entryPrice.toFixed(4)),
    exitPrice: Number(price.toFixed(4)),
    quantity: p.quantity,
    realizedPnl: tradePnl,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    reason,
    openedAt: p.entryIndex < r.candles.length ? r.candles[p.entryIndex].timestamp : 0,
    closedAt: i < r.candles.length ? r.candles[i].timestamp : 0,
  });
  r.position = null;
}

function slHit(side: Side, candle: CandleData, sl: number): boolean {
  return side === 'buy' ? candle.low <= sl : candle.high >= sl;
}

function tpHit(side: Side, candle: CandleData, tp: number): boolean {
  return side === 'buy' ? candle.high >= tp : candle.low <= tp;
}

function resolveExitPrice(candle: CandleData, reason: CloseReason, level?: number): number {
  if (reason === 'sl' && level !== undefined) return level;
  if (reason === 'tp' && level !== undefined) return level;
  return candle.close;
}

function processSlTp(r: RunnerState, i: number): boolean {
  if (!r.position) return false;
  const c = r.candles[i];
  const p = r.position;
  if (p.stopLoss !== undefined && slHit(p.side, c, p.stopLoss)) {
    exit(r, i, resolveExitPrice(c, 'sl', p.stopLoss), 'sl');
    return true;
  }
  if (p.takeProfit !== undefined && tpHit(p.side, c, p.takeProfit)) {
    exit(r, i, resolveExitPrice(c, 'tp', p.takeProfit), 'tp');
    return true;
  }
  return false;
}

function finalize(r: RunnerState): StrategyResult {
  // If a position is still open at the end, close it at the last close.
  if (r.position) {
    const last = r.candles[r.candles.length - 1];
    exit(r, r.candles.length - 1, last.close, 'manual');
  }
  const wins = r.trades.filter((t) => t.realizedPnl > 0).length;
  return {
    ok: true,
    trades: r.trades,
    totalPnl: Number(r.pnl.toFixed(2)),
    winRate: r.trades.length > 0 ? Math.round((wins / r.trades.length) * 100) : 0,
    totalTrades: r.trades.length,
    winningTrades: wins,
    losingTrades: r.trades.length - wins,
    endReason: r.endReason,
    guardrailTriggered: r.guardrail,
    barsProcessed: r.candles.length,
  };
}

// -----------------------------------------------------------------------------
// 1. Opening Range Breakout (ORB)
// -----------------------------------------------------------------------------

registerStrategy({
  name: 'openingRangeBreakout',
  description:
    'Waits for the first N bars to establish a high/low range, then buys a ' +
    'close above the range and sells a close below it. Uses a fixed take-profit ' +
    'multiple of the opening range and a stop-loss at the opposite side.',
  parameters: {
    type: 'object',
    properties: {
      rangeBars: { type: 'integer', description: 'Bars used to build the opening range', default: 15 },
      quantity: { type: 'integer', description: 'Shares per trade', default: 10 },
      tpMultiplier: { type: 'number', description: 'Take-profit = range * multiplier', default: 1.5 },
      slBuffer: { type: 'number', description: 'Dollars beyond the range for the stop', default: 0 },
    },
    additionalProperties: false,
  },
  defaultEndCondition: { maxTrades: 20, maxBars: 500, maxLoss: -500, profitTarget: 2000 },
  execute: (candles, params, endCondition) => {
    const rangeBars = Math.max(1, Math.min(60, num(params.rangeBars, 15)));
    const quantity = Math.max(1, num(params.quantity, 10));
    const tpMultiplier = Math.max(0.1, num(params.tpMultiplier, 1.5));
    const slBuffer = Math.max(0, num(params.slBuffer, 0));

    const r = createRunner(candles, endCondition);
    if (candles.length < rangeBars + 2) {
      r.endReason = 'insufficient-data';
      r.guardrail = true;
      return finalize(r);
    }

    const opening = rangeOf(candles, 0, rangeBars - 1);
    const range = opening.high - opening.low;

    for (let i = rangeBars; i < candles.length; i++) {
      if (checkTimeGuard(r) || checkPnlGuard(r)) break;
      if (r.endCondition.maxBars && i >= r.endCondition.maxBars) {
        r.endReason = 'max-bars';
        r.guardrail = true;
        break;
      }

      if (r.position) {
        if (processSlTp(r, i)) {
          if (checkPnlGuard(r)) break;
          continue;
        }
        continue;
      }

      const c = candles[i];
      if (c.close > opening.high + slBuffer) {
        const entry = c.close;
        const sl = opening.low - slBuffer;
        const tp = entry + range * tpMultiplier;
        enter(r, i, 'buy', entry, quantity, sl, tp);
      } else if (c.close < opening.low - slBuffer) {
        const entry = c.close;
        const sl = opening.high + slBuffer;
        const tp = entry - range * tpMultiplier;
        enter(r, i, 'sell', entry, quantity, sl, tp);
      }
    }

    return finalize(r);
  },
});

// -----------------------------------------------------------------------------
// 2. EMA Cross
// -----------------------------------------------------------------------------

registerStrategy({
  name: 'emaCross',
  description:
    'Generates a long when a fast EMA crosses above a slow EMA and a short on ' +
    'the reverse cross. Stop-loss and take-profit are sized from the current ATR.',
  parameters: {
    type: 'object',
    properties: {
      fastPeriod: { type: 'integer', default: 12 },
      slowPeriod: { type: 'integer', default: 26 },
      quantity: { type: 'integer', default: 10 },
      slAtr: { type: 'number', description: 'Stop-loss = entry - ATR * slAtr', default: 1.5 },
      tpAtr: { type: 'number', description: 'Take-profit = entry + ATR * tpAtr', default: 3 },
    },
    additionalProperties: false,
  },
  defaultEndCondition: { maxTrades: 20, maxBars: 1000, maxLoss: -500, profitTarget: 2000 },
  execute: (candles, params, endCondition) => {
    const fastPeriod = Math.max(2, Math.min(50, num(params.fastPeriod, 12)));
    const slowPeriod = Math.max(fastPeriod + 1, Math.min(200, num(params.slowPeriod, 26)));
    const quantity = Math.max(1, num(params.quantity, 10));
    const slAtr = Math.max(0.1, num(params.slAtr, 1.5));
    const tpAtr = Math.max(0.1, num(params.tpAtr, 3));

    const r = createRunner(candles, endCondition);
    const closes = candles.map((c) => c.close);
    const fast = ema(closes, fastPeriod);
    const slow = ema(closes, slowPeriod);
    const atrValues = atr(candles, 14);
    const warmup = slowPeriod;

    if (candles.length < warmup + 2) {
      r.endReason = 'insufficient-data';
      r.guardrail = true;
      return finalize(r);
    }

    for (let i = warmup; i < candles.length; i++) {
      if (checkTimeGuard(r) || checkPnlGuard(r)) break;
      if (r.endCondition.maxBars && i >= r.endCondition.maxBars) {
        r.endReason = 'max-bars';
        r.guardrail = true;
        break;
      }

      if (r.position) {
        if (processSlTp(r, i)) {
          if (checkPnlGuard(r)) break;
          continue;
        }
        // Exit on opposite cross.
        if (
          (r.position.side === 'buy' && fast[i] < slow[i]) ||
          (r.position.side === 'sell' && fast[i] > slow[i])
        ) {
          exit(r, i, candles[i].close, 'manual');
          if (checkPnlGuard(r)) break;
          continue;
        }
        continue;
      }

      const prevFast = fast[i - 1];
      const prevSlow = slow[i - 1];
      const curFast = fast[i];
      const curSlow = slow[i];
      const atrValue = atrValues[i] ?? candles[i].high - candles[i].low;

      if (prevFast <= prevSlow && curFast > curSlow) {
        const entry = candles[i].close;
        enter(r, i, 'buy', entry, quantity, entry - atrValue * slAtr, entry + atrValue * tpAtr);
      } else if (prevFast >= prevSlow && curFast < curSlow) {
        const entry = candles[i].close;
        enter(r, i, 'sell', entry, quantity, entry + atrValue * slAtr, entry - atrValue * tpAtr);
      }
    }

    return finalize(r);
  },
});

// -----------------------------------------------------------------------------
// 3. Support / Resistance Breakout
// -----------------------------------------------------------------------------

registerStrategy({
  name: 'supportResistance',
  description:
    'Computes a rolling lookback support (lowest low) and resistance (highest ' +
    'high). Goes long after the close is above resistance for `confirmation` ' +
    'consecutive bars and short when below support for the same count.',
  parameters: {
    type: 'object',
    properties: {
      lookback: { type: 'integer', default: 20 },
      quantity: { type: 'integer', default: 10 },
      confirmation: { type: 'integer', default: 1 },
      tpMultiplier: { type: 'number', default: 1.5 },
      slBuffer: { type: 'number', default: 0.05 },
    },
    additionalProperties: false,
  },
  defaultEndCondition: { maxTrades: 20, maxBars: 1000, maxLoss: -500, profitTarget: 2000 },
  execute: (candles, params, endCondition) => {
    const lookback = Math.max(5, Math.min(100, num(params.lookback, 20)));
    const quantity = Math.max(1, num(params.quantity, 10));
    const confirmation = Math.max(1, Math.min(10, num(params.confirmation, 1)));
    const tpMultiplier = Math.max(0.1, num(params.tpMultiplier, 1.5));
    const slBuffer = Math.max(0, num(params.slBuffer, 0.05));

    const r = createRunner(candles, endCondition);
    if (candles.length < lookback + confirmation + 2) {
      r.endReason = 'insufficient-data';
      r.guardrail = true;
      return finalize(r);
    }

    function isConfirmedAbove(i: number, level: number, count: number): boolean {
      for (let j = i - count + 1; j <= i; j++) {
        if (j < 0 || candles[j].close <= level + slBuffer) return false;
      }
      return true;
    }
    function isConfirmedBelow(i: number, level: number, count: number): boolean {
      for (let j = i - count + 1; j <= i; j++) {
        if (j < 0 || candles[j].close >= level - slBuffer) return false;
      }
      return true;
    }

    for (let i = lookback + confirmation - 1; i < candles.length; i++) {
      if (checkTimeGuard(r) || checkPnlGuard(r)) break;
      if (r.endCondition.maxBars && i >= r.endCondition.maxBars) {
        r.endReason = 'max-bars';
        r.guardrail = true;
        break;
      }

      if (r.position) {
        if (processSlTp(r, i)) {
          if (checkPnlGuard(r)) break;
          continue;
        }
        continue;
      }

      const window = rangeOf(candles, i - lookback, i - 1);
      if (isConfirmedAbove(i, window.high, confirmation)) {
        const entry = candles[i].close;
        const sl = window.low - slBuffer;
        const tp = entry + (window.high - window.low) * tpMultiplier;
        enter(r, i, 'buy', entry, quantity, sl, tp);
      } else if (isConfirmedBelow(i, window.low, confirmation)) {
        const entry = candles[i].close;
        const sl = window.high + slBuffer;
        const tp = entry - (window.high - window.low) * tpMultiplier;
        enter(r, i, 'sell', entry, quantity, sl, tp);
      }
    }

    return finalize(r);
  },
});

// -----------------------------------------------------------------------------
// 4. Mean Reversion (Bollinger-style)
// -----------------------------------------------------------------------------

registerStrategy({
  name: 'meanReversion',
  description:
    'Goes long when the close falls below the lower Bollinger band and exits ' +
    'when price returns to the SMA. Goes short on the upper-band breach and ' +
    'covers at the SMA.',
  parameters: {
    type: 'object',
    properties: {
      lookback: { type: 'integer', default: 20 },
      stdDev: { type: 'number', default: 2 },
      quantity: { type: 'integer', default: 10 },
    },
    additionalProperties: false,
  },
  defaultEndCondition: { maxTrades: 20, maxBars: 1000, maxLoss: -500, profitTarget: 2000 },
  execute: (candles, params, endCondition) => {
    const lookback = Math.max(5, Math.min(100, num(params.lookback, 20)));
    const k = Math.max(0.5, num(params.stdDev, 2));
    const quantity = Math.max(1, num(params.quantity, 10));

    const r = createRunner(candles, endCondition);
    const closes = candles.map((c) => c.close);
    const mean = sma(closes, lookback);
    const sigma = stddev(closes, lookback);

    if (candles.length < lookback + 2) {
      r.endReason = 'insufficient-data';
      r.guardrail = true;
      return finalize(r);
    }

    for (let i = lookback; i < candles.length; i++) {
      if (checkTimeGuard(r) || checkPnlGuard(r)) break;
      if (r.endCondition.maxBars && i >= r.endCondition.maxBars) {
        r.endReason = 'max-bars';
        r.guardrail = true;
        break;
      }

      const m = mean[i];
      const s = sigma[i];
      if (m === null || s === null || s === 0) continue;

      const upper = m + k * s;
      const lower = m - k * s;

      if (r.position) {
        if (processSlTp(r, i)) {
          if (checkPnlGuard(r)) break;
          continue;
        }
        // Exit when price returns to the mean.
        if (r.position.side === 'buy' && candles[i].close >= m) {
          exit(r, i, candles[i].close, 'manual');
          if (checkPnlGuard(r)) break;
          continue;
        }
        if (r.position.side === 'sell' && candles[i].close <= m) {
          exit(r, i, candles[i].close, 'manual');
          if (checkPnlGuard(r)) break;
          continue;
        }
        continue;
      }

      if (candles[i].close < lower) {
        const entry = candles[i].close;
        enter(r, i, 'buy', entry, quantity, entry - s, m);
      } else if (candles[i].close > upper) {
        const entry = candles[i].close;
        enter(r, i, 'sell', entry, quantity, entry + s, m);
      }
    }

    return finalize(r);
  },
});
