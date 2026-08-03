import { describe, it, expect, vi } from 'vitest';
import { getCapability } from '../capabilities';
import { createExecutionContext } from '../executionContext';
import { buildCandleSnapshot } from '../executionContext';
import type { AgentContext, AgentStep, ExecutionContextEntry } from '../types';
import type { AppState } from '../../../../types';

function baseAppState(): AppState {
  return {
    symbol: 'AAPL',
    replayDate: '2026-07-10',
    sessionActive: true,
    isPlaying: false,
    speed: 1,
    timeframe: 5,
    cursor: 0,
    totalCandles: 0,
    currentPrice: 0,
    playbackDirection: 'forward',
    balance: 100000,
    equity: 100000,
    openPositions: [],
    pendingOrders: [],
    indicators: {
      ema20: false,
      sma50: false,
      bollinger: false,
      rsi: false,
      macd: false,
      atr: false,
      stochastic: false,
    },
    activeSessionTrades: [],
    tradeHistory: [],
    session_id: '',
    start_ts: 0,
    end_ts: 0,
    dataSynced: false,
    symbolError: '',
    dateError: '',
    dateConfirmed: false,
    journalRecords: [],
    journalFilter: null,
    lightMode: false,
    showIntro: false,
    view: 'menu',
    dataSource: 'managed',
    replayRate: 1,
    lastOhlc: null,
  } as unknown as AppState;
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const state = baseAppState();
  return {
    getState: () => state,
    chartRef: { current: { getRecentCandles: () => [{ timestamp: 1755038100, open: 110, high: 111, low: 109, close: 110.5, volume: 2000 }] } as any },
    performanceLog: {},
    apiBase: 'http://localhost:9000',
    dataDir: undefined,
    availableTickers: ['AAPL', 'MSFT', 'NVDA'],
    send: vi.fn(),
    dispatch: vi.fn(),
    onSwitchSymbol: vi.fn(),
    executionLog: createExecutionContext(),
    ...overrides,
  };
}

function makeStep(args: Record<string, unknown>): AgentStep {
  return { id: 'step-1', capability: 'analysis.compare_candles', args, required: true };
}

function snapshot(
  ctx: AgentContext,
  candle: { timestamp: number; open: number; high: number; low: number; close: number; volume: number },
  marketTime: string,
  source: 'current_candle' | 'candle_at_time'
): ReturnType<typeof buildCandleSnapshot> {
  return {
    snapshotId: ctx.executionLog.getEntries().length + 1,
    symbol: 'AAPL',
    date: '2026-07-10',
    timeframe: 5,
    ...candle,
    marketTime,
    source,
  };
}

function recordReturnedCandle(ctx: AgentContext, c: ReturnType<typeof buildCandleSnapshot>) {
  ctx.executionLog.record({
    sequenceId: 0,
    timestamp: Date.now(),
    originalRequest: 'candle',
    route: 'deterministic',
    ok: true,
    receipts: [],
    before: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
    after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
    returnedCandles: [c],
  } as ExecutionContextEntry);
}

function sideSnapshot(c: ReturnType<typeof buildCandleSnapshot>) {
  return {
    source: 'snapshot',
    snapshotId: c.snapshotId,
    symbol: c.symbol,
    date: c.date,
    timeframe: c.timeframe,
    timestamp: c.timestamp,
    marketTime: c.marketTime,
  };
}

function sideChart() {
  return { source: 'chart' };
}

describe('analysis.compare_candles capability', () => {
  it('fails when the left snapshot is not in the log', async () => {
    const ctx = makeContext();
    const cap = getCapability('analysis.compare_candles')!;
    const r = await cap.execute(
      'plan-1',
      makeStep({ left: sideChart(), right: { source: 'snapshot', symbol: 'AAPL', date: '2026-07-10', timeframe: 5, timestamp: 1755037500, marketTime: '11:15' } }),
      ctx
    );
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('PRECONDITION_FAILED');
    expect(r.message).toMatch(/not found in the execution log/);
  });

  it('fails truthfully when both requested snapshots are missing', async () => {
    const ctx = makeContext();
    const cap = getCapability('analysis.compare_candles')!;
    const missing = {
      source: 'snapshot',
      symbol: 'AAPL',
      date: '2026-07-10',
      timeframe: 5,
      timestamp: 1755037500,
      marketTime: '11:15',
    };
    const r = await cap.execute('plan-1', makeStep({ left: missing, right: missing }), ctx);
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('PRECONDITION_FAILED');
  });

  it('compares latest returned snapshot vs previous returned snapshot (A)', async () => {
    const ctx = makeContext();
    const earlier = snapshot(ctx, { timestamp: 1755037500, open: 303.16, high: 303.24, low: 302.32, close: 302.99, volume: 1000 }, '11:00', 'candle_at_time');
    recordReturnedCandle(ctx, earlier);
    const later = snapshot(ctx, { timestamp: 1755038100, open: 301.73, high: 302.82, low: 301.44, close: 301.95, volume: 1200 }, '11:30', 'candle_at_time');
    recordReturnedCandle(ctx, later);

    const cap = getCapability('analysis.compare_candles')!;
    const r = await cap.execute(
      'plan-1',
      makeStep({ left: sideSnapshot(later), right: sideSnapshot(earlier) }),
      ctx
    );
    expect(r.success).toBe(true);
    const data = r.data as {
      left: { close: number; marketTime: string };
      right: { close: number; marketTime: string };
      deltas: { close: number };
    };
    expect(data.left.close).toBe(301.95);
    expect(data.left.marketTime).toBe('11:30');
    expect(data.right.close).toBe(302.99);
    expect(data.right.marketTime).toBe('11:00');
    expect(data.deltas.close).toBe(301.95 - 302.99);
    expect(r.message).toMatch(/11:30/);
    expect(r.message).toMatch(/11:00/);
  });

  it('compares current chart candle with last returned snapshot (B)', async () => {
    const ctx = makeContext();
    const previous = snapshot(ctx, { timestamp: 1755037500, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 }, '11:15', 'candle_at_time');
    recordReturnedCandle(ctx, previous);

    const cap = getCapability('analysis.compare_candles')!;
    const r = await cap.execute(
      'plan-1',
      makeStep({ left: sideChart(), right: sideSnapshot(previous) }),
      ctx
    );
    expect(r.success).toBe(true);
    const data = r.data as {
      left: { close: number };
      right: { close: number };
    };
    expect(data.left.close).toBe(110.5);
    expect(data.right.close).toBe(100.5);
  });

  it('compares explicit 11:30 vs 11:00 values by market time (C)', async () => {
    const ctx = makeContext();
    const at11 = snapshot(ctx, { timestamp: 1755037500, open: 303.16, high: 303.24, low: 302.32, close: 302.99, volume: 1000 }, '11:00', 'candle_at_time');
    recordReturnedCandle(ctx, at11);
    const at1130 = snapshot(ctx, { timestamp: 1755038100, open: 301.73, high: 302.82, low: 301.44, close: 301.95, volume: 1200 }, '11:30', 'candle_at_time');
    recordReturnedCandle(ctx, at1130);

    const found11 = ctx.executionLog.findCandleByMarketTime({ marketTime: '11:00' })!;
    const found1130 = ctx.executionLog.findCandleByMarketTime({ marketTime: '11:30' })!;

    const cap = getCapability('analysis.compare_candles')!;
    const r = await cap.execute(
      'plan-1',
      makeStep({ left: sideSnapshot(found1130), right: sideSnapshot(found11) }),
      ctx
    );
    expect(r.success).toBe(true);
    const data = r.data as { left: { close: number; marketTime: string }; right: { close: number; marketTime: string } };
    expect(data.left.close).toBe(301.95);
    expect(data.right.close).toBe(302.99);
    expect(data.left.marketTime).toBe('11:30');
    expect(data.right.marketTime).toBe('11:00');
  });

  it('does not silently use live cursor when both sides are snapshots', async () => {
    const ctx = makeContext();
    // The live chart candle is 110.5; the reported snapshots are different.
    const live = { timestamp: 1755038100, open: 110, high: 111, low: 109, close: 110.5, volume: 2000 };
    ctx.chartRef = { current: { getRecentCandles: () => [live] } as any };

    const earlier = snapshot(ctx, { timestamp: 1755037500, open: 303.16, high: 303.24, low: 302.32, close: 302.99, volume: 1000 }, '11:00', 'candle_at_time');
    recordReturnedCandle(ctx, earlier);
    const later = snapshot(ctx, { timestamp: 1755038100, open: 301.73, high: 302.82, low: 301.44, close: 301.95, volume: 1200 }, '11:30', 'candle_at_time');
    recordReturnedCandle(ctx, later);

    const cap = getCapability('analysis.compare_candles')!;
    const r = await cap.execute(
      'plan-1',
      makeStep({ left: sideSnapshot(later), right: sideSnapshot(earlier) }),
      ctx
    );
    expect(r.success).toBe(true);
    const data = r.data as { left: { close: number }; right: { close: number } };
    expect(data.left.close).toBe(301.95);
    expect(data.right.close).toBe(302.99);
    expect(data.left.close).not.toBe(110.5);
  });

  it('reports same candle when both snapshots are identical', async () => {
    const ctx = makeContext();
    const now = 1755038100;
    const c = snapshot(ctx, { timestamp: now, open: 110, high: 111, low: 109, close: 110.5, volume: 2000 }, '11:30', 'current_candle');
    recordReturnedCandle(ctx, c);

    const cap = getCapability('analysis.compare_candles')!;
    const r = await cap.execute(
      'plan-1',
      makeStep({ left: sideSnapshot(c), right: sideSnapshot(c) }),
      ctx
    );
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/same/);
  });
});
