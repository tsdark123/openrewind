import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// The regression tests exercise full agent plans that read candles from the
// engine. Provide a deterministic candle backend so the window/date analysis
// steps can complete and the tests can assert on the final messages/plans.
const ORIGINAL_FETCH = globalThis.fetch;

function makeCandles(symbol: string, date: string, count = 390) {
  const [y, m, d] = date.split('-').map((n) => parseInt(n, 10));
  // Market open is 09:30 ET; in July ET is UTC-4, so the UTC base is 13:30.
  const baseUtc = Math.floor(Date.UTC(y, m - 1, d, 13, 30, 0) / 1000);
  const candles = [];
  for (let i = 0; i < count; i++) {
    const open = 100 + i;
    candles.push({
      timestamp: baseUtc + i * 60,
      open,
      high: open + 2,
      low: open - 1,
      close: open + 1,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

async function mockFetch(
  input: RequestInfo | URL,
  _init?: RequestInit
): Promise<Response> {
  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  if (!url.pathname.endsWith('/api/candles')) {
    return new Response('not found', { status: 404 });
  }
  const symbol = url.searchParams.get('symbol') ?? 'AAPL';
  const date = url.searchParams.get('date') ?? '2026-07-10';
  const timeframe = parseInt(url.searchParams.get('timeframe') ?? '1', 10);
  const candles = makeCandles(symbol, date);
  const body = {
    symbol,
    date,
    timeframe,
    candles,
    missing: false,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

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
    availableTickers: ['AAPL', 'MSFT', 'NVDA', 'LLY'],
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

const clarificationEcho = () => ({
  content: JSON.stringify({
    kind: 'clarification',
    message: 'Describe Apple today.',
  }),
  toolCalls: [],
  raw: {},
});

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
  beforeEach(() => {
    vi.mocked(orionChat).mockReset();
    globalThis.fetch = vi.fn(mockFetch) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

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

  it('"Describe Apple today." from no active session switches and summarizes without calling the model', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(clarificationEcho());

    const ctx = makeCtx();
    ctx.getState().sessionActive = false;

    const r = await handleOrionMessage({
      text: 'Describe Apple today.',
      ctx,
      setupReady: true,
    });

    expect(orionChat).not.toHaveBeenCalled();
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/AAPL/);

    const switchStep = findStep(r.plan, 'session.switch_symbol');
    expect(switchStep).toBeDefined();
    expect(switchStep?.args.symbol).toBe('AAPL');

    const summaryStep = findStep(r.plan, 'analysis.window_summary');
    expect(summaryStep).toBeDefined();
    expect(summaryStep?.args.window).toEqual({ kind: 'whole_session' });
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('"Describe Apple today." when AAPL/date are already active runs window_summary without a switch', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(clarificationEcho());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';
    ctx.getState().replayDate = '2026-07-10';

    const r = await handleOrionMessage({
      text: 'Describe Apple today.',
      ctx,
      setupReady: true,
    });

    expect(orionChat).not.toHaveBeenCalled();
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);

    expect(findStep(r.plan, 'session.resolve_symbol')).toBeUndefined();
    expect(findStep(r.plan, 'session.resolve_trading_date')).toBeUndefined();
    expect(findStep(r.plan, 'session.switch_symbol')).toBeUndefined();

    const summaryStep = findStep(r.plan, 'analysis.window_summary');
    expect(summaryStep).toBeDefined();
    expect(summaryStep?.args.window).toEqual({ kind: 'whole_session' });
  });

  it('"Describe AAPL today." with another active symbol switches and summarizes', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(clarificationEcho());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'MSFT';

    const r = await handleOrionMessage({
      text: 'Describe AAPL today.',
      ctx,
      setupReady: true,
    });

    expect(orionChat).not.toHaveBeenCalled();
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/AAPL/);

    const switchStep = findStep(r.plan, 'session.switch_symbol');
    expect(switchStep).toBeDefined();
    expect(switchStep?.args.symbol).toBe('AAPL');

    const summaryStep = findStep(r.plan, 'analysis.window_summary');
    expect(summaryStep).toBeDefined();
    expect(hasResolveSymbolNamed(r.plan, 'Describe')).toBe(false);
    expect(hasSwitchCausedByDescribe(r.plan)).toBe(false);
  });

  it('"How did Nvidia do today?" switches to NVDA and runs window_summary', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(clarificationEcho());

    const ctx = makeCtx();
    ctx.getState().sessionActive = false;

    const r = await handleOrionMessage({
      text: 'How did Nvidia do today?',
      ctx,
      setupReady: true,
    });

    expect(orionChat).not.toHaveBeenCalled();
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);

    const switchStep = findStep(r.plan, 'session.switch_symbol');
    expect(switchStep).toBeDefined();
    expect(switchStep?.args.symbol).toBe('NVDA');

    const summaryStep = findStep(r.plan, 'analysis.window_summary');
    expect(summaryStep).toBeDefined();
    expect(summaryStep?.args.window).toEqual({ kind: 'whole_session' });
  });

  it('"Show me Apple\'s first-hour range today." switches to AAPL and runs window_ohlc on 09:30-10:30', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(clarificationEcho());

    const ctx = makeCtx();
    ctx.getState().sessionActive = false;

    const r = await handleOrionMessage({
      text: "Show me Apple's first-hour range today.",
      ctx,
      setupReady: true,
    });

    expect(orionChat).not.toHaveBeenCalled();
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);

    const switchStep = findStep(r.plan, 'session.switch_symbol');
    expect(switchStep).toBeDefined();
    expect(switchStep?.args.symbol).toBe('AAPL');

    const ohlcStep = findStep(r.plan, 'analysis.window_ohlc');
    expect(ohlcStep).toBeDefined();
    expect(ohlcStep?.args.window).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '10:30' });
  });

  it('"Give me the session summary for Eli Lilly yesterday." switches to LLY on 2026-07-09 and summarizes', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(clarificationEcho());

    const ctx = makeCtx();
    ctx.getState().sessionActive = false;

    const r = await handleOrionMessage({
      text: 'Give me the session summary for Eli Lilly yesterday.',
      ctx,
      setupReady: true,
    });

    expect(orionChat).not.toHaveBeenCalled();
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);

    const resolveDateStep = findStep(r.plan, 'session.resolve_trading_date');
    expect(resolveDateStep).toBeDefined();
    expect(resolveDateStep?.args.symbol).toBe('LLY');

    const switchStep = findStep(r.plan, 'session.switch_symbol');
    expect(switchStep).toBeDefined();
    expect(switchStep?.args.symbol).toBe('LLY');

    const summaryStep = findStep(r.plan, 'analysis.window_summary');
    expect(summaryStep).toBeDefined();
    expect(summaryStep?.args.window).toEqual({ kind: 'whole_session' });
  });

  it('"What was the range and volume today?" stays ambiguous and does not hijack the semantic path', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(clarificationEcho());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'What was the range and volume today?',
      ctx,
      setupReady: true,
    });

    expect(orionChat).toHaveBeenCalled();
    expect(r.route).toBe('clarification');
    expect(r.message).toBe('Describe Apple today.');
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
