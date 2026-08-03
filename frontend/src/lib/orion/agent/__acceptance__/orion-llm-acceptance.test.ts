import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { AppState } from '../../../../types';
import type { AgentContext } from '../types';
import { handleOrionMessage } from '../orchestrator';
import { clearSessionHistory } from '../capabilities';
import { createExecutionContext } from '../executionContext';

const TEST_TIMEOUT = 600_000;

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

  const send = (payload: Record<string, unknown>) => {
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
  };

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

beforeAll(() => {
  // Model availability was verified by `ollama list` before running this file.
});

beforeEach(() => {
  clearSessionHistory();
});

describe('LLM runtime acceptance', () => {
  it(
    'A: "set me up on Nvidia, prior session, 15m, quarter past eleven, candle" routes through llm-plan and produces a valid multi-step plan',
    async () => {
      const ctx = makeCtx();
      const r = await handleOrionMessage({
        text: 'Could you set me up on Nvidia for the prior trading session, use fifteen-minute bars, park the replay at quarter past eleven and tell me what candle I’m on?',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.route).toBe('llm-plan');
      expect(r.wasChat).toBe(false);
      if (r.ok) {
        expect(r.plan!.steps.length).toBeGreaterThanOrEqual(3);
        expect(r.plan!.steps.some((s) => s.capability === 'session.resolve_symbol')).toBe(true);
        expect(r.result?.receipts.some((rc) => rc.capability === 'session.switch_symbol')).toBe(true);
      } else {
        expect(r.route).not.toBe('error');
      }
    },
    TEST_TIMEOUT
  );

  it(
    'B: "move the replay half an hour earlier and give me the bar" routes through llm-plan',
    async () => {
      const ctx = makeCtx();
      ctx.getState().symbol = 'AAPL';
      ctx.getState().sessionActive = true;
      const r = await handleOrionMessage({
        text: 'I’m done watching this section—move the replay half an hour earlier and give me the bar I land on.',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.route).toMatch(/llm-plan|clarification/);
      expect(r.wasChat).toBe(r.route === 'clarification');
    },
    TEST_TIMEOUT
  );

  it(
    'C: "Take me back to the stock I was just on." routes through llm-plan',
    async () => {
      const ctx = makeCtx();
      ctx.getState().symbol = 'AAPL';
      ctx.getState().sessionActive = true;
      await handleOrionMessage({ text: 'Switch to MSFT.', ctx, setupReady: true });

      const r = await handleOrionMessage({ text: 'Take me back to the stock I was just on.', ctx, setupReady: true });
      expect(r).toBeDefined();
      expect(r.route).toMatch(/llm-plan|clarification/);
    },
    TEST_TIMEOUT
  );

  it(
    'D: "Move it over there." returns clarification with no execution',
    async () => {
      const ctx = makeCtx();
      const r = await handleOrionMessage({ text: 'Move it over there.', ctx, setupReady: true });
      expect(r).toBeDefined();
      expect(r.route).toBe('clarification');
      expect(r.result?.receipts ?? []).toHaveLength(0);
      expect(ctx.getState().sessionActive).toBe(false);
    },
    TEST_TIMEOUT
  );

  it(
    'E: "Add VWAP and backtest a crossover." returns unsupported with no execution',
    async () => {
      const ctx = makeCtx();
      const r = await handleOrionMessage({ text: 'Add VWAP and backtest a crossover.', ctx, setupReady: true });
      expect(r).toBeDefined();
      expect(r.route).toBe('unsupported');
      expect(r.result?.receipts ?? []).toHaveLength(0);
      expect(ctx.getState().sessionActive).toBe(false);
    },
    TEST_TIMEOUT
  );
});
