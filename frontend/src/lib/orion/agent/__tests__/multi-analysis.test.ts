import { describe, it, expect, vi } from 'vitest';
import type { AppState, CandleData } from '../../../../types';
import type { AgentContext, AgentPlan, AgentStep } from '../types';
import { executeAgentPlan } from '../executor';
import { composeResponse } from '../orchestrator';
import { compileChartActionIntent } from '../intentCompiler';
import { createExecutionContext } from '../executionContext';
import { toEngineTs } from '../../planner';

vi.mock('../../tools', () => ({
  fetchCandles: vi.fn(async () => ({
    missing: true,
    reason: 'no data',
    candles: [],
  })),
}));

const FIXTURE_DATE = '2026-07-10';

function buildMinuteCandles(count: number, startHour = 9, startMinute = 30): CandleData[] {
  const start = toEngineTs(FIXTURE_DATE, startHour, startMinute);
  const candles: CandleData[] = [];
  for (let i = 0; i < count; i++) {
    const ts = start + i * 60;
    candles.push({
      timestamp: ts,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

function makeCtx(overrides: Partial<AgentContext> = {}, candles: CandleData[] = []): AgentContext {
  const state: AppState = {
    symbol: 'AAPL',
    replayDate: FIXTURE_DATE,
    sessionActive: true,
    isPlaying: false,
    speed: 1,
    timeframe: 1,
    cursor: 0,
    totalCandles: candles.length,
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

  return {
    getState: () => state,
    chartRef: {
      current: {
        getRecentCandles: (n: number) => candles.slice(-n),
      },
    } as unknown as AgentContext['chartRef'],
    performanceLog: {},
    apiBase: 'http://localhost:9000',
    dataDir: undefined,
    availableTickers: ['AAPL', 'MSFT', 'NVDA'],
    send: vi.fn(),
    dispatch: vi.fn(),
    onSwitchSymbol: async (symbol: string, date?: string) => {
      state.symbol = symbol;
      state.replayDate = date ?? state.replayDate;
      state.sessionActive = true;
    },
    executionLog: createExecutionContext(),
    ...overrides,
  };
}

function stepId(index: number): string {
  return `step-${index}`;
}

describe('multi-analysis execution and response composition', () => {
  it('executes three independent analysis steps with partial success', async () => {
    const candles = buildMinuteCandles(5);
    const ctx = makeCtx({}, candles);
    const plan: AgentPlan = {
      id: 'plan-partial',
      kind: 'query',
      summary: 'partial analysis',
      steps: [
        { id: stepId(0), capability: 'analysis.window_ohlc', args: { window: { kind: 'time_range', fromTime: '09:30', toTime: '10:00' } }, required: false, dependsOn: [] },
        { id: stepId(1), capability: 'analysis.window_change', args: { window: { kind: 'up_to_cursor' } }, required: false, dependsOn: [] },
        { id: stepId(2), capability: 'analysis.window_volume', args: { window: { kind: 'up_to_cursor' } }, required: false, dependsOn: [] },
      ],
    };

    const result = await executeAgentPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.receipts).toHaveLength(3);
    expect(result.receipts[0].success).toBe(false);
    expect(result.receipts[1].success).toBe(true);
    expect(result.receipts[2].success).toBe(true);
    expect(result.receipts[0].errorCode).toBe('NO_DATA_FOR_DATE');
    expect(result.receipts[1].capability).toBe('analysis.window_change');
    expect(result.receipts[2].capability).toBe('analysis.window_volume');

    const response = composeResponse(result, ctx);
    expect(response).toContain(result.receipts[1].message);
    expect(response).toContain(result.receipts[2].message);
    expect(response).toContain('window_ohlc failed:');
    expect(response).toContain(result.receipts[0].message);
    expect(response).not.toContain('undefined');
  });

  it('reports overall ok:false when all three optional analysis steps fail', async () => {
    const ctx = makeCtx({}, buildMinuteCandles(5));
    ctx.getState().sessionActive = false;

    const plan: AgentPlan = {
      id: 'plan-all-fail',
      kind: 'query',
      summary: 'all analyses fail',
      steps: [
        { id: stepId(0), capability: 'analysis.window_ohlc', args: { window: { kind: 'whole_session' } }, required: false, dependsOn: [] },
        { id: stepId(1), capability: 'analysis.window_change', args: { window: { kind: 'whole_session' } }, required: false, dependsOn: [] },
        { id: stepId(2), capability: 'analysis.window_volume', args: { window: { kind: 'whole_session' } }, required: false, dependsOn: [] },
      ],
    };

    const result = await executeAgentPlan(plan, ctx);

    expect(result.ok).toBe(false);
    expect(result.receipts).toHaveLength(3);
    expect(result.receipts.every((r) => !r.success)).toBe(true);
    expect(result.receipts.every((r) => r.errorCode === 'PRECONDITION_FAILED')).toBe(true);
    expect(result.errorCode).toBe('PRECONDITION_FAILED');

    const response = composeResponse(result, ctx);
    expect(response).toMatch(/No active session/i);
  });

  it('composes two successful analysis results into the final response', async () => {
    const candles = buildMinuteCandles(5);
    const ctx = makeCtx({}, candles);
    const plan: AgentPlan = {
      id: 'plan-two-success',
      kind: 'query',
      summary: 'two successes',
      steps: [
        { id: stepId(0), capability: 'analysis.window_change', args: { window: { kind: 'up_to_cursor' } }, required: false, dependsOn: [] },
        { id: stepId(1), capability: 'analysis.window_volume', args: { window: { kind: 'up_to_cursor' } }, required: false, dependsOn: [] },
      ],
    };

    const result = await executeAgentPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.receipts[0].success).toBe(true);
    expect(result.receipts[1].success).toBe(true);

    const response = composeResponse(result, ctx);
    expect(response).toContain(result.receipts[0].message);
    expect(response).toContain(result.receipts[1].message);
  });

  it('composes three successful analysis results into the final response', async () => {
    const candles = buildMinuteCandles(5);
    const ctx = makeCtx({}, candles);
    const plan: AgentPlan = {
      id: 'plan-three-success',
      kind: 'query',
      summary: 'three successes',
      steps: [
        { id: stepId(0), capability: 'analysis.window_ohlc', args: { window: { kind: 'up_to_cursor' } }, required: false, dependsOn: [] },
        { id: stepId(1), capability: 'analysis.window_change', args: { window: { kind: 'up_to_cursor' } }, required: false, dependsOn: [] },
        { id: stepId(2), capability: 'analysis.window_volume', args: { window: { kind: 'up_to_cursor' } }, required: false, dependsOn: [] },
      ],
    };

    const result = await executeAgentPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.receipts).toHaveLength(3);
    expect(result.receipts.every((r) => r.success)).toBe(true);

    const response = composeResponse(result, ctx);
    expect(response).toContain(result.receipts[0].message);
    expect(response).toContain(result.receipts[1].message);
    expect(response).toContain(result.receipts[2].message);
  });

  it('keeps skipped and failed wording distinct when a setup step fails', async () => {
    const ctx = makeCtx();
    const plan: AgentPlan = {
      id: 'plan-skipped-analysis',
      kind: 'query',
      summary: 'setup fails, analysis skipped',
      steps: [
        { id: stepId(0), capability: 'chart.set_timeframe', args: { timeframe: 0 }, required: true },
        { id: stepId(1), capability: 'analysis.window_ohlc', args: { window: { kind: 'up_to_cursor' } }, required: false, dependsOn: [stepId(0)] },
      ],
    };

    const result = await executeAgentPlan(plan, ctx);

    expect(result.ok).toBe(false);
    expect(result.receipts[0].success).toBe(false);
    expect(result.receipts[0].errorCode).toBe('INVALID_ARGUMENTS');
    expect(result.receipts[1].success).toBe(false);
    expect(result.receipts[1].errorCode).toBe('DEPENDENCY_FAILED');
    expect(result.receipts[1].message).toMatch(/Skipped/);
  });
});

describe('analysis step dependency graph', () => {
  it('produces analysis-only steps with no dependencies', () => {
    const intent = {
      kind: 'chart_action' as const,
      analysisRequests: [
        { kind: 'window_ohlc' as const, window: { kind: 'time_range' as const, fromTime: '09:30', toTime: '10:00' } },
        { kind: 'window_volume' as const },
        { kind: 'window_change' as const, window: { kind: 'whole_session' as const } },
      ],
    };
    const plan = compileChartActionIntent(intent);
    const analysisSteps = plan.steps.filter((s) => s.capability.startsWith('analysis.'));

    expect(analysisSteps).toHaveLength(3);
    for (const s of analysisSteps) {
      expect(s.required).toBe(false);
      expect(s.dependsOn).toEqual([]);
    }
    expect(new Set(analysisSteps.map((s) => s.id)).size).toBe(3);
  });

  it('produces setup -> parallel analysis fan-out with all analyses on the same last mutating step', () => {
    const intent = {
      kind: 'chart_action' as const,
      symbol: 'NVDA',
      date: { kind: 'absolute' as const, value: FIXTURE_DATE },
      timeframeMinutes: 5,
      analysisRequests: [
        { kind: 'window_ohlc' as const, window: { kind: 'time_range' as const, fromTime: '09:30', toTime: '10:00' } },
        { kind: 'window_volume' as const },
        { kind: 'window_change' as const, window: { kind: 'up_to_cursor' as const } },
      ],
    };
    const plan = compileChartActionIntent(intent, { stateSymbol: 'AAPL' });
    const mutatingSteps = plan.steps.filter((s) =>
      [
        'session.resolve_symbol',
        'session.switch_symbol',
        'session.switch_to_previous_symbol',
        'chart.set_timeframe',
      ].includes(s.capability)
    );
    const analysisSteps = plan.steps.filter((s) => s.capability.startsWith('analysis.'));

    expect(mutatingSteps.length).toBeGreaterThan(0);
    const lastMutating = mutatingSteps[mutatingSteps.length - 1];
    for (const s of analysisSteps) {
      expect(s.required).toBe(false);
      expect(s.dependsOn).toEqual([lastMutating.id]);
    }
    // Analyses must not depend on one another.
    for (const s of analysisSteps) {
      expect(analysisSteps.some((other) => other.id !== s.id && other.dependsOn?.includes(s.id))).toBe(false);
    }
  });

  it('skips all analyses when the final required setup step fails', async () => {
    const ctx = makeCtx();
    const plan = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'NVDA',
        date: { kind: 'absolute', value: FIXTURE_DATE },
        timeframeMinutes: 5,
        analysisRequests: [
          { kind: 'window_ohlc' as const, window: { kind: 'time_range', fromTime: '09:30', toTime: '10:00' } },
          { kind: 'window_volume' as const },
        ],
      },
      { stateSymbol: 'AAPL' }
    );

    const result = await executeAgentPlan(plan, ctx);

    expect(result.ok).toBe(false);
    const analysisReceipts = result.receipts.filter((r) => r.capability.startsWith('analysis.'));
    expect(analysisReceipts).toHaveLength(2);
    expect(analysisReceipts.every((r) => !r.success && r.errorCode === 'DEPENDENCY_FAILED')).toBe(true);
  });
});
