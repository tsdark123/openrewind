import { describe, it, expect, vi } from 'vitest';
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

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
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
    ...overrides,
  };
}

const windowSummaryIntent = () => ({
  content: JSON.stringify({
    kind: 'chart_action',
    analysisRequests: [{ kind: 'window_summary', window: { kind: 'whole_session' } }],
  }),
  toolCalls: [],
  raw: {},
});

const windowChangeIntent = () => ({
  content: JSON.stringify({
    kind: 'chart_action',
    analysisRequests: [{ kind: 'window_change', window: { kind: 'whole_session' } }],
  }),
  toolCalls: [],
  raw: {},
});

const candleShapeCurrent = () => ({
  content: JSON.stringify({
    kind: 'chart_action',
    analysisRequests: [{ kind: 'candle_shape', source: 'current_chart_candle' }],
  }),
  toolCalls: [],
  raw: {},
});

function findStep(plan: { steps: { capability: string; args: Record<string, unknown> }[] } | undefined, capability: string) {
  return plan?.steps.find((s) => s.capability === capability);
}

function hasResolveSymbolNamed(plan: { steps: { capability: string; args: Record<string, unknown> }[] } | undefined, name: string) {
  return plan?.steps.some((s) => s.capability === 'session.resolve_symbol' && s.args.name === name);
}

function hasSwitchCausedByDescribe(plan: { steps: { capability: string; args: Record<string, unknown> }[] } | undefined) {
  return plan?.steps.some((s) => s.capability === 'session.switch_symbol' && s.args.symbol === 'Describe');
}

describe('verb-grounding regression', () => {
  it('"Describe what happened today." with active session routes to window_summary', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'Describe what happened today.',
      ctx,
      setupReady: false,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    const step = findStep(r.plan, 'analysis.window_summary');
    expect(step).toBeDefined();
    expect(step?.args.window).toEqual({ kind: 'whole_session' });
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('"Summarize today." with active session routes to window_summary', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'Summarize today.',
      ctx,
      setupReady: false,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    const step = findStep(r.plan, 'analysis.window_summary');
    expect(step).toBeDefined();
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('"What happened during this session?" with active session routes to window_summary', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'What happened during this session?',
      ctx,
      setupReady: false,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    const step = findStep(r.plan, 'analysis.window_summary');
    expect(step).toBeDefined();
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('broad summary with no active session returns a clarification', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = false;

    const r = await handleOrionMessage({
      text: 'Describe what happened today.',
      ctx,
      setupReady: false,
    });

    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(r.message).toMatch(/no active session/i);
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('"Switch to Apple." resolves and switches to AAPL', async () => {
    const ctx = makeCtx();

    const r = await handleOrionMessage({
      text: 'Switch to Apple.',
      ctx,
      setupReady: false,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    const switchStep = findStep(r.plan, 'session.switch_symbol');
    expect(switchStep).toBeDefined();
    expect(switchStep?.args.symbol).toBe('AAPL');
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('"Describe Apple today." with another active symbol switches and summarizes', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(windowSummaryIntent());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'MSFT';

    const r = await handleOrionMessage({
      text: 'Describe Apple today.',
      ctx,
      setupReady: true,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/AAPL/);
    const switchStep = findStep(r.plan, 'session.switch_symbol');
    expect(switchStep).toBeDefined();
    const summaryStep = findStep(r.plan, 'analysis.window_summary');
    expect(summaryStep).toBeDefined();
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('"Describe AAPL today." with another active symbol switches and summarizes', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(windowSummaryIntent());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'MSFT';

    const r = await handleOrionMessage({
      text: 'Describe AAPL today.',
      ctx,
      setupReady: true,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/AAPL/);
    const switchStep = findStep(r.plan, 'session.switch_symbol');
    expect(switchStep).toBeDefined();
    const summaryStep = findStep(r.plan, 'analysis.window_summary');
    expect(summaryStep).toBeDefined();
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('"Describe the candle at eleven thirty." still produces candle_shape at 11:30', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(candleShapeCurrent());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'Describe the candle at eleven thirty.',
      ctx,
      setupReady: true,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    const step = findStep(r.plan, 'analysis.candle_shape');
    expect(step).toBeDefined();
    expect(step?.args.source).toBe('market_time');
    expect(step?.args.marketTime).toBe('11:30');
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('"Describe the move from 10 to noon." still produces window_change', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(windowChangeIntent());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'Describe the move from 10 to noon.',
      ctx,
      setupReady: true,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    const step = findStep(r.plan, 'analysis.window_change');
    expect(step).toBeDefined();
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });
});
