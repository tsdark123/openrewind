import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppState, CandleData } from '../../../../types';
import type { AgentContext } from '../types';
import { handleOrionMessage } from '../orchestrator';
import { resolveTradingDate } from '../resolveTradingDate';
import { createExecutionContext } from '../executionContext';
import { parseChartCommand, toEngineTs } from '../../planner';
import { fetchCandles } from '../../tools';

vi.mock('../../tools', () => ({
  fetchCandles: vi.fn(),
}));

function baseAppState(): AppState {
  return {
    symbol: '',
    replayDate: '',
    sessionActive: false,
    isPlaying: false,
    speed: 1,
    timeframe: 1,
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

function buildCandles(date: string, timeframeMinutes: number): CandleData[] {
  const open = toEngineTs(date, 9, 30);
  const close = toEngineTs(date, 16, 0);
  const step = timeframeMinutes * 60;
  const candles: CandleData[] = [];
  for (let ts = open, i = 0; ts <= close; ts += step, i += 1) {
    candles.push({
      timestamp: ts,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1000 + i,
    });
  }
  return candles;
}

interface TestChartHandle {
  currentCandle: CandleData | null;
  getRecentCandles: (n: number) => CandleData[];
  setCurrentCandle: (c: CandleData) => void;
}

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const state = baseAppState();

  const chartHandle: TestChartHandle = {
    currentCandle: null,
    getRecentCandles: (n: number): CandleData[] => (chartHandle.currentCandle ? [chartHandle.currentCandle] : []),
    setCurrentCandle: (c: CandleData) => {
      chartHandle.currentCandle = c;
    },
  };
  const chartRef = { current: chartHandle } as unknown as AgentContext['chartRef'];

  const dispatch = (action: Record<string, unknown>) => {
    if (action.type === 'SET_PLAYING') state.isPlaying = !!action.isPlaying;
    else if (action.type === 'SET_SPEED') state.speed = Number(action.speed ?? state.speed);
    else if (action.type === 'SET_TIMEFRAME') state.timeframe = Number(action.timeframe ?? state.timeframe);
  };

  const send = vi.fn((payload: Record<string, unknown>) => {
    if (payload.cmd === 'seek' && typeof payload.timestamp === 'number') {
      chartHandle.currentCandle = {
        timestamp: payload.timestamp,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 1000,
      };
    }

    // Simulate the engine playing to the requested stop time then pausing.
    if (payload.cmd === 'play' && typeof payload.until === 'number') {
      const target = payload.until as number;
      setTimeout(() => {
        chartHandle.currentCandle = {
          timestamp: target,
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 1000,
        };
        dispatch({ type: 'SET_PLAYING', isPlaying: false });
      }, 10);
    }
  });

  const onSwitchSymbol = async (symbol: string, date?: string) => {
    state.symbol = symbol;
    state.replayDate = date ?? state.replayDate;
    state.sessionActive = true;
    if (date) {
      chartHandle.currentCandle = {
        timestamp: toEngineTs(date, 9, 30),
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 1000,
      };
    }
  };

  return {
    getState: () => state,
    chartRef,
    performanceLog: {},
    apiBase: 'http://localhost:9000',
    dataDir: undefined,
    availableTickers: ['AAPL', 'ADBE', 'MSFT'],
    send,
    dispatch,
    onSwitchSymbol,
    executionLog: createExecutionContext(),
    ...overrides,
  };
}

function mockFetchCandles(available: Set<string>) {
  const mocked = fetchCandles as unknown as ReturnType<typeof vi.fn>;
  mocked.mockImplementation(async (args: { symbol: string; date?: string; timeframe?: number; limit?: number }) => {
    if (args.date && available.has(args.date)) {
      const tf = args.timeframe ?? 1;
      const candles = buildCandles(args.date, tf);
      if (args.limit === 1) {
        return { symbol: args.symbol, date: args.date, timeframe: tf, candles: candles.slice(0, 1), missing: false };
      }
      return { symbol: args.symbol, date: args.date, timeframe: tf, candles, missing: false };
    }
    return { symbol: args.symbol, date: args.date ?? '', timeframe: args.timeframe ?? 1, candles: [], missing: true, reason: 'missing' };
  });
}

describe('compound fast-forward', () => {
  beforeEach(() => {
    mockFetchCandles(new Set(['2026-07-08', '2026-07-09', '2026-07-10']));
  });

  it('resolves relative trading sessions, switches, sets 5m, seeks market open and plays to 10am', async () => {
    const ctx = makeCtx();
    // Anchor the request to a known available session so the count is deterministic.
    ctx.getState().replayDate = '2026-07-10';

    const r = await handleOrionMessage({
      text: 'Go to Apple two trading sessions ago, switch to the 5m timeframe and fast-forward from market open to 10am.',
      ctx,
      setupReady: false,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);

    const caps = r.plan?.steps.map((s) => s.capability) ?? [];
    expect(caps).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
      'chart.get_current_candle',
      'chart.set_timeframe',
      'playback.seek_to_time',
      'playback.play_until',
    ]);

    const resolved = r.result?.receipts[0];
    expect(resolved?.capability).toBe('session.resolve_trading_date');
    expect(resolved?.success).toBe(true);
    expect((resolved?.data as { date?: string } | undefined)?.date).toBe('2026-07-08');

    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-08');
    expect(ctx.getState().timeframe).toBe(5);
    expect(ctx.getState().isPlaying).toBe(false);
    expect(ctx.getState().speed).toBe(10);

    const playCall = (ctx.send as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).cmd === 'play'
    );
    expect(playCall).toBeDefined();
    const playArgs = playCall?.[0] as Record<string, unknown>;
    expect(playArgs.until).toBe(toEngineTs('2026-07-08', 10, 0));

    const playReceipt = r.result?.receipts.find((rc) => rc.capability === 'playback.play_until');
    expect(playReceipt?.success).toBe(true);
    const playData = playReceipt?.data as { finalTimestamp?: number; finalTime?: string } | undefined;
    expect(playData?.finalTimestamp).toBe(toEngineTs('2026-07-08', 10, 0));
    expect(playData?.finalTime).toBe('10:00');
    expect(r.message).toMatch(/stopped at 10:00/);
  });
});

describe('candle query', () => {
  beforeEach(() => {
    mockFetchCandles(new Set(['2026-07-08', '2026-07-09', '2026-07-10']));
  });

  it('returns the OHLCV of the 10:35 candle', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-08';
    ctx.getState().sessionActive = true;

    const r = await handleOrionMessage({
      text: 'What was the price of the candle at 10:35?',
      ctx,
      setupReady: false,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(r.plan?.steps[0].capability).toBe('chart.get_candle_at_time');

    const candle = r.result?.receipts[0]?.data as CandleData | undefined;
    expect(candle?.timestamp).toBe(toEngineTs('2026-07-08', 10, 35));
    expect(candle?.close).toBe(100.5 + 65);
    expect(r.message).toMatch(/close|open|high|low/);
  });
});

describe('rewind and current candle', () => {
  beforeEach(() => {
    mockFetchCandles(new Set(['2026-07-08', '2026-07-09', '2026-07-10']));
  });

  it('rewinds 30 minutes and reports the candle price', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-08';
    ctx.getState().sessionActive = true;

    const startTs = toEngineTs('2026-07-08', 11, 0);
    (ctx.chartRef?.current as unknown as TestChartHandle).setCurrentCandle({
      timestamp: startTs,
      open: 110,
      high: 111,
      low: 109,
      close: 110.5,
      volume: 1000,
    });

    const r = await handleOrionMessage({
      text: 'Rewind 30 minutes and tell me what price I stopped on.',
      ctx,
      setupReady: false,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);

    const caps = r.plan?.steps.map((s) => s.capability) ?? [];
    expect(caps).toEqual(['playback.seek_relative', 'chart.get_current_candle']);

    const seekCall = (ctx.send as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).cmd === 'seek'
    );
    expect(seekCall).toBeDefined();
    const seekArgs = seekCall?.[0] as Record<string, unknown>;
    expect(seekArgs.timestamp).toBe(startTs - 30 * 60);

    expect(r.message).toMatch(/close/);
  });
});

describe('compound plan stops on required failure', () => {
  it('does not run dependent steps when date resolution fails', async () => {
    mockFetchCandles(new Set(['2026-07-09']));
    const ctx = makeCtx();
    // Anchor to the day before the only available session so only one prior session exists.
    ctx.getState().replayDate = '2026-07-10';

    const r = await handleOrionMessage({
      text: 'Go to Apple two trading sessions ago and fast-forward to 10am.',
      ctx,
      setupReady: false,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(false);

    const planCaps = r.plan?.steps.map((s) => s.capability) ?? [];
    // This request contains no explicit starting time or timeframe, so the plan
    // contains only resolve, switch, confirm-candle, and play-until.
    expect(planCaps).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
      'chart.get_current_candle',
      'playback.play_until',
    ]);

    const resolveReceipt = r.result?.receipts.find((rc) => rc.capability === 'session.resolve_trading_date');
    expect(resolveReceipt?.success).toBe(false);
    if (resolveReceipt && !resolveReceipt.success) {
      expect(resolveReceipt.errorCode).toBe('NO_DATA_FOR_DATE');
      expect((resolveReceipt.data as { nearestAvailable?: string[] } | undefined)?.nearestAvailable).toEqual(['2026-07-09']);
    }

    // Every later step should have an explicit DEPENDENCY_FAILED receipt.
    const receipts = r.result?.receipts ?? [];
    expect(receipts.map((rc) => rc.capability)).toEqual(planCaps);
    const skipped = receipts.slice(1);
    expect(skipped.every((rc) => !rc.success && rc.errorCode === 'DEPENDENCY_FAILED')).toBe(true);

    // No capability execution should have been attempted after the resolve failure.
    expect(ctx.getState().sessionActive).toBe(false);
    expect(ctx.getState().symbol).toBe('');
    expect(ctx.getState().isPlaying).toBe(false);

    const sendMock = ctx.send as unknown as ReturnType<typeof vi.fn>;
    expect(sendMock.mock.calls.length).toBe(0);

    expect(r.result?.stoppedAtStepId).toBe(resolveReceipt?.stepId);
  });
});

describe('resolveTradingDate semantics', () => {
  function hasData(available: Set<string>) {
    return (date: string) => available.has(date);
  }

  it('counts two trading sessions back from the reference date', async () => {
    const available = new Set(['2026-07-08', '2026-07-09', '2026-07-10']);
    const r = await resolveTradingDate(
      { kind: 'relative_trading', sessions: 2, direction: 'backward', from: '2026-07-10' },
      { hasData: hasData(available) }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 2026-07-10 is the reference and is excluded; the two prior available
      // sessions are 2026-07-09 and 2026-07-08.
      expect(r.date).toBe('2026-07-08');
    }
  });

  it('counts one trading session back from the reference date', async () => {
    const available = new Set(['2026-07-08', '2026-07-09', '2026-07-10']);
    const r = await resolveTradingDate(
      { kind: 'relative_trading', sessions: 1, direction: 'backward', from: '2026-07-10' },
      { hasData: hasData(available) }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.date).toBe('2026-07-09');
  });

  it('fails when there are not enough prior sessions', async () => {
    const available = new Set(['2026-07-10']);
    const r = await resolveTradingDate(
      { kind: 'relative_trading', sessions: 2, direction: 'backward', from: '2026-07-10' },
      { hasData: hasData(available) }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/only found 0 trading sessions/i);
  });

  it('reports nearest available sessions on failure', async () => {
    const available = new Set(['2026-07-09', '2026-07-10']);
    const r = await resolveTradingDate(
      { kind: 'relative_trading', sessions: 2, direction: 'backward', from: '2026-07-10' },
      { hasData: hasData(available) }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.nearestAvailable).toEqual(['2026-07-09']);
      expect(r.message).toMatch(/only found 1 trading session/i);
    }
  });
});

describe('ordered time extraction', () => {
  const tickers = ['AAPL'];

  it('orders "from market open to 10am" as 09:30 start, 10:00 end', () => {
    const cmd = parseChartCommand(
      'Go to AAPL two sessions ago and fast-forward from market open to 10am.',
      tickers,
      {},
      '2026-07-10'
    );
    expect(cmd.startTime).toEqual({ hour: 9, minute: 30 });
    expect(cmd.endTime).toEqual({ hour: 10, minute: 0 });
  });

  it('orders "from 10am to noon" as 10:00 start, 12:00 end', () => {
    const cmd = parseChartCommand(
      'Fast-forward from 10am to noon.',
      tickers,
      {},
      '2026-07-10'
    );
    expect(cmd.startTime).toEqual({ hour: 10, minute: 0 });
    expect(cmd.endTime).toEqual({ hour: 12, minute: 0 });
  });

  it('orders "between 1pm and 2:30pm" as 13:00 start, 14:30 end', () => {
    const cmd = parseChartCommand(
      'Play between 1pm and 2:30pm.',
      tickers,
      {},
      '2026-07-10'
    );
    expect(cmd.startTime).toEqual({ hour: 13, minute: 0 });
    expect(cmd.endTime).toEqual({ hour: 14, minute: 30 });
  });
});
