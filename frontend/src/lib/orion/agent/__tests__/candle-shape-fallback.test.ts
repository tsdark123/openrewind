import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AppState } from '../../../../types';
import type { AgentContext } from '../types';
import { handleOrionMessage } from '../orchestrator';
import { createExecutionContext } from '../executionContext';

vi.mock('../../client', () => ({
  ORION_AGENT_MODEL: 'qwen3:8b',
  AGENT_KEEP_ALIVE: '5m',
  orionChat: vi.fn(),
}));

import { orionChat } from '../../client';

function baseAppState(): AppState {
  return {
    symbol: '',
    replayDate: '2026-07-10',
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

function makeCtx(): AgentContext {
  const state = baseAppState();
  return {
    getState: () => state,
    chartRef: null,
    performanceLog: {},
    apiBase: 'http://localhost:9000',
    dataDir: undefined,
    availableTickers: ['AAPL', 'MSFT', 'NVDA'],
    send: vi.fn(),
    dispatch: vi.fn(),
    onSwitchSymbol: async (symbol, date) => {
      state.symbol = symbol;
      state.replayDate = date ?? state.replayDate;
      state.sessionActive = true;
    },
    executionLog: createExecutionContext(),
  };
}

describe('candle-shape clarification fallback', () => {
  beforeAll(() => {
    vi.mocked(orionChat).mockResolvedValue({
      content: '{"kind":"clarification","message":"Could you clarify which candle you mean?"}',
      toolCalls: [],
      raw: {},
    });
  });

  afterAll(() => {
    vi.mocked(orionChat).mockRestore();
  });

  it('uses current_chart_candle for "what kind of candle am I on rn?"', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({ text: 'what kind of candle am I on rn?', ctx, setupReady: true });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    expect(r.plan?.steps[0].capability).toBe('analysis.candle_shape');
    expect((r.plan?.steps[0].args as any)?.source).toBe('current_chart_candle');
  });

  it('uses current_chart_candle for "describe this candle" when context supports it', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({ text: 'describe this candle', ctx, setupReady: true });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    expect(r.plan?.steps[0].capability).toBe('analysis.candle_shape');
    expect((r.plan?.steps[0].args as any)?.source).toBe('current_chart_candle');
  });

  it('does not use current_chart_candle for "what kind of candle was the 11:30 candle?"', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({ text: 'what kind of candle was the 11:30 candle?', ctx, setupReady: true });

    expect(r.route).toBe('clarification');
    expect(r.plan).toBeUndefined();
    expect(r.wasChat).toBe(true);
  });

  it('does not use current_chart_candle for an explicit-time paraphrase', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({ text: 'what was the shape of the candle at two in the afternoon?', ctx, setupReady: true });

    expect(r.route).toBe('clarification');
    expect(r.plan).toBeUndefined();
    expect(r.wasChat).toBe(true);
  });
});
