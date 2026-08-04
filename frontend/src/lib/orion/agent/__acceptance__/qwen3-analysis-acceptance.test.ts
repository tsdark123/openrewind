import { describe, it, expect, beforeEach } from 'vitest';
import type { AppState } from '../../../../types';
import type { AgentContext } from '../types';
import { handleOrionMessage } from '../orchestrator';
import { clearSessionHistory } from '../capabilities';
import { createExecutionContext } from '../executionContext';

const TEST_TIMEOUT = 120_000;

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
    const ts = state.cursor > 0 ? state.cursor : 1785849000;
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
      if (a.type === 'SET_SYMBOL') {
        state.symbol = a.symbol as string;
        state.sessionActive = true;
      }
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

async function setupAapl(ctx: AgentContext) {
  const r = await handleOrionMessage({
    text: 'Switch to AAPL 2026-07-10 1m.',
    ctx,
    setupReady: true,
  });
  expect(r.ok).toBe(true);
  expect(ctx.getState().symbol).toBe('AAPL');
  expect(ctx.getState().sessionActive).toBe(true);
  // Provide a synthetic candle buffer so up_to_cursor analyses can resolve.
  ctx.getState().totalCandles = 100;
}

beforeEach(() => {
  clearSessionHistory();
});

describe('qwen3:8b analysis semantic-intent acceptance', () => {
  it(
    'A: formal wording "What was the opening range from 09:30 to 10:30?"',
    async () => {
      const ctx = makeCtx();
      await setupAapl(ctx);
      const r = await handleOrionMessage({
        text: 'What was the opening range from 09:30 to 10:30?',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.route).toMatch(/llm-plan/);
      expect(r.wasChat).toBe(false);
      if (r.ok && r.plan) {
        expect(r.plan.steps.some((s) => s.capability === 'analysis.window_ohlc')).toBe(true);
        const step = r.plan.steps.find((s) => s.capability === 'analysis.window_ohlc');
        expect(step).toBeDefined();
        const window = step!.args.window as { kind: string; fromTime?: string; toTime?: string };
        expect(window.kind).toBe('time_range');
        expect(window.fromTime).toBe('09:30');
        expect(window.toTime).toBe('10:30');
      }
    },
    TEST_TIMEOUT
  );

  it(
    'B: shorthand "range first hour"',
    async () => {
      const ctx = makeCtx();
      await setupAapl(ctx);
      const r = await handleOrionMessage({
        text: 'range first hour',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);
      expect(r.plan).toBeDefined();
      if (r.ok && r.plan) {
        const analysisSteps = r.plan.steps.filter((s) => s.capability.startsWith('analysis.'));
        expect(analysisSteps).toHaveLength(1);
        const step = analysisSteps[0];
        expect(step.capability).toBe('analysis.window_ohlc');
        const window = step.args.window as { kind: string; n?: number; fromTime?: string; toTime?: string };
        expect(['time_range', 'first_n_minutes']).toContain(window.kind);
        if (window.kind === 'time_range') {
          expect(window.fromTime).toBe('09:30');
          expect(window.toTime).toBe('10:30');
        } else {
          expect(window.n).toBe(60);
        }
      }
    },
    TEST_TIMEOUT
  );

  it(
    'C: mild typo "volum this mornig"',
    async () => {
      const ctx = makeCtx();
      await setupAapl(ctx);
      const r = await handleOrionMessage({
        text: 'volum this mornig',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);
      expect(r.plan).toBeDefined();
      if (r.ok && r.plan) {
        const analysisSteps = r.plan.steps.filter((s) => s.capability.startsWith('analysis.'));
        expect(analysisSteps).toHaveLength(1);
        const step = analysisSteps[0];
        expect(step.capability).toBe('analysis.window_volume');
        const window = step.args.window as { kind: string; fromTime?: string; toTime?: string };
        expect(window.kind).toBe('time_range');
        expect(window.fromTime).toBe('09:30');
        expect(window.toTime).toBe('12:00');
      }
    },
    TEST_TIMEOUT
  );

  it(
    'D: compound "give me the move, total volume and candle anatomy from 10 to noon"',
    async () => {
      const ctx = makeCtx();
      await setupAapl(ctx);
      const r = await handleOrionMessage({
        text: 'give me the move, total volume and candle anatomy from 10 to noon',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);
      expect(r.plan).toBeDefined();
      if (r.ok && r.plan) {
        const analysisSteps = r.plan.steps.filter((s) => s.capability.startsWith('analysis.'));
        expect(analysisSteps).toHaveLength(3);

        const changeStep = analysisSteps.find(
          (s) => s.capability === 'analysis.window_change' || s.capability === 'analysis.window_summary'
        );
        expect(changeStep).toBeDefined();
        const volumeStep = analysisSteps.find((s) => s.capability === 'analysis.window_volume');
        expect(volumeStep).toBeDefined();
        const candleStep = analysisSteps.find((s) => s.capability === 'analysis.candle_shape');
        expect(candleStep).toBeDefined();

        const expectedWindow = { kind: 'time_range', fromTime: '10:00', toTime: '12:00' };
        expect((changeStep!.args.window as any)).toEqual(expectedWindow);
        expect((volumeStep!.args.window as any)).toEqual(expectedWindow);

        const candleArgs = candleStep!.args as { source: string; marketTime?: string };
        expect(candleArgs.source).toBe('market_time');
        expect(candleArgs.marketTime).toBe('12:00');

        expect(r.result?.receipts.length ?? 0).toBeGreaterThanOrEqual(3);
        const messages = r.result!.receipts.map((rc) => rc.message).join(' ').toLowerCase();
        expect(messages).toMatch(/\b(change|move)\b/);
        expect(messages).toMatch(/\bvolume\b/);
        expect(messages).toMatch(/\b(body|wick|anatomy|shape)\b/);
      }
    },
    TEST_TIMEOUT
  );

  it(
    'E: window comparison "compare morning and afternoon and tell me which had more volume"',
    async () => {
      const ctx = makeCtx();
      await setupAapl(ctx);
      const r = await handleOrionMessage({
        text: 'compare morning and afternoon and tell me which had more volume',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);
      expect(r.plan).toBeDefined();
      if (r.ok && r.plan) {
        const analysisSteps = r.plan.steps.filter((s) => s.capability.startsWith('analysis.'));
        expect(analysisSteps).toHaveLength(2);

        const compareStep = analysisSteps.find((s) => s.capability === 'analysis.window_compare');
        expect(compareStep).toBeDefined();
        const volumeStep = analysisSteps.find((s) => s.capability === 'analysis.window_volume');
        expect(volumeStep).toBeDefined();

        const compareArgs = compareStep!.args as {
          left: { kind: string; fromTime?: string; toTime?: string };
          right: { kind: string; fromTime?: string; toTime?: string };
        };
        expect(compareArgs.left).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '12:00' });
        expect(compareArgs.right).toEqual({ kind: 'time_range', fromTime: '12:00', toTime: '16:00' });

        const volumeArgs = volumeStep!.args as { window: { kind: string; fromTime?: string; toTime?: string } };
        expect(volumeArgs.window).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '16:00' });

        const messages = r.result!.receipts.map((rc) => rc.message).join(' ').toLowerCase();
        expect(messages).toMatch(/\b(volume|higher|lower|more|less)\b/);
      }
    },
    TEST_TIMEOUT
  );

  it(
    'F: candle shape "what kind of candle am I on right now"',
    async () => {
      const ctx = makeCtx();
      await setupAapl(ctx);
      const r = await handleOrionMessage({
        text: 'what kind of candle am I on right now',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);
      expect(r.plan).toBeDefined();
      if (r.ok && r.plan) {
        const step = r.plan.steps.find((s) => s.capability === 'analysis.candle_shape');
        expect(step).toBeDefined();
      }
    },
    TEST_TIMEOUT
  );

  it(
    'G: up_to_cursor "how did it do up to now"',
    async () => {
      const ctx = makeCtx();
      await setupAapl(ctx);
      const r = await handleOrionMessage({
        text: 'how did it do up to now',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
      expect(r.route).toMatch(/llm-plan/);
      expect(r.plan).toBeDefined();
      if (r.ok && r.plan) {
        const analysisSteps = r.plan.steps.filter((s) => s.capability.startsWith('analysis.'));
        expect(analysisSteps).toHaveLength(1);

        const step = analysisSteps[0];
        expect(['analysis.window_change', 'analysis.window_summary']).toContain(step.capability);
        const window = step.args.window as { kind: string };
        expect(window.kind).toBe('up_to_cursor');

        const successReceipt = r.result!.receipts.find((rc) => rc.success);
        expect(successReceipt).toBeDefined();
        const msg = (successReceipt?.message ?? '').toLowerCase();
        expect(msg).toMatch(/\b(change|move|open|close|%)\b/);
      }
    },
    TEST_TIMEOUT
  );

  it(
    'H: unsupported analysis "is there a breakout forming"',
    async () => {
      const ctx = makeCtx();
      await setupAapl(ctx);
      const r = await handleOrionMessage({
        text: 'is there a breakout forming',
        ctx,
        setupReady: true,
      });
      expect(r).toBeDefined();
      expect(r.ok).toBe(false);
      expect(['unsupported', 'clarification'] as string[]).toContain(r.route);
      expect(r.result?.receipts ?? []).toHaveLength(0);
    },
    TEST_TIMEOUT
  );
});
