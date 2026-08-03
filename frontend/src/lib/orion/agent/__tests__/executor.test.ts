import { describe, it, expect, vi } from 'vitest';
import type { AppState } from '../../../../types';
import type { AgentPlan, AgentContext } from '../types';
import { executeAgentPlan } from '../executor';
import { createExecutionContext } from '../executionContext';
import { makeStepId } from '../types';
import { getCapability } from '../capabilities';

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
  return {
    getState: () => state,
    chartRef: null,
    performanceLog: {},
    apiBase: 'http://localhost:9000',
    dataDir: undefined,
    availableTickers: ['AAPL', 'ADBE', 'MSFT'],
    send: vi.fn(),
    dispatch: (action) => {
      const a = action as unknown as { type: string; [k: string]: unknown };
      if (a.type === 'SET_PLAYING') {
        state.isPlaying = a.isPlaying as boolean;
      } else if (a.type === 'SET_SPEED') {
        state.speed = a.speed as number;
      } else if (a.type === 'SET_TIMEFRAME') {
        state.timeframe = a.timeframe as number;
      }
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

function switchPlan(symbol: string): AgentPlan {
  return {
    id: 'plan-1',
    kind: 'action',
    summary: `switch to ${symbol}`,
    steps: [
      { id: makeStepId(0), capability: 'session.resolve_symbol', args: { name: `switch to ${symbol}` }, required: true },
      { id: makeStepId(1), capability: 'session.switch_symbol', args: { symbol }, required: true, dependsOn: [makeStepId(0)] },
    ],
  };
}

describe('executeAgentPlan', () => {
  it('executes steps in order', async () => {
    const ctx = makeCtx();
    const plan = switchPlan('AAPL');
    const r = await executeAgentPlan(plan, ctx);
    expect(r.ok).toBe(true);
    expect(r.receipts).toHaveLength(2);
    expect(r.receipts[0].capability).toBe('session.resolve_symbol');
    expect(r.receipts[1].capability).toBe('session.switch_symbol');
    expect(ctx.getState().symbol).toBe('AAPL');
  });

  it('stops execution when a required step fails', async () => {
    const ctx = makeCtx({ onSwitchSymbol: vi.fn() });
    const plan = switchPlan('AAPL');
    const r = await executeAgentPlan(plan, ctx);
    expect(r.ok).toBe(false);
    expect(r.receipts[0].success).toBe(true);
    expect(r.receipts[1].success).toBe(false);
    if (!r.receipts[1].success) {
      expect(r.receipts[1].errorCode).toBe('ACKNOWLEDGMENT_TIMEOUT');
    }
    expect(r.stoppedAtStepId).toBe(plan.steps[1].id);
    expect(r.receipts).toHaveLength(2);
  });

  it('continues past an optional failure', async () => {
    const ctx = makeCtx();
    const plan: AgentPlan = {
      id: 'plan-2',
      kind: 'action',
      summary: 'optional query then switch',
      steps: [
        { id: makeStepId(0), capability: 'chart.get_current_candle', args: {}, required: false },
        { id: makeStepId(1), capability: 'session.switch_symbol', args: { symbol: 'AAPL' }, required: true },
      ],
    };
    const r = await executeAgentPlan(plan, ctx);
    expect(r.ok).toBe(true);
    expect(r.receipts[0].success).toBe(false); // no chart, optional
    expect(r.receipts[1].success).toBe(true);
  });

  it('skips dependent steps when a required dependency fails', async () => {
    const ctx = makeCtx({ onSwitchSymbol: vi.fn() });
    const plan: AgentPlan = {
      id: 'plan-3',
      kind: 'action',
      summary: 'probe candle then switch',
      steps: [
        { id: makeStepId(0), capability: 'chart.get_current_candle', args: {}, required: false },
        { id: makeStepId(1), capability: 'session.switch_symbol', args: { symbol: 'AAPL' }, required: true, dependsOn: [makeStepId(0)] },
      ],
    };
    const r = await executeAgentPlan(plan, ctx);
    expect(r.ok).toBe(false);
    expect(r.receipts[0].success).toBe(false);
    expect(r.receipts[1].success).toBe(false);
    if (!r.receipts[1].success) {
      expect(r.receipts[1].errorCode).toBe('DEPENDENCY_FAILED');
    }
    expect(r.stoppedAtStepId).toBe(plan.steps[1].id);
  });

  it('generates one receipt per attempted step', async () => {
    const ctx = makeCtx();
    const state = ctx.getState();
    state.symbol = 'AAPL';
    state.replayDate = '2026-07-10';
    state.sessionActive = true;
    state.isPlaying = true;
    const plan: AgentPlan = {
      id: 'plan-4',
      kind: 'action',
      summary: 'pause',
      steps: [{ id: makeStepId(0), capability: 'playback.pause', args: {}, required: true }],
    };
    const r = await executeAgentPlan(plan, ctx);
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0].planId).toBe('plan-4');
    expect(r.receipts[0].stepId).toBe(plan.steps[0].id);
    expect(typeof r.receipts[0].finalizedAt).toBe('number');
  });

  it('honours cancellation before a step runs', async () => {
    const ctx = makeCtx();
    const token = { cancelled: true, reason: 'user-cancel' };
    const plan = switchPlan('AAPL');
    const r = await executeAgentPlan(plan, ctx, token);
    expect(r.ok).toBe(false);
    expect(r.receipts.every((rc) => !rc.success && rc.errorCode === 'CANCELLED')).toBe(true);
  });

  it('sets finalWorldState after a mutating step', async () => {
    const ctx = makeCtx();
    const plan = switchPlan('ADBE');
    const r = await executeAgentPlan(plan, ctx);
    expect(r.ok).toBe(true);
    const world = r.finalWorldState as { session: { symbol: string } };
    expect(world.session.symbol).toBe('ADBE');
  });

  it('fails cleanly for unknown capabilities', async () => {
    const ctx = makeCtx();
    const plan: AgentPlan = {
      id: 'plan-5',
      kind: 'action',
      summary: 'bad plan',
      steps: [{ id: makeStepId(0), capability: 'not.real', args: {}, required: true }],
    };
    const r = await executeAgentPlan(plan, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('UNKNOWN_CAPABILITY');
  });

  it('does not infer success from requested state', async () => {
    const ctx = makeCtx({ onSwitchSymbol: vi.fn() });
    const state = ctx.getState();
    state.symbol = 'AAPL';
    state.replayDate = '2026-07-10';
    state.sessionActive = true;
    const plan = switchPlan('MSFT');
    const r = await executeAgentPlan(plan, ctx);
    // resolve should succeed, switch should fail because the bridge cannot confirm MSFT.
    expect(r.ok).toBe(false);
    expect(r.receipts[1].success).toBe(false);
  });
});

describe('capability registry', () => {
  it('registers all twelve V1 capabilities', () => {
    const caps = ['system.get_world_state', 'session.resolve_symbol', 'session.switch_symbol', 'session.switch_to_previous_symbol', 'session.resolve_trading_date', 'chart.set_timeframe', 'playback.seek_relative', 'playback.seek_to_time', 'playback.play_until', 'playback.pause', 'chart.get_current_candle', 'chart.get_candle_at_time'];
    for (const c of caps) {
      expect(getCapability(c), `missing: ${c}`).toBeDefined();
    }
  });
});
