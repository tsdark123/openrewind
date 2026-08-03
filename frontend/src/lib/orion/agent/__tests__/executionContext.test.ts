import { describe, it, expect } from 'vitest';
import { createExecutionContext, buildCompactStateSnapshot, buildCandleSnapshot } from '../executionContext';
import type { ExecutionContextEntry } from '../types';

function fakeCandle(timestamp: number) {
  return {
    timestamp,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
  };
}

function makeEntry(template?: ExecutionContextEntry['template'], ok: boolean | undefined = true): ExecutionContextEntry {
  return {
    sequenceId: 0,
    timestamp: Date.now(),
    originalRequest: 'test',
    route: 'deterministic',
    template,
    ok,
    receipts: [],
    before: { symbol: 'AAPL', date: '2026-07-10', timeframe: 1, isPlaying: false },
    after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 1, isPlaying: false },
    returnedCandles: [],
  };
}

describe('ExecutionContext store', () => {
  it('records a turn and assigns a sequence id', () => {
    const log = createExecutionContext();
    log.record(makeEntry({ kind: 'chart_action', symbol: 'AAPL' }));
    const latest = log.latest();
    expect(latest?.sequenceId).toBe(1);
    expect(latest?.template?.symbol).toBe('AAPL');
  });

  it('resets and clears history', () => {
    const log = createExecutionContext();
    log.record(makeEntry());
    expect(log.getEntries()).toHaveLength(1);
    log.reset();
    expect(log.getEntries()).toHaveLength(0);
    expect(log.latest()).toBeUndefined();
  });

  it('keeps at most 15 entries', () => {
    const log = createExecutionContext();
    for (let i = 0; i < 20; i++) {
      log.record(makeEntry());
    }
    expect(log.getEntries()).toHaveLength(15);
    expect(log.latest()?.sequenceId).toBe(20);
  });

  it('finds latest successful and failed actions', () => {
    const log = createExecutionContext();
    log.record(makeEntry({ kind: 'chart_action', symbol: 'AAPL' }, true));
    log.record(makeEntry({ kind: 'chart_action', symbol: 'MSFT' }, false));
    log.record({ ...makeEntry(), route: 'chat', template: undefined, ok: undefined } as ExecutionContextEntry);
    expect(log.latestSuccessfulAction()?.template?.symbol).toBe('AAPL');
    expect(log.latestFailedAction()?.template?.symbol).toBe('MSFT');
  });

  it('reassigns snapshot ids when recording', () => {
    const log = createExecutionContext();
    const candle = buildCandleSnapshot(999, { symbol: 'AAPL', date: '2026-07-10', timeframe: 1 }, fakeCandle(1), 'current_candle');
    log.record({ ...makeEntry(), returnedCandles: [candle] });
    expect(log.latest()?.returnedCandles[0].snapshotId).toBe(1);
  });

  it('finds a matching candle', () => {
    const log = createExecutionContext();
    const c1 = buildCandleSnapshot(0, { symbol: 'AAPL', date: '2026-07-10', timeframe: 1 }, fakeCandle(100), 'current_candle');
    const c2 = buildCandleSnapshot(0, { symbol: 'AAPL', date: '2026-07-10', timeframe: 1 }, fakeCandle(200), 'current_candle');
    log.record({ ...makeEntry(), returnedCandles: [c1] });
    log.record({ ...makeEntry(), returnedCandles: [c2] });
    const found = log.findCandle({ symbol: 'AAPL', date: '2026-07-10', timeframe: 1, timestamp: 100 });
    expect(found).toBeDefined();
    expect(found?.timestamp).toBe(100);
  });

  it('renders a compact prompt', () => {
    const log = createExecutionContext();
    log.record(makeEntry({ kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5, seekTime: '11:15' }, true));
    const prompt = log.renderForPrompt({ maxActions: 3, includeCandles: false });
    expect(prompt).toMatch(/AAPL/);
    expect(prompt).toMatch(/11:15/);
    expect(prompt).toMatch(/success/);
  });

  it('records a non-replayable UI reset entry without a template', () => {
    const log = createExecutionContext();
    log.record(makeEntry({ kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 }, true));
    log.record({
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
    expect(log.latest()?.route).toBe('ui-action');
    expect(log.latest()?.template).toBeUndefined();
    expect(log.latestSuccessfulAction()?.template?.symbol).toBe('AAPL');
  });

  it('does not erase earlier successful Orion memory when a reset is recorded', () => {
    const log = createExecutionContext();
    log.record(makeEntry({ kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 }, true));
    log.record({
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
    expect(log.latestSuccessfulAction()?.template).toEqual({ kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 });
  });
});

describe('buildCompactStateSnapshot', () => {
  it('extracts replay time from a chart candle', () => {
    const state = {
      symbol: 'AAPL',
      replayDate: '2026-07-10',
      timeframe: 5,
      isPlaying: true,
      sessionActive: true,
    } as unknown as import('../../../types').AppState;

    const chartRef = {
      current: {
        getRecentCandles: () => [fakeCandle(1755037500)],
      },
    };

    const snapshot = buildCompactStateSnapshot(state, chartRef as unknown as import('react').RefObject<import('../../components/Chart').ChartHandle>);
    expect(snapshot.symbol).toBe('AAPL');
    expect(snapshot.date).toBe('2026-07-10');
    expect(snapshot.timeframe).toBe(5);
    expect(snapshot.replayTime).toBeTruthy();
  });

  it('falls back to state when the chart has no candle', () => {
    const state = {
      symbol: 'AAPL',
      replayDate: '2026-07-10',
      timeframe: 5,
      isPlaying: true,
    } as unknown as import('../../../types').AppState;

    const snapshot = buildCompactStateSnapshot(state, { current: null });
    expect(snapshot.replayTime).toBeUndefined();
  });
});
