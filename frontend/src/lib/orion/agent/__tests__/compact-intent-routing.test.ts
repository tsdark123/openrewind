import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppState } from '../../../../types';
import type { AgentContext } from '../types';
import { handleOrionMessage } from '../orchestrator';
import { clearSessionHistory } from '../capabilities';
import type { OrionChatMessage } from '../../client';

vi.mock('../../client', () => ({
  orionChat: vi.fn().mockResolvedValue({ content: '', toolCalls: [], raw: {} }),
  ORION_AGENT_MODEL: 'llama3.2:latest',
}));

import { orionChat } from '../../client';

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
  let chartTs = 1755036600;
  const getRecentCandles = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: chartTs - i * 60,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    }));

  const send = vi.fn((payload: Record<string, unknown>) => {
    if (payload.cmd === 'seek' && typeof payload.timestamp === 'number') {
      chartTs = payload.timestamp;
    }
    if (payload.cmd === 'set_timeframe' && typeof payload.minutes === 'number') {
      state.timeframe = payload.minutes;
    }
    if (payload.cmd === 'set_speed' && typeof payload.speed === 'number') {
      state.speed = payload.speed;
    }
    if (payload.cmd === 'play') {
      state.isPlaying = true;
    }
    if (payload.cmd === 'pause') {
      state.isPlaying = false;
    }
  });

  return {
    getState: () => state,
    chartRef: { current: { getRecentCandles } as any },
    performanceLog: {},
    apiBase: 'http://localhost:9000',
    dataDir: undefined,
    availableTickers: ['AAPL', 'ADBE', 'MSFT', 'NVDA'],
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
    ...overrides,
  };
}

function mockCompactIntent(intent: Record<string, unknown>) {
  return {
    content: JSON.stringify(intent),
    toolCalls: [],
    raw: {},
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearSessionHistory();
  mockedOrionChat.mockReset();
  mockedOrionChat.mockResolvedValue({ content: '', toolCalls: [], raw: {} });
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      symbol: 'NVDA',
      date: '2026-07-31',
      timeframe: 1,
      candles: [{ timestamp: 1755036600, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      missing: false,
    }),
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('compact intent routing and execution', () => {
  it('A: "set me up on Nvidia, prior session, 15m, quarter past eleven, candle" routes through llm-plan and executes', async () => {
    mockedOrionChat.mockResolvedValueOnce(
      mockCompactIntent({
        kind: 'chart_action',
        symbol: 'NVDA',
        date: { kind: 'relative_trading', count: 1, direction: 'backward' },
        timeframeMinutes: 15,
        seekTime: '11:15',
        finalQuery: 'current_candle',
      })
    );

    const ctx = makeCtx();
    const r = await handleOrionMessage({
      text: 'Could you set me up on Nvidia for the prior trading session, use fifteen-minute bars, park the replay at quarter past eleven and tell me what candle I’m on?',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('llm-plan');
    expect(r.ok).toBe(true);
    expect(mockedOrionChat).toHaveBeenCalledTimes(1);
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.resolve_symbol',
      'session.resolve_trading_date',
      'session.switch_symbol',
      'chart.set_timeframe',
      'playback.seek_to_time',
      'chart.get_current_candle',
    ]);
    expect(ctx.getState().symbol).toBe('NVDA');
    expect(ctx.getState().timeframe).toBe(15);
    expect(ctx.getState().sessionActive).toBe(true);

    const call = mockedOrionChat.mock.calls[0]?.[0];
    const system = call?.messages.find((m: OrionChatMessage) => m.role === 'system')?.content ?? '';
    expect(system).toContain('"chart_action"');
    expect(call?.format).toBe('json');
    expect(call?.options).toEqual({ temperature: 0, seed: 42, num_predict: 128 });
  });

  it('B: "move the replay half an hour earlier and give me the bar" routes through llm-plan', async () => {
    mockedOrionChat.mockResolvedValueOnce(
      mockCompactIntent({
        kind: 'chart_action',
        relativeSeekMinutes: -30,
        finalQuery: 'current_candle',
      })
    );

    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;
    const r = await handleOrionMessage({
      text: 'I’m done watching this section—move the replay half an hour earlier and give me the bar I land on.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('llm-plan');
    expect(r.result?.receipts.map((rc) => rc.capability)).toEqual(['playback.seek_relative', 'chart.get_current_candle']);
    expect(r.ok).toBe(true);
  });

  it('C: "Take me back to the stock I was just on." routes through llm-plan', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;
    await handleOrionMessage({ text: 'Switch to MSFT.', ctx, setupReady: true });

    mockedOrionChat.mockResolvedValueOnce(mockCompactIntent({ kind: 'chart_action', previousSymbol: true }));

    const r = await handleOrionMessage({ text: 'Take me back to the stock I was just on.', ctx, setupReady: true });
    expect(r.route).toBe('llm-plan');
    expect(r.ok).toBe(true);
    expect(ctx.getState().symbol).toBe('AAPL');
  });

  it('D: "Move it over there." returns clarification with no execution', async () => {
    mockedOrionChat.mockResolvedValueOnce(mockCompactIntent({ kind: 'clarification', message: 'What time, date, or symbol did you mean?' }));

    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Move it over there.', ctx, setupReady: true });
    expect(r.route).toBe('clarification');
    expect(r.wasChat).toBe(true);
    expect(r.result?.receipts ?? []).toHaveLength(0);
    expect(ctx.getState().sessionActive).toBe(false);
  });

  it('E: "Add VWAP and backtest a crossover." returns unsupported with no execution', async () => {
    mockedOrionChat.mockResolvedValueOnce(mockCompactIntent({ kind: 'unsupported', message: 'I don’t have VWAP or backtesting capabilities.' }));

    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Add VWAP and backtest a crossover.', ctx, setupReady: true });
    expect(r.route).toBe('unsupported');
    expect(r.ok).toBe(false);
    expect(r.result?.receipts ?? []).toHaveLength(0);
    expect(ctx.getState().sessionActive).toBe(false);
  });
});

describe('compact intent repair and validation', () => {
  it('repairs an invalid intent and succeeds within two model calls', async () => {
    mockedOrionChat
      .mockResolvedValueOnce(mockCompactIntent({ kind: 'chart_action', symbol: 'NVDA', seekTime: 'abc' }))
      .mockResolvedValueOnce(
        mockCompactIntent({
          kind: 'chart_action',
          symbol: 'NVDA',
          date: { kind: 'relative_trading', count: 1, direction: 'backward' },
          timeframeMinutes: 15,
          seekTime: '11:15',
          finalQuery: 'current_candle',
        })
      );

    const ctx = makeCtx();
    const r = await handleOrionMessage({
      text: 'set me up on Nvidia prior session 15m 11:15 candle',
      ctx,
      setupReady: true,
    });
    expect(mockedOrionChat).toHaveBeenCalledTimes(2);
    expect(r.route).toBe('llm-plan');
    expect(r.ok).toBe(true);
  });

  it('fails when repair still produces an invalid intent', async () => {
    mockedOrionChat.mockResolvedValue(
      mockCompactIntent({ kind: 'chart_action', symbol: 'NVDA', seekTime: 'abc' })
    );

    const ctx = makeCtx();
    const r = await handleOrionMessage({
      text: 'set me up on Nvidia prior session 15m 11:15 candle',
      ctx,
      setupReady: true,
    });
    expect(mockedOrionChat).toHaveBeenCalledTimes(2);
    expect(r.route).toBe('error');
    expect(r.ok).toBe(false);
  });
});

describe('deterministic regression still bypasses the model', () => {
  it('Switch to AAPL. stays deterministic with zero model calls', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Switch to AAPL.', ctx, setupReady: true });
    expect(r.route).toBe('deterministic');
    expect(r.wasChat).toBe(false);
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });

  it('Play at 10x. stays deterministic with no model call', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';
    const r = await handleOrionMessage({ text: 'Play at 10x.', ctx, setupReady: true });
    expect(r.route).toBe('deterministic');
    expect(mockedOrionChat).not.toHaveBeenCalled();
  });
});
