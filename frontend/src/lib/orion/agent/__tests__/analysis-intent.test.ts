import { describe, it, expect, vi } from 'vitest';
import { validateSemanticIntent } from '../intent';
import { compileChartActionIntent, resolveContextReference } from '../intentCompiler';
import { sanitizeIntentGrounding } from '../orchestrator';
import { getRequestedDimensions, textRequestsAnalysis } from '../dimensions';
import { createExecutionContext } from '../executionContext';
import { parseChartCommand } from '../../planner';
import type { AgentContext, ChartActionIntent } from '../types';
import type { AppState } from '../../../../types';

function baseAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    symbol: 'AAPL',
    replayDate: '2026-07-10',
    sessionActive: true,
    isPlaying: false,
    speed: 1,
    timeframe: 5,
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
    ...overrides,
  } as unknown as AppState;
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
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
    onSwitchSymbol: vi.fn(),
    executionLog: createExecutionContext(),
    ...overrides,
  };
}

function recordAction(ctx: AgentContext, template: ChartActionIntent, after = { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false, replayTimestamp: 0 }) {
  ctx.executionLog.record({
    sequenceId: 0,
    timestamp: Date.now(),
    originalRequest: 'prior action',
    route: 'llm-plan',
    template,
    ok: true,
    receipts: [],
    before: { symbol: '', date: '', timeframe: 1, isPlaying: false },
    after,
    returnedCandles: [],
  });
}

describe('analysis request schema and validation', () => {
  it('accepts all six AnalysisRequest variants', () => {
    const raw = {
      kind: 'chart_action',
      analysisRequests: [
        { kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } },
        { kind: 'window_change', window: { kind: 'up_to_cursor' } },
        { kind: 'window_volume', window: { kind: 'whole_session' } },
        { kind: 'window_compare', left: { kind: 'time_range', fromTime: '09:30', toTime: '12:00' }, right: { kind: 'time_range', fromTime: '12:00', toTime: '16:00' } },
      ],
    };
    const r = validateSemanticIntent(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.analysisRequests).toHaveLength(4);
    expect(r.intent.analysisRequests!.some((req) => req.kind === 'window_compare')).toBe(true);
  });

  it('accepts candle_shape and window_summary', () => {
    const raw = {
      kind: 'chart_action',
      analysisRequests: [
        { kind: 'candle_shape', source: 'market_time', marketTime: '11:30' },
        { kind: 'window_summary', window: { kind: 'whole_session' } },
      ],
    };
    const r = validateSemanticIntent(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.analysisRequests).toHaveLength(2);
  });

  it('rejects computed numbers in analysisRequests as anti-hallucination', () => {
    const raw = {
      kind: 'chart_action',
      analysisRequests: [{ kind: 'window_ohlc', window: { kind: 'whole_session' }, open: 150, high: 155 }],
    };
    const r = validateSemanticIntent(raw);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Unknown field');
  });

  it('rejects more than four analysisRequests', () => {
    const raw = {
      kind: 'chart_action',
      analysisRequests: Array.from({ length: 5 }, () => ({ kind: 'window_ohlc', window: { kind: 'whole_session' } })),
    };
    const r = validateSemanticIntent(raw);
    expect(r.ok).toBe(false);
  });

  it('requires an actionable field even if analysisRequests is empty', () => {
    const raw = { kind: 'chart_action', analysisRequests: [] };
    const r = validateSemanticIntent(raw);
    expect(r.ok).toBe(false);
  });
});

describe('analysis request dimension detection', () => {
  it('detects analysis requests from natural, shorthand, mistyped and compound phrases', () => {
    const phrases = [
      'what was the range in the first hour',
      'how much did it move',
      'total volume this morning',
      'compare morning vs afternoon volume',
      'what kind of candle am i on rn',
      'how did AAPL do today',
      'range frst hour',
      'yo compare the first 30 mins to the last 30',
    ];
    for (const text of phrases) {
      const cmd = parseChartCommand(text, ['AAPL', 'MSFT', 'NVDA'], { aapl: 'AAPL' }, '2026-07-10');
      const dims = getRequestedDimensions(text, cmd, '2026-07-10');
      expect(dims.has('analysisRequest'), `expected analysisRequest for: ${text}`).toBe(true);
    }
  });

  it('does not label plain symbol/timeframe requests as analysis', () => {
    const text = 'switch to AAPL 5m';
    const cmd = parseChartCommand(text, ['AAPL', 'MSFT', 'NVDA'], { aapl: 'AAPL' }, '2026-07-10');
    const dims = getRequestedDimensions(text, cmd, '2026-07-10');
    expect(dims.has('analysisRequest')).toBe(false);
    expect(dims.has('symbol')).toBe(true);
    expect(dims.has('timeframe')).toBe(true);
  });
});

describe('compileChartActionIntent for analysis', () => {
  it('emits ordered read-only analysis capability steps', () => {
    const intent: ChartActionIntent = {
      kind: 'chart_action',
      analysisRequests: [
        { kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } },
        { kind: 'window_volume', window: { kind: 'whole_session' } },
      ],
    };
    const plan = compileChartActionIntent(intent);
    expect(plan.kind).toBe('query');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].capability).toBe('analysis.window_ohlc');
    expect(plan.steps[1].capability).toBe('analysis.window_volume');
    for (const step of plan.steps) {
      expect(step.required).toBe(false);
    }
  });

  it('deduplicates identical analysisRequests', () => {
    const window = { kind: 'time_range' as const, fromTime: '09:30', toTime: '10:30' };
    const intent: ChartActionIntent = {
      kind: 'chart_action',
      analysisRequests: [
        { kind: 'window_ohlc', window },
        { kind: 'window_ohlc', window },
        { kind: 'window_change', window },
      ],
    };
    const plan = compileChartActionIntent(intent);
    expect(plan.steps).toHaveLength(2);
  });

  it('defaults an omitted window to whole_session', () => {
    const intent: ChartActionIntent = {
      kind: 'chart_action',
      analysisRequests: [{ kind: 'window_summary' }],
    };
    const plan = compileChartActionIntent(intent);
    expect(plan.steps[0].capability).toBe('analysis.window_summary');
    expect(plan.steps[0].args).toEqual({ window: { kind: 'whole_session' } });
  });

  it('interleaves mutate steps before analysis when symbol/date are requested', () => {
    const intent: ChartActionIntent = {
      kind: 'chart_action',
      symbol: 'NVDA',
      date: { kind: 'absolute', value: '2026-07-10' },
      timeframeMinutes: 5,
      analysisRequests: [{ kind: 'window_change', window: { kind: 'up_to_cursor' } }],
    };
    const plan = compileChartActionIntent(intent, { stateSymbol: 'AAPL' });
    expect(plan.steps.some((s) => s.capability === 'session.switch_symbol')).toBe(true);
    expect(plan.steps.some((s) => s.capability === 'chart.set_timeframe')).toBe(true);
    const analysisStep = plan.steps.find((s) => s.capability === 'analysis.window_change');
    expect(analysisStep).toBeDefined();
    expect(analysisStep!.dependsOn).toBeDefined();
    const depId = analysisStep!.dependsOn![0];
    const depStep = plan.steps.find((s) => s.id === depId);
    expect(depStep).toBeDefined();
    expect(depStep!.capability).toMatch(/^(session\.|chart\.set_timeframe$)/);
  });
});

describe('resolveContextReference for analysis follow-ups', () => {
  it('repeats the previous analysis on a new symbol', () => {
    const ctx = makeContext();
    recordAction(ctx, {
      kind: 'chart_action',
      symbol: 'AAPL',
      analysisRequests: [{ kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }],
    });
    const r = resolveContextReference(
      { kind: 'chart_action', symbol: 'NVDA', contextReference: { source: 'latest_successful_action', mode: 'repeat' } },
      ctx
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.symbol).toBe('NVDA');
    expect(r.intent.analysisRequests).toEqual([{ kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }]);
  });

  it('"same thing but first hour" inherits the operation and overrides the window', () => {
    const ctx = makeContext();
    recordAction(ctx, {
      kind: 'chart_action',
      analysisRequests: [{ kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '16:00' } }],
    });
    const r = resolveContextReference(
      {
        kind: 'chart_action',
        contextReference: { source: 'latest_successful_action', mode: 'inherit', inherit: ['analysisRequests'] },
        analysisRequests: [{ kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }],
      },
      ctx
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.analysisRequests).toEqual([{ kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }]);
  });

  it('"what about volume?" inherits the previous window and changes the operation', () => {
    const ctx = makeContext();
    recordAction(ctx, {
      kind: 'chart_action',
      analysisRequests: [{ kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }],
    });
    const r = resolveContextReference(
      {
        kind: 'chart_action',
        contextReference: { source: 'latest_successful_action', mode: 'inherit', inherit: ['analysisRequests'] },
        analysisRequests: [{ kind: 'window_volume' }],
      },
      ctx
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.analysisRequests).toEqual([{ kind: 'window_volume', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }]);
  });

  it('"compare that with the last hour" uses the previous window as left and a new right', () => {
    const ctx = makeContext();
    recordAction(ctx, {
      kind: 'chart_action',
      analysisRequests: [{ kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }],
    });
    const r = resolveContextReference(
      {
        kind: 'chart_action',
        contextReference: { source: 'latest_successful_action', mode: 'inherit', inherit: ['analysisRequests'] },
        analysisRequests: [{ kind: 'window_compare', right: { kind: 'time_range', fromTime: '15:00', toTime: '16:00' } }],
      },
      ctx
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ar = r.intent.analysisRequests![0];
    expect(ar.kind).toBe('window_compare');
    expect(ar.left).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '10:30' });
    expect(ar.right).toEqual({ kind: 'time_range', fromTime: '15:00', toTime: '16:00' });
  });

  it('clarifies when a follow-up tries to inherit analysisRequests but the prior action has no analysis', () => {
    const ctx = makeContext();
    recordAction(ctx, { kind: 'chart_action', symbol: 'AAPL' });
    const r = resolveContextReference(
      {
        kind: 'chart_action',
        contextReference: { source: 'latest_successful_action', mode: 'inherit', inherit: ['analysisRequests'] },
        analysisRequests: [{ kind: 'window_ohlc' }],
      },
      ctx
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing a window and no prior analysis exists to inherit from/i);
  });
});

describe('sanitizeIntentGrounding for analysisRequests', () => {
  it('keeps analysisRequests when the text requests analysis', () => {
    const ctx = makeContext();
    const resolved: ChartActionIntent = {
      kind: 'chart_action',
      analysisRequests: [{ kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }],
    };
    const r = sanitizeIntentGrounding(resolved, 'what was the range in the first hour', undefined, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent!.analysisRequests).toHaveLength(1);
    }
  });

  it('strips analysisRequests when the text does not request analysis', () => {
    const ctx = makeContext();
    const resolved: ChartActionIntent = {
      kind: 'chart_action',
      analysisRequests: [{ kind: 'window_ohlc', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } }],
    };
    const r = sanitizeIntentGrounding(resolved, 'switch to AAPL', undefined, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent!.analysisRequests).toBeUndefined();
    }
  });
});
