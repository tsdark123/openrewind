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

const candleShapeCurrent = () => ({
  content: JSON.stringify({
    kind: 'chart_action',
    analysisRequests: [{ kind: 'candle_shape', source: 'current_chart_candle' }],
  }),
  toolCalls: [],
  raw: {},
});

const clarification = (message: string) => ({
  content: JSON.stringify({ kind: 'clarification', message }),
  toolCalls: [],
  raw: {},
});

function findCandleShapeStep(plan: { steps: { capability: string; args: Record<string, unknown> }[] } | undefined) {
  return plan?.steps.find((s) => s.capability === 'analysis.candle_shape');
}

describe('candle-shape spoken-time pipeline', () => {
  it('resolves "Describe the candle at eleven thirty." to market_time 11:30', async () => {
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
    const step = findCandleShapeStep(r.plan);
    expect(step).toBeDefined();
    expect(step?.args.source).toBe('market_time');
    expect(step?.args.marketTime).toBe('11:30');
  });

  it('resolves "what kind of candle was the quarter to noon candle?" to market_time 11:45', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(candleShapeCurrent());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'what kind of candle was the quarter to noon candle?',
      ctx,
      setupReady: true,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    const step = findCandleShapeStep(r.plan);
    expect(step).toBeDefined();
    expect(step?.args.source).toBe('market_time');
    expect(step?.args.marketTime).toBe('11:45');
  });

  it('keeps current_chart_candle for deictic "describe this candle"', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(candleShapeCurrent());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'describe this candle',
      ctx,
      setupReady: true,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    const step = findCandleShapeStep(r.plan);
    expect(step).toBeDefined();
    expect(step?.args.source).toBe('current_chart_candle');
    expect(step?.args.marketTime).toBeUndefined();
  });

  it('resolves numeric "what kind of candle was the 11:30 candle?" to market_time 11:30', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(candleShapeCurrent());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'what kind of candle was the 11:30 candle?',
      ctx,
      setupReady: true,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    const step = findCandleShapeStep(r.plan);
    expect(step).toBeDefined();
    expect(step?.args.source).toBe('market_time');
    expect(step?.args.marketTime).toBe('11:30');
  });

  it('clarifies for invalid "describe the candle at eleven seventy"', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(candleShapeCurrent());

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'describe the candle at eleven seventy',
      ctx,
      setupReady: true,
    });

    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(r.plan).toBeUndefined();
  });

  it('resolves spoken time through the deterministic fallback when the model clarifies', async () => {
    vi.mocked(orionChat).mockResolvedValueOnce(
      clarification('Could you clarify which candle you mean?')
    );

    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';

    const r = await handleOrionMessage({
      text: 'describe the candle at three in the afternoon',
      ctx,
      setupReady: true,
    });

    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('llm-plan');
    const step = findCandleShapeStep(r.plan);
    expect(step).toBeDefined();
    expect(step?.args.source).toBe('market_time');
    expect(step?.args.marketTime).toBe('15:00');
  });
});
