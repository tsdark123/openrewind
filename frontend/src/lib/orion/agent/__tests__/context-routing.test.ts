import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppState } from '../../../../types';
import type { AgentContext } from '../types';
import { handleOrionMessage } from '../orchestrator';
import { createExecutionContext } from '../executionContext';
import { clearSessionHistory } from '../capabilities';
import { orionChat } from '../../client';

vi.mock('../../client', () => ({
  orionChat: vi.fn(),
  ORION_AGENT_MODEL: 'llama3.2:latest',
}));

const mockedOrionChat = vi.mocked(orionChat);

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

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const state = baseAppState();
  const getRecentCandles = (n?: number) => {
    const ts = typeof state.cursor === 'number' ? state.cursor : 1755036600;
    const candle = { timestamp: ts, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 };
    return n === undefined ? [candle] : Array.from({ length: Math.max(1, n) }, () => candle);
  };

  const send = vi.fn((payload: Record<string, unknown>) => {
    if (payload.cmd === 'set_timeframe' && typeof payload.minutes === 'number') {
      state.timeframe = payload.minutes;
    }
    if (payload.cmd === 'play') state.isPlaying = true;
    if (payload.cmd === 'pause') state.isPlaying = false;
    if (payload.cmd === 'seek' && typeof payload.timestamp === 'number') {
      state.cursor = payload.timestamp;
    }
  });

  return {
    getState: () => state,
    chartRef: { current: { getRecentCandles } as any },
    performanceLog: {},
    apiBase: 'http://localhost:9000',
    dataDir: undefined,
    availableTickers: ['AAPL', 'MSFT', 'NVDA'],
    send,
    dispatch: (action) => {
      const a = action as unknown as { type: string; [k: string]: unknown };
      if (a.type === 'SET_PLAYING') state.isPlaying = a.isPlaying as boolean;
      if (a.type === 'SET_SPEED') state.speed = a.speed as number;
      if (a.type === 'SET_TIMEFRAME') state.timeframe = a.timeframe as number;
    },
    onSwitchSymbol: async (symbol, date) => {
      state.symbol = symbol;
      state.replayDate = date ?? state.replayDate;
      state.sessionActive = true;
    },
    executionLog: createExecutionContext(),
    ...overrides,
  };
}

function mockCompactIntent(obj: Record<string, unknown>) {
  return { content: JSON.stringify(obj), toolCalls: [], raw: {} };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearSessionHistory();
  mockedOrionChat.mockReset();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      symbol: 'AAPL',
      date: '2026-07-10',
      timeframe: 1,
      candles: [{ timestamp: 1755036600, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 }],
      missing: false,
    }),
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('recent-action question', () => {
  it('answers "what action did you just perform?" without an LLM call', async () => {
    const ctx = makeCtx();
    await handleOrionMessage({ text: 'Switch to AAPL.', ctx, setupReady: true });
    const r = await handleOrionMessage({ text: 'What action did you just perform?', ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('recent-action-summary');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/switch/i);
    expect(r.message).toMatch(/AAPL/i);
  });

  it('reports no action when the log is empty', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'What action did you just perform?', ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/haven't done anything/i);
  });

  it('normalizes "wut action did u just do" and answers without an LLM call', async () => {
    const ctx = makeCtx();
    await handleOrionMessage({ text: 'Switch to AAPL.', ctx, setupReady: true });
    const r = await handleOrionMessage({ text: 'wut action did u just do', ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('recent-action-summary');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/AAPL/i);
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });
});

describe('bounded context logging', () => {
  it('records a successful switch in the execution log', async () => {
    const ctx = makeCtx();
    await handleOrionMessage({ text: 'Switch to AAPL.', ctx, setupReady: true });
    const latest = ctx.executionLog.latest();
    expect(latest).toBeDefined();
    expect(latest?.route).toBe('deterministic');
    expect(latest?.template?.symbol).toBe('AAPL');
    expect(latest?.ok).toBe(true);
  });

  it('rejects an unresolved explicit symbol before the resolve capability', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Switch to ZZZZ.', ctx, setupReady: true });
    expect(r.ok).toBe(false);
    expect(r.route).toBe('unsupported');
    expect(r.result?.receipts ?? []).toHaveLength(0);
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });
});

describe('contextReference resolution', () => {
  it('repeats the previous action with "do that again"', async () => {
    const ctx = makeCtx();
    await handleOrionMessage({ text: 'Switch to AAPL.', ctx, setupReady: true });
    const r = await handleOrionMessage({ text: 'Do that again.', ctx, setupReady: true });
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.executionLog.getEntries()).toHaveLength(2);
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });

  it('clarifies when the user asks to repeat but nothing succeeded', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Do that again.', ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });

  it('rejects an unresolved explicit symbol before the model can clarify', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Do that again on Mars.', ctx, setupReady: true });
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('unsupported');
    expect(ctx.getState().symbol).toBe('');
    expect(ctx.send).not.toHaveBeenCalled();
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.executionLog.getEntries()).toHaveLength(1);
  });

  it('does not execute capabilities before a validated plan is produced', async () => {
    const ctx = makeCtx();
    mockedOrionChat.mockResolvedValueOnce(
      mockCompactIntent({ kind: 'unsupported', message: 'Unsupported.' })
    );
    const r = await handleOrionMessage({ text: 'Book a flight to the moon.', ctx, setupReady: true });
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('unsupported');
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.executionLog.getEntries()).toHaveLength(1);
  });
});

describe('semantic grounding', () => {
  it('rejects "clean" with a model-hallucinated chart action', async () => {
    const ctx = makeCtx();
    mockedOrionChat.mockResolvedValueOnce(
      mockCompactIntent({
        kind: 'chart_action',
        symbol: 'AAPL',
        date: { kind: 'absolute', value: '2023-03-15' },
        timeframeMinutes: 15,
        seekTime: '11:15',
        finalQuery: 'current_candle',
      })
    );

    const r = await handleOrionMessage({ text: 'clean', ctx, setupReady: true });

    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(r.ok).toBe(true);
    expect(r.plan).toBeUndefined();
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('');
    expect(ctx.getState().timeframe).toBe(1);
    expect(ctx.executionLog.getEntries()).toHaveLength(1);
  });

  it('rejects a hallucinated chart action for "whatever"', async () => {
    const ctx = makeCtx();
    mockedOrionChat.mockResolvedValueOnce(
      mockCompactIntent({
        kind: 'chart_action',
        symbol: 'AAPL',
        date: { kind: 'absolute', value: '2023-03-15' },
        timeframeMinutes: 15,
        seekTime: '11:15',
      })
    );

    const r = await handleOrionMessage({ text: 'whatever', ctx, setupReady: true });

    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(r.ok).toBe(true);
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.executionLog.getEntries()).toHaveLength(1);
  });

  it('does not execute capabilities for short chat phrases', async () => {
    for (const text of ['nice', 'hello', 'okay then']) {
      const ctx = makeCtx();
      const r = await handleOrionMessage({ text, ctx, setupReady: false });
      expect(r.wasChat).toBe(true);
      expect(r.plan).toBeUndefined();
      expect(ctx.send).not.toHaveBeenCalled();
    }
  });

  it('allows grounded unfamiliar language to reach semantic planning', async () => {
    const ctx = makeCtx();
    mockedOrionChat.mockResolvedValueOnce(
      mockCompactIntent({
        kind: 'chart_action',
        symbol: 'NVDA',
        date: { kind: 'relative_trading', count: 1, direction: 'backward' },
        timeframeMinutes: 15,
        finalQuery: 'current_candle',
      })
    );

    const r = await handleOrionMessage({
      text: 'Could you set me up on Nvidia for the prior trading session, use fifteen-minute bars, and tell me what candle I’m on?',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('llm-plan');
    expect(r.ok).toBe(true);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
      'chart.set_timeframe',
      'chart.get_current_candle',
    ]);
    expect(ctx.getState().symbol).toBe('NVDA');
    expect(ctx.getState().timeframe).toBe(15);
    expect(ctx.getState().sessionActive).toBe(true);
  });

  it('allows valid context reference inheritance', async () => {
    const ctx = makeCtx();
    await handleOrionMessage({ text: 'Switch to AAPL 5m.', ctx, setupReady: true });

    mockedOrionChat.mockResolvedValueOnce(
      mockCompactIntent({
        kind: 'chart_action',
        contextReference: { source: 'latest_successful_action', mode: 'inherit', inherit: ['timeframe'] },
      })
    );

    const r = await handleOrionMessage({ text: 'Use the same timeframe.', ctx, setupReady: true });

    expect(r.route).toBe('llm-plan');
    expect(r.ok).toBe(true);
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().timeframe).toBe(5);
    expect(mockedOrionChat).toHaveBeenCalledTimes(1);
  });

  it('allows anaphoric repeat with an explicit symbol override', async () => {
    const ctx = makeCtx();
    await handleOrionMessage({ text: 'Switch to AAPL 5m.', ctx, setupReady: true });

    mockedOrionChat.mockResolvedValueOnce(
      mockCompactIntent({
        kind: 'chart_action',
        symbol: 'MSFT',
        contextReference: { source: 'latest_successful_action', mode: 'repeat' },
      })
    );

    const r = await handleOrionMessage({ text: 'Do that again on MSFT.', ctx, setupReady: true });

    expect(r.route).toBe('llm-plan');
    expect(r.ok).toBe(true);
    expect(ctx.getState().symbol).toBe('MSFT');
    expect(ctx.getState().timeframe).toBe(5);
  });

  it('strips hallucinated date and timeframe from "Take me to Apple around quarter past eleven"', async () => {
    const ctx = makeCtx();
    ctx.getState().replayDate = '2026-07-10';
    ctx.getState().sessionActive = true;

    const r = await handleOrionMessage({
      text: 'Take me to Apple around quarter past eleven.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-10');
    expect(ctx.getState().timeframe).toBe(1);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.switch_symbol',
      'playback.seek_to_time',
    ]);
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'seek', timestamp: expect.any(Number) }));
  });

  it('keeps an explicit date from user text', async () => {
    const ctx = makeCtx();
    ctx.getState().replayDate = '2026-07-10';
    ctx.getState().sessionActive = true;

    const r = await handleOrionMessage({
      text: 'Take me to Apple on 2026-07-30 around quarter past eleven.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-30');
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
      'playback.seek_to_time',
    ]);
  });

  it('keeps an explicit timeframe from user text deterministically', async () => {
    const ctx = makeCtx();
    ctx.getState().replayDate = '2026-07-10';
    ctx.getState().sessionActive = true;

    const r = await handleOrionMessage({
      text: 'Could you set me up on Apple and use fifteen-minute bars?',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().timeframe).toBe(15);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.switch_symbol',
      'chart.set_timeframe',
    ]);
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });

  it('strips a model date equal to the current state as a safe default', async () => {
    const ctx = makeCtx();
    ctx.getState().replayDate = '2026-07-10';
    ctx.getState().sessionActive = true;

    const r = await handleOrionMessage({
      text: 'Take me to Apple around quarter past eleven.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-10');
    expect(r.plan?.steps.map((s) => s.capability)).not.toContain('session.resolve_trading_date');
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.switch_symbol',
      'playback.seek_to_time',
    ]);
  });

  it('clarifies when the model emits a symbol that is not grounded and nothing else remains', async () => {
    const ctx = makeCtx();
    mockedOrionChat.mockResolvedValueOnce(
      mockCompactIntent({
        kind: 'chart_action',
        finalQuery: 'current_candle',
      })
    );

    const r = await handleOrionMessage({ text: 'whatever', ctx, setupReady: true });

    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.executionLog.getEntries()).toHaveLength(1);
  });

  it('records exactly one execution log entry per turn, even when sanitizing', async () => {
    const ctx = makeCtx();
    ctx.getState().replayDate = '2026-07-10';
    ctx.getState().sessionActive = true;

    await handleOrionMessage({ text: 'Take me to Apple around quarter past eleven.', ctx, setupReady: true });
    expect(ctx.executionLog.getEntries()).toHaveLength(1);

    await handleOrionMessage({ text: 'clean', ctx, setupReady: true });
    expect(ctx.executionLog.getEntries()).toHaveLength(2);
  });
});

describe('regression: time-only and invalid-date handling', () => {
  it('inherits the active session date when no date is given in a time-only request', async () => {
    const ctx = makeCtx();
    ctx.getState().replayDate = '2026-07-31';
    ctx.getState().sessionActive = true;
    ctx.getState().timeframe = 5;

    const r = await handleOrionMessage({
      text: 'Take me to Apple around quarter past eleven.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-31');
    expect(ctx.getState().timeframe).toBe(5);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.switch_symbol',
      'playback.seek_to_time',
    ]);
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'seek', timestamp: expect.any(Number) }));
  });

  it('uses the active session date for a time-only request to a different symbol', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-31';
    ctx.getState().sessionActive = true;
    ctx.getState().timeframe = 5;

    const r = await handleOrionMessage({
      text: 'Go to Nvidia at 10:30.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(ctx.getState().symbol).toBe('NVDA');
    expect(ctx.getState().replayDate).toBe('2026-07-31');
    expect(ctx.getState().timeframe).toBe(5);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.switch_symbol',
      'playback.seek_to_time',
    ]);
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'seek', timestamp: expect.any(Number) }));
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });

  it('rejects an explicitly invalid date rather than inheriting the active session date', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-31';
    ctx.getState().sessionActive = true;
    ctx.getState().timeframe = 5;

    const r = await handleOrionMessage({
      text: 'Take me to Apple on 2023-02-31 around quarter past eleven.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(false);
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-31');
    expect(r.message).toMatch(/Invalid date "2023-02-31"/);
  });

  it('preserves a valid explicit date from the user text', async () => {
    const ctx = makeCtx();
    ctx.getState().replayDate = '2026-07-31';
    ctx.getState().sessionActive = true;
    ctx.getState().timeframe = 5;

    const r = await handleOrionMessage({
      text: 'Take me to Apple on 2026-07-30 at 11:15.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-30');
    expect(ctx.getState().timeframe).toBe(5);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
      'playback.seek_to_time',
    ]);
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });

  it('strips an unrequested invalid timeframe on an otherwise valid explicit date + time request', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-31';
    ctx.getState().sessionActive = true;
    ctx.getState().timeframe = 5;

    const r = await handleOrionMessage({
      text: 'Take me to Apple on 2026-07-31 around quarter past eleven.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-31');
    expect(ctx.getState().timeframe).toBe(5);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
      'playback.seek_to_time',
    ]);
  });

  it('strips a hallucinated date and timeframe from a time-only request', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-31';
    ctx.getState().sessionActive = true;
    ctx.getState().timeframe = 5;

    const r = await handleOrionMessage({
      text: 'Take me to Apple around quarter past eleven.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-31');
    expect(ctx.getState().timeframe).toBe(5);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.switch_symbol',
      'playback.seek_to_time',
    ]);
  });

  it('rejects an explicitly malformed timeframe rather than silently fixing it', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-31';
    ctx.getState().sessionActive = true;
    ctx.getState().timeframe = 5;

    mockedOrionChat.mockResolvedValue(
      mockCompactIntent({
        kind: 'chart_action',
        symbol: 'AAPL',
        date: { kind: 'absolute', value: '2026-07-31' },
        seekTime: '11:15',
        timeframeMinutes: 0,
      })
    );

    const r = await handleOrionMessage({
      text: 'Take me to Apple on 2026-07-31 at 11:15 with a 0 minute chart.',
      ctx,
      setupReady: true,
    });

    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(false);
    expect(r.message).toMatch(/timeframeMinutes must be a positive integer/);
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });

  it('preserves a valid explicit timeframe requested by the user', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-31';
    ctx.getState().sessionActive = true;
    ctx.getState().timeframe = 5;

    const r = await handleOrionMessage({
      text: 'Take me to Apple on 2026-07-31 at 11:15 on a 15m chart.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-31');
    expect(ctx.getState().timeframe).toBe(15);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
      'chart.set_timeframe',
      'playback.seek_to_time',
    ]);
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });

  it('uses the current active session date for a time-only request with no model date', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-31';
    ctx.getState().sessionActive = true;
    ctx.getState().timeframe = 5;

    const r = await handleOrionMessage({
      text: 'Take me to Apple around quarter past eleven.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(mockedOrionChat).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('AAPL');
    expect(ctx.getState().replayDate).toBe('2026-07-31');
    expect(ctx.getState().timeframe).toBe(5);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.switch_symbol',
      'playback.seek_to_time',
    ]);
  });
});
