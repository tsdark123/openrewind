import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    journalRecords: [],
    journalFilter: null,
    lightMode: false,
    showIntro: false,
    view: 'menu',
    dataSource: 'managed',
    replayRate: 1,
    lastOhlc: null,
    symbolError: '',
    dateError: '',
    dateConfirmed: false,
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

beforeEach(() => {
  vi.mocked(orionChat).mockReset();
});

describe('orchestrator preflight rejects invalid input before the model', () => {
  it('rejects an explicit 11:70 time', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'What happened at 11:70?', ctx, setupReady: true });
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(r.plan).toBeUndefined();
    expect(orionChat).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('rejects the spoken invalid time "eleven seventy"', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';
    const r = await handleOrionMessage({ text: 'describe the candle at eleven seventy', ctx, setupReady: true });
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(r.plan).toBeUndefined();
    expect(orionChat).not.toHaveBeenCalled();
  });

  it('rejects an explicit unknown symbol after "for" as unsupported', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'What is the candle for UNKNOWN?', ctx, setupReady: true });
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('unsupported');
    expect(orionChat).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('rejects a weak-cue unknown symbol ("on Mars") as unsupported', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Do that again on Mars.', ctx, setupReady: true });
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('unsupported');
    expect(orionChat).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('rejects an unresolvable company name after "switch to" as unsupported', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Switch to Zorblatt.', ctx, setupReady: true });
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('unsupported');
    expect(orionChat).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous company-name candidate as a clarification', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Switch to Tesla Netflix.', ctx, setupReady: true });
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(r.message).toMatch(/Tesla|Netflix|TSLA|NFLX/);
    expect(orionChat).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('still allows a valid deterministic switch', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Switch to AAPL.', ctx, setupReady: true });
    expect(r.ok).toBe(true);
    expect(r.route).toBe('deterministic');
    expect(orionChat).not.toHaveBeenCalled();
    expect(ctx.getState().symbol).toBe('AAPL');
  });
});
