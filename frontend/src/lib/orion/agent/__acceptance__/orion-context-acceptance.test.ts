import { describe, it, expect, beforeEach } from 'vitest';
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

  const getRecentCandles = (n: number) => {
    const ts = state.cursor > 0 ? state.cursor : 1755036600;
    return Array.from({ length: n }, (_, i) => ({
      timestamp: ts - i * 60,
      open: 100 + (ts % 100) / 100,
      high: 101 + (ts % 100) / 100,
      low: 99 + (ts % 100) / 100,
      close: 100.5 + (ts % 100) / 100,
      volume: 1000 + (ts % 1000),
    }));
  };

  const send = (payload: Record<string, unknown>) => {
    if (payload.cmd === 'seek' && typeof payload.timestamp === 'number') {
      state.cursor = payload.timestamp;
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
      if (date) state.replayDate = date;
      state.sessionActive = true;
    },
    executionLog: createExecutionContext(),
    ...overrides,
  };
}

function setCursorFromCandle(ctx: AgentContext, data: unknown) {
  const d = data as { timestamp?: number } | undefined;
  if (d?.timestamp) {
    ctx.getState().cursor = d.timestamp;
  }
}

beforeEach(() => {
  clearSessionHistory();
});

describe('Multi-turn runtime acceptance', () => {
  it(
    'A: "Do that again on AAPL" repeats the last successful action on a different symbol',
    async () => {
      const ctx = makeCtx();
      const first = await handleOrionMessage({
        text: 'Set me up on Nvidia for the prior trading session, use fifteen-minute bars, park the replay at quarter past eleven and tell me what candle I am on.',
        ctx,
        setupReady: true,
      });
      expect(first.ok).toBe(true);
      expect(first.route).toBe('llm-plan');

      const r = await handleOrionMessage({
        text: 'Do that again on AAPL.',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);
      if (r.ok && r.result) {
        expect(r.result.receipts.length).toBeGreaterThan(0);
      }

      expect(ctx.getState().symbol).toBe('AAPL');
      expect(ctx.getState().timeframe).toBe(15);

      const last = ctx.executionLog.latest();
      expect(last).toBeDefined();
      expect(last!.template?.symbol).toBe('AAPL');
      expect(last!.template?.timeframeMinutes).toBe(15);
      expect(last!.template?.seekTime).toBe('11:15');
      expect(last!.template?.finalQuery).toBe('current_candle');
      expect(ctx.executionLog.getEntries().length).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT
  );

  it(
    'B: "Use the same timeframe but go to the prior trading session" inherits only timeframe',
    async () => {
      const ctx = makeCtx();
      const first = await handleOrionMessage({
        text: 'Switch to AAPL 2026-07-31 15m.',
        ctx,
        setupReady: true,
      });
      expect(first.ok).toBe(true);
      expect(ctx.getState().symbol).toBe('AAPL');
      expect(ctx.getState().replayDate).toBe('2026-07-31');
      expect(ctx.getState().timeframe).toBe(15);

      const r = await handleOrionMessage({
        text: 'Use the same timeframe but go to the prior trading session.',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);

      expect(ctx.getState().timeframe).toBe(15);
      expect(ctx.getState().replayDate).toBe('2026-07-30');
      expect(ctx.executionLog.getEntries().length).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT
  );

  it(
    'C: "Go back to the candle we were discussing" restores the stored candle coordinates',
    async () => {
      const ctx = makeCtx();

      const setup = await handleOrionMessage({
        text: 'Switch to AAPL 2026-07-31 15m.',
        ctx,
        setupReady: true,
      });
      expect(setup.ok).toBe(true);

      const first = await handleOrionMessage({
        text: 'Give me the candle at 11:15.',
        ctx,
        setupReady: true,
      });
      expect(first.ok).toBe(true);
      const firstCandle = first.result?.receipts.find(
        (rc) => rc.success && rc.capability === 'chart.get_candle_at_time'
      );
      expect(firstCandle).toBeDefined();
      setCursorFromCandle(ctx, firstCandle?.data);

      const move = await handleOrionMessage({
        text: 'Switch to MSFT 2026-07-31 15m and seek to 11:30.',
        ctx,
        setupReady: true,
      });
      expect(move.ok).toBe(true);
      expect(ctx.getState().symbol).toBe('MSFT');

      const r = await handleOrionMessage({
        text: 'Go back to the candle we were discussing.',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);

      expect(ctx.getState().symbol).toBe('AAPL');
      expect(ctx.getState().replayDate).toBe('2026-07-31');
      expect(ctx.getState().timeframe).toBe(15);

      expect(ctx.executionLog.getEntries().length).toBeGreaterThanOrEqual(4);
    },
    TEST_TIMEOUT
  );

  it(
    'D: "Compare this candle with the previous candle you reported" uses a stable snapshot reference',
    async () => {
      const ctx = makeCtx();

      const setup = await handleOrionMessage({
        text: 'Switch to AAPL 2026-07-31 15m.',
        ctx,
        setupReady: true,
      });
      expect(setup.ok).toBe(true);

      const first = await handleOrionMessage({
        text: 'Give me the candle at 11:00.',
        ctx,
        setupReady: true,
      });
      expect(first.ok).toBe(true);
      const firstCandle = ctx.executionLog.latestReturnedCandle();
      expect(firstCandle).toBeDefined();

      const second = await handleOrionMessage({
        text: 'Give me the candle at 11:30.',
        ctx,
        setupReady: true,
      });
      expect(second.ok).toBe(true);
      const secondData = second.result?.receipts.find(
        (rc) => rc.success && rc.capability === 'chart.get_candle_at_time'
      )?.data as { close?: number } | undefined;
      expect(secondData).toBeDefined();
      setCursorFromCandle(ctx, secondData);

      const r = await handleOrionMessage({
        text: 'Compare this candle with the previous candle you reported.',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);

      const secondCandle = ctx.executionLog.latestReturnedCandle();
      const previousCandle = ctx.executionLog.previousReturnedCandle();
      expect(secondCandle).toBeDefined();
      expect(previousCandle).toBeDefined();

      const compareStep = r.plan?.steps.find((step) => step.capability === 'analysis.compare_candles');
      expect(compareStep).toBeDefined();
      if (compareStep) {
        const left = compareStep.args.left as Record<string, unknown> | undefined;
        const right = compareStep.args.right as Record<string, unknown> | undefined;
        expect(left?.source).toBe('snapshot');
        expect(left?.snapshotId).toBe(secondCandle!.snapshotId);
        expect(left?.marketTime).toBe('11:30');
        expect(right?.source).toBe('snapshot');
        expect(right?.snapshotId).toBe(previousCandle!.snapshotId);
        expect(right?.marketTime).toBe('11:00');
      }

      if (r.ok && r.result) {
        const compareReceipt = r.result.receipts.find(
          (receipt) => receipt.success && receipt.capability === 'analysis.compare_candles'
        );
        expect(compareReceipt).toBeDefined();
        if (compareReceipt) {
          const data = compareReceipt.data as {
            left: { close?: number };
            right: { close?: number };
            deltas: Record<string, unknown>;
          };
          expect(data.left).toBeDefined();
          expect(data.right).toBeDefined();
          expect(data.deltas).toBeDefined();
          expect(compareReceipt.message).toMatch(/11:30/);
          expect(compareReceipt.message).toMatch(/11:00/);
          // The comparison must use the two returned snapshots, not the live chart cursor.
          expect(data.left.close).toEqual(secondData?.close);
          expect(data.right.close).toEqual(firstCandle?.close);
        }
      }
      expect(ctx.executionLog.getEntries().length).toBeGreaterThanOrEqual(4);
    },
    TEST_TIMEOUT
  );

  it(
    'E: "What action did you just perform?" is grounded without an LLM call',
    async () => {
      const ctx = makeCtx();
      const first = await handleOrionMessage({
        text: 'Switch to AAPL 5m.',
        ctx,
        setupReady: true,
      });
      expect(first.ok).toBe(true);

      const r = await handleOrionMessage({
        text: 'What action did you just perform?',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.wasChat).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.route).toBe('recent-action-summary');
      expect(r.message).toMatch(/AAPL/i);
      expect(ctx.executionLog.getEntries()).toHaveLength(2);
    },
    TEST_TIMEOUT
  );
});
