import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCapability, listCapabilities } from '../capabilities';
import { fetchCandles } from '../../tools';
import { toEngineTs } from '../../planner';
import type { AppState, CandleData } from '../../../../types';
import type { AgentContext, AgentStep } from '../types';
import { createExecutionContext } from '../executionContext';

vi.mock('../../tools', () => ({
  fetchCandles: vi.fn(),
}));

const FIXTURE_DATE = '2026-07-10';

function baseAppState(): AppState {
  return {
    symbol: 'AAPL',
    replayDate: FIXTURE_DATE,
    sessionActive: true,
    isPlaying: false,
    speed: 1,
    timeframe: 1,
    cursor: 0,
    totalCandles: 390,
    currentPrice: 100,
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

function makeContext(overrides: Partial<AgentContext> = {}, stateOverrides: Partial<AppState> = {}): AgentContext {
  const state = { ...baseAppState(), ...stateOverrides };
  return {
    getState: () => state,
    chartRef: { current: { getRecentCandles: () => [] } as any },
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

function makeStep(capability: string, args: Record<string, unknown>): AgentStep {
  return { id: 'step-1', capability, args, required: true };
}

beforeEach(() => {
  vi.mocked(fetchCandles).mockReset();
});

describe('Phase 6A analysis capabilities', () => {
  it('registers exactly the six expected analysis capabilities as read-only', () => {
    const names = [
      'analysis.window_ohlc',
      'analysis.window_change',
      'analysis.window_volume',
      'analysis.window_compare',
      'analysis.candle_shape',
      'analysis.window_summary',
    ];
    const all = listCapabilities();
    for (const name of names) {
      const cap = getCapability(name);
      expect(cap, name).toBeDefined();
      expect(cap!.kind).toBe('read');
      expect(all.map((c) => c.name)).toContain(name);
    }
  });

  it('all six capability schemas reject additional properties', () => {
    const names = [
      'analysis.window_ohlc',
      'analysis.window_change',
      'analysis.window_volume',
      'analysis.window_compare',
      'analysis.candle_shape',
      'analysis.window_summary',
    ];
    for (const name of names) {
      const cap = getCapability(name)!;
      expect(cap.argSchema.additionalProperties).toBe(false);
      if ('properties' in cap.argSchema && 'window' in (cap.argSchema.properties as Record<string, unknown>)) {
        const window = (cap.argSchema.properties as Record<string, unknown>).window as Record<string, unknown>;
        expect(window.additionalProperties).toBe(false);
      }
      if ('properties' in cap.argSchema) {
        const props = cap.argSchema.properties as Record<string, unknown>;
        for (const key of Object.keys(props)) {
          const p = props[key] as Record<string, unknown>;
          if (p.type === 'object') {
            expect(p.additionalProperties).toBe(false);
          }
        }
      }
    }
  });

  it('analysis.window_ohlc returns whole_session OHLC', async () => {
    const candles = buildMinuteCandles(60);
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles,
      missing: false,
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.window_ohlc')!;
    const r = await cap.execute('plan-1', makeStep('analysis.window_ohlc', { window: { kind: 'whole_session' } }), ctx);

    expect(r.success).toBe(true);
    const data = r.data as { open: number; close: number; candleCount: number };
    expect(data.candleCount).toBe(60);
    expect(data.open).toBe(candles[0].open);
    expect(data.close).toBe(candles[candles.length - 1].close);
  });

  it('analysis.window_change works up_to_cursor with one candle at cursor 0', async () => {
    const candle = buildMinuteCandles(1)[0];
    const ctx = makeContext({
      chartRef: { current: { getRecentCandles: () => [candle] } as any },
    });

    const cap = getCapability('analysis.window_change')!;
    const r = await cap.execute(
      'plan-1',
      makeStep('analysis.window_change', { window: { kind: 'up_to_cursor' } }),
      ctx
    );

    expect(r.success).toBe(true);
    const data = r.data as { candleCount: number; absoluteChange: number };
    expect(data.candleCount).toBe(1);
    expect(data.absoluteChange).toBe(candle.close - candle.open);
  });

  it('truly empty up_to_cursor fails', async () => {
    const ctx = makeContext({
      chartRef: { current: { getRecentCandles: () => [] } as any },
    });

    const cap = getCapability('analysis.window_change')!;
    const r = await cap.execute(
      'plan-1',
      makeStep('analysis.window_change', { window: { kind: 'up_to_cursor' } }),
      ctx
    );

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('PRECONDITION_FAILED');
  });

  it('one-minute 09:30–10:30 resolves to 60 candles for analysis.window_volume', async () => {
    const candles = buildMinuteCandles(60);
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles,
      missing: false,
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.window_volume')!;
    const r = await cap.execute(
      'plan-1',
      makeStep('analysis.window_volume', { window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }),
      ctx
    );

    expect(r.success).toBe(true);
    const data = r.data as { candleCount: number; totalVolume: number };
    expect(data.candleCount).toBe(60);
    expect(data.totalVolume).toBe(candles.reduce((s, c) => s + c.volume, 0));
  });

  it('rejects fromTime === toTime as an empty range', async () => {
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles: buildMinuteCandles(60),
      missing: false,
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.window_ohlc')!;
    const r = await cap.execute(
      'plan-1',
      makeStep('analysis.window_ohlc', { window: { kind: 'time_range', fromTime: '09:30', toTime: '09:30' } }),
      ctx
    );

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('fails for an empty but syntactically valid time range', async () => {
    const candles = buildMinuteCandles(60);
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles,
      missing: false,
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.window_ohlc')!;
    const r = await cap.execute(
      'plan-1',
      makeStep('analysis.window_ohlc', { window: { kind: 'time_range', fromTime: '08:00', toTime: '08:30' } }),
      ctx
    );

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('fails truthfully when the engine has no data for the requested date', async () => {
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles: [],
      missing: true,
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.window_summary')!;
    const r = await cap.execute('plan-1', makeStep('analysis.window_summary', { window: { kind: 'whole_session' } }), ctx);

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('NO_DATA_FOR_DATE');
  });

  it('fails truthfully on fallback-date data and reports both dates', async () => {
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles: buildMinuteCandles(60),
      missing: false,
      fallbackUsed: true,
      fallbackDate: '2026-07-09',
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.window_summary')!;
    const r = await cap.execute('plan-1', makeStep('analysis.window_summary', { window: { kind: 'whole_session' } }), ctx);

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('NO_DATA_FOR_DATE');
    const data = r.data as Record<string, unknown>;
    expect(data.requestedDate).toBe(FIXTURE_DATE);
    expect(data.availableFallbackDate).toBe('2026-07-09');
  });

  it('analysis.window_compare compares two time ranges', async () => {
    const all = buildMinuteCandles(120, 9, 30);
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles: all,
      missing: false,
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.window_compare')!;
    const r = await cap.execute(
      'plan-1',
      makeStep('analysis.window_compare', {
        left: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' },
        right: { kind: 'time_range', fromTime: '10:30', toTime: '11:30' },
      }),
      ctx
    );

    expect(r.success).toBe(true);
    const data = r.data as { left: { candleCount: number }; right: { candleCount: number }; priceDeltaAbs: number };
    expect(data.left.candleCount).toBe(60);
    expect(data.right.candleCount).toBe(60);
    expect(data.priceDeltaAbs).toBe(all[119].close - all[59].close);
  });

  it('analysis.candle_shape returns the current chart candle', async () => {
    const candle = buildMinuteCandles(1)[0];
    const ctx = makeContext({
      chartRef: { current: { getRecentCandles: () => [candle] } as any },
    });

    const cap = getCapability('analysis.candle_shape')!;
    const r = await cap.execute('plan-1', makeStep('analysis.candle_shape', { source: 'current_chart_candle' }), ctx);

    expect(r.success).toBe(true);
    const data = r.data as { candle: { marketTime: string }; body: { size: number } };
    expect(data.candle.marketTime).toBe('09:30');
    expect(data.body.size).toBe(candle.close - candle.open);
  });

  it('analysis.candle_shape resolves a candle by market time', async () => {
    const candles = buildMinuteCandles(60);
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles,
      missing: false,
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.candle_shape')!;
    const r = await cap.execute(
      'plan-1',
      makeStep('analysis.candle_shape', { source: 'market_time', marketTime: '09:45' }),
      ctx
    );

    expect(r.success).toBe(true);
    const data = r.data as { candle: { marketTime: string } };
    expect(data.candle.marketTime).toBe('09:45');
  });

  it('analysis.window_summary returns structured data and a deterministic message', async () => {
    const candles = buildMinuteCandles(60);
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles,
      missing: false,
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.window_summary')!;
    const r = await cap.execute('plan-1', makeStep('analysis.window_summary', { window: { kind: 'whole_session' } }), ctx);

    expect(r.success).toBe(true);
    const data = r.data as {
      candleCount: number;
      open: number;
      close: number;
      averageBody: number;
      message?: string;
    };
    expect(data.candleCount).toBe(60);
    expect(data.averageBody).toBeGreaterThan(0);

    const message = r.message;
    expect(message).toContain(data.open.toFixed(2));
    expect(message).toContain(data.close.toFixed(2));
    expect(message).toContain(data.averageBody.toFixed(2));
  });

  it('fails truthfully on malformed candle data from the engine', async () => {
    const candles = buildMinuteCandles(60);
    candles[30] = { ...candles[30], high: 50 };
    vi.mocked(fetchCandles).mockResolvedValue({
      symbol: 'AAPL',
      date: FIXTURE_DATE,
      timeframe: 1,
      candles,
      missing: false,
    } as any);

    const ctx = makeContext();
    const cap = getCapability('analysis.window_summary')!;
    const r = await cap.execute('plan-1', makeStep('analysis.window_summary', { window: { kind: 'whole_session' } }), ctx);

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('PRECONDITION_FAILED');
  });

  it('fails when no active session is present', async () => {
    const ctx = makeContext({}, { sessionActive: false });
    const cap = getCapability('analysis.window_ohlc')!;
    const r = await cap.execute('plan-1', makeStep('analysis.window_ohlc', { window: { kind: 'whole_session' } }), ctx);
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('PRECONDITION_FAILED');
  });
});
