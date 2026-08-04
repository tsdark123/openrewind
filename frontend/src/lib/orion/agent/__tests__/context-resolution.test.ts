import { describe, it, expect, vi } from 'vitest';
import { resolveContextReference, compileChartActionIntent } from '../intentCompiler';
import { createExecutionContext } from '../executionContext';
import type { AgentContext, ExecutionContextEntry, ChartActionIntent } from '../types';
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

function makeEntry(template: ChartActionIntent, ok: boolean, afterDate = '2026-07-10'): ExecutionContextEntry {
  return {
    sequenceId: 0,
    timestamp: Date.now(),
    originalRequest: 'switch to AAPL 5m',
    route: ok ? 'deterministic' : 'resolve',
    template,
    ok,
    receipts: [],
    before: { symbol: '', date: '', timeframe: 1, isPlaying: false },
    after: { symbol: 'AAPL', date: afterDate, timeframe: 5, isPlaying: false },
    returnedCandles: [],
  };
}

describe('resolveContextReference', () => {
  it('returns the same intent when no contextReference is present', () => {
    const ctx = makeContext();
    const intent: ChartActionIntent = { kind: 'chart_action', symbol: 'MSFT' };
    const r = resolveContextReference(intent, ctx);
    expect(r.ok).toBe(true);
    expect(r.intent).toEqual({ kind: 'chart_action', symbol: 'MSFT' });
  });

  it('repeats the previous successful action', () => {
    const ctx = makeContext();
    ctx.executionLog.record(makeEntry({ kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 }, true));
    const r = resolveContextReference({ kind: 'chart_action', contextReference: { source: 'latest_successful_action', mode: 'repeat' } }, ctx);
    expect(r.ok).toBe(true);
    expect(r.intent).toEqual({ kind: 'chart_action', symbol: 'AAPL', date: { kind: 'absolute', value: '2026-07-10' }, timeframeMinutes: 5 });
  });

  it('inherits only the requested fields', () => {
    const ctx = makeContext();
    ctx.executionLog.record(makeEntry({ kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5, seekTime: '11:15' }, true));
    const r = resolveContextReference(
      {
        kind: 'chart_action',
        symbol: 'NVDA',
        contextReference: { source: 'latest_successful_action', mode: 'inherit', inherit: ['timeframe', 'seekTime'] },
      },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(r.intent).toEqual({ kind: 'chart_action', symbol: 'NVDA', timeframeMinutes: 5, seekTime: '11:15' });
  });

  it('fails to repeat when there is no prior successful action', () => {
    const ctx = makeContext();
    const r = resolveContextReference({ kind: 'chart_action', contextReference: { source: 'latest_successful_action', mode: 'repeat' } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No prior successful action/);
  });

  it('repeats playback action with symbol override and preserves speed/untilTime', () => {
    const ctx = makeContext();
    ctx.executionLog.record(
      makeEntry(
        {
          kind: 'chart_action',
          symbol: 'AAPL',
          playback: { action: 'play_until', speed: 4, untilTime: '15:45', direction: 'forward' },
        },
        true
      )
    );
    const r = resolveContextReference(
      {
        kind: 'chart_action',
        symbol: 'NVDA',
        contextReference: { source: 'latest_successful_action', mode: 'repeat' },
      },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(r.intent.symbol).toBe('NVDA');
    expect(r.intent.playback).toEqual({
      action: 'play_until',
      speed: 4,
      untilTime: '15:45',
      direction: 'forward',
    });
  });

  it('repeats playback action and fills missing subfields from the prior action', () => {
    const ctx = makeContext();
    ctx.executionLog.record(
      makeEntry(
        {
          kind: 'chart_action',
          symbol: 'AAPL',
          playback: { action: 'play_until', speed: 4, untilTime: '15:45' },
        },
        true
      )
    );
    const r = resolveContextReference(
      {
        kind: 'chart_action',
        symbol: 'NVDA',
        playback: { action: 'play_until' },
        contextReference: { source: 'latest_successful_action', mode: 'repeat' },
      },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(r.intent.playback).toEqual({
      action: 'play_until',
      speed: 4,
      untilTime: '15:45',
    });
  });

  it('rejects repeat of a failed action', () => {
    const ctx = makeContext();
    ctx.executionLog.record(makeEntry({ kind: 'chart_action', symbol: 'ZZZZ' }, false));
    const r = resolveContextReference({ kind: 'chart_action', contextReference: { source: 'latest_successful_action', mode: 'repeat' } }, ctx);
    expect(r.ok).toBe(false);
  });

  it('anchors a relative date to the previous action resolved date', () => {
    const ctx = makeContext();
    ctx.executionLog.record(makeEntry({ kind: 'chart_action', symbol: 'AAPL' }, true, '2026-07-10'));
    const r = resolveContextReference(
      {
        kind: 'chart_action',
        symbol: 'MSFT',
        date: { kind: 'relative_trading', count: 1, direction: 'backward' },
        contextReference: { source: 'latest_successful_action', mode: 'anchor_relative_date' },
      },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(r.anchorDate).toBe('2026-07-10');
  });

  it('resolves latest_returned_candle to use as target', () => {
    const ctx = makeContext();
    const log = ctx.executionLog;
    log.record({
      ...makeEntry({ kind: 'chart_action', symbol: 'AAPL', finalQuery: 'current_candle' }, true),
      returnedCandles: [
        {
          snapshotId: 1,
          symbol: 'AAPL',
          date: '2026-07-10',
          timeframe: 5,
          marketTime: '11:15',
          timestamp: 1755037500,
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 1000,
          source: 'current_candle',
        },
      ],
    });

    const r = resolveContextReference(
      {
        kind: 'chart_action',
        contextReference: { source: 'latest_returned_candle', mode: 'use_as_target' },
      },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(r.intent.seekTime).toBe('11:15');
    expect(r.resolvedCandle?.marketTime).toBe('11:15');
  });

  it('prepares compare_candles with explicit left and right snapshots', () => {
    const ctx = makeContext();
    const log = ctx.executionLog;
    const earlier = {
      snapshotId: 1,
      symbol: 'AAPL',
      date: '2026-07-10',
      timeframe: 5,
      marketTime: '11:00',
      timestamp: 1755037500,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000,
      source: 'candle_at_time' as const,
    };
    const later = {
      snapshotId: 2,
      symbol: 'AAPL',
      date: '2026-07-10',
      timeframe: 5,
      marketTime: '11:30',
      timestamp: 1755038100,
      open: 110,
      high: 111,
      low: 109,
      close: 110.5,
      volume: 1200,
      source: 'candle_at_time' as const,
    };
    log.record({ ...makeEntry({ kind: 'chart_action', symbol: 'AAPL', finalQuery: 'candle_at_time' }, true), returnedCandles: [earlier] });
    log.record({ ...makeEntry({ kind: 'chart_action', symbol: 'AAPL', finalQuery: 'candle_at_time' }, true), returnedCandles: [later] });

    const r = resolveContextReference(
      {
        kind: 'chart_action',
        finalQuery: 'compare_candles',
        compare: { left: { source: 'latest_returned_candle' }, right: { source: 'previous_returned_candle' } },
      },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(r.intent.seekTime).toBeUndefined();
    expect(r.resolvedCompare).toBeDefined();
    expect(r.resolvedCompare?.left.marketTime).toBe('11:30');
    expect(r.resolvedCompare?.right.marketTime).toBe('11:00');

    const plan = compileChartActionIntent(r.intent, {
      resolvedCompare: r.resolvedCompare,
      anchorDate: '2026-07-10',
    });
    const compare = plan.steps.find((s) => s.capability === 'analysis.compare_candles');
    expect(compare).toBeDefined();
    expect(compare?.args).toMatchObject({
      left: { source: 'snapshot', snapshotId: 2, marketTime: '11:30' },
      right: { source: 'snapshot', snapshotId: 1, marketTime: '11:00' },
    });
  });

  it('"do that again" after a toolbar reset repeats the latest replayable action, not the reset', () => {
    const ctx = makeContext();
    const prior = makeEntry({ kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 }, true);
    ctx.executionLog.record(prior);
    ctx.executionLog.record({
      sequenceId: 0,
      timestamp: Date.now(),
      originalRequest: 'Reset',
      route: 'ui-action',
      actionKind: 'chart_reset',
      ok: true,
      planSummary: 'Chart reset',
      before: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
      after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
      receipts: [],
      returnedCandles: [],
    });

    const r = resolveContextReference(
      { kind: 'chart_action', contextReference: { source: 'latest_successful_action', mode: 'repeat' } },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(r.intent).toMatchObject({ kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 });
  });
});
