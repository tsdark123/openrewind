import { describe, it, expect, vi } from 'vitest';
import type { AppState } from '../../../../types';
import type { AgentContext } from '../types';
import { handleOrionMessage, sanitizeIntentGrounding } from '../orchestrator';
import { createExecutionContext } from '../executionContext';

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

describe('handleOrionMessage routing', () => {
  it('keeps AAPL on the deterministic fast path', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Switch to AAPL.', ctx, setupReady: false });
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(r.plan?.steps[0].capability).toBe('session.switch_symbol');
    expect(ctx.getState().symbol).toBe('AAPL');
  });

  it('keeps pause on the deterministic fast path', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';
    ctx.getState().isPlaying = true;
    const r = await handleOrionMessage({ text: 'Pause.', ctx, setupReady: false });
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(r.plan?.steps[0].capability).toBe('playback.pause');
    expect(ctx.getState().isPlaying).toBe(false);
  });

  it('keeps play at 10x on the deterministic fast path', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';
    const r = await handleOrionMessage({ text: 'Play at 10x.', ctx, setupReady: false });
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(r.plan?.steps[0].capability).toBe('playback.play_until');
    expect(ctx.getState().isPlaying).toBe(true);
    expect(ctx.getState().speed).toBe(10);
  });

  it('resolves Adobe stock deterministically from the parser', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Switch to Adobe stock.', ctx, setupReady: false });
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('deterministic');
    expect(r.ok).toBe(true);
    expect(ctx.getState().symbol).toBe('ADBE');
  });
});

describe('handleOrionMessage symbol resolution', () => {
  it('routes unresolved switch text through session.resolve_symbol', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Switch to ZOOM.', ctx, setupReady: false });
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('resolve');
    expect(r.ok).toBe(false);
    expect(r.plan?.steps[0].capability).toBe('session.resolve_symbol');
    expect(r.result?.receipts[0].capability).toBe('session.resolve_symbol');
    const rc1 = r.result?.receipts[0];
    if (rc1 && !rc1.success) expect(rc1.errorCode).toBe('SYMBOL_UNAVAILABLE');
    expect(ctx.getState().symbol).toBe('');
  });

  it('produces SYMBOL_UNAVAILABLE for an unavailable raw ticker and keeps the prior session', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;
    const r = await handleOrionMessage({ text: 'Switch to ZZZZ.', ctx, setupReady: false });
    expect(r.wasChat).toBe(false);
    expect(r.route).toBe('resolve');
    expect(r.ok).toBe(false);
    const rc2 = r.result?.receipts[0];
    if (rc2 && !rc2.success) expect(rc2.errorCode).toBe('SYMBOL_UNAVAILABLE');
    expect(ctx.getState().symbol).toBe('AAPL');
    const world = r.result?.finalWorldState as { session: { symbol: string } };
    expect(world.session.symbol).toBe('AAPL');
  });

  it('does not optimistically switch after a failed bridge', async () => {
    const ctx = makeCtx({ onSwitchSymbol: vi.fn() });
    const r = await handleOrionMessage({ text: 'Switch to AAPL.', ctx, setupReady: false });
    expect(r.wasChat).toBe(false);
    expect(r.ok).toBe(false);
    expect(ctx.getState().symbol).toBe('');
  });
});

describe('handleOrionMessage conversation', () => {
  it('routes "um?" to a natural offline response with no symbol error', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'um?', ctx, setupReady: false });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('chat');
    expect(r.ok).toBe(true);
    expect(r.plan).toBeUndefined();
    expect(r.result).toBeUndefined();
    expect(r.message).not.toMatch(/symbol|ticker|chart|switch|pause|play|AAPL|ADBE|MSFT/i);
    expect(r.message.toLowerCase()).toMatch(/what.*up|yes/);
  });

  it('routes "what happened?" to conversation and not a chart command error', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;
    const r = await handleOrionMessage({ text: 'what happened?', ctx, setupReady: false });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('chat');
    expect(r.ok).toBe(true);
    expect(r.plan).toBeUndefined();
    expect(r.result).toBeUndefined();
    expect(r.message).not.toMatch(/not.*available|couldn.?t understand|symbol not recognized|missing ticker|malformed chart command/i);
  });

  it('routes "are you sure?" to conversation', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'are you sure?', ctx, setupReady: false });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('chat');
  });

  it('routes "huh?" to conversation', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'huh?', ctx, setupReady: false });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('chat');
    expect(r.message).not.toMatch(/symbol|ticker/i);
  });

  it('mentions a toolbar reset in "what action did you just perform?" with no LLM call', async () => {
    const ctx = makeCtx();
    ctx.executionLog.record({
      sequenceId: 0,
      timestamp: Date.now(),
      originalRequest: 'Switch to AAPL 5m.',
      route: 'deterministic',
      template: { kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 },
      ok: true,
      planSummary: 'Switch to AAPL 5m',
      before: { symbol: '', date: '', timeframe: 1, isPlaying: false },
      after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
      receipts: [
        { planId: 'p', stepId: 's', capability: 'session.switch_symbol', success: true, message: 'Switched to AAPL.', finalizedAt: Date.now() },
        { planId: 'p', stepId: 't', capability: 'chart.set_timeframe', success: true, message: 'Timeframe set to 5m.', finalizedAt: Date.now() },
      ],
      returnedCandles: [],
    });
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

    const r = await handleOrionMessage({ text: 'What action did you just perform?', ctx, setupReady: false });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('recent-action-summary');
    expect(r.plan).toBeUndefined();
    expect(r.message).toMatch(/reset/i);
    expect(r.message).toMatch(/Switch to AAPL/);
  });

  it('routes "what action did u just perform" to recent-action-summary with no LLM call', async () => {
    const ctx = makeCtx();
    ctx.executionLog.record({
      originalRequest: 'Switch to AAPL 5m.',
      route: 'deterministic',
      ok: true,
      planSummary: 'Switch to AAPL 5m.',
      template: { kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 },
      before: { symbol: '', date: '', timeframe: 1, isPlaying: false },
      after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
      receipts: [
        { planId: 'p', stepId: 's', capability: 'session.switch_symbol', success: true, message: 'Switched to AAPL.', finalizedAt: Date.now() },
        { planId: 'p', stepId: 't', capability: 'chart.set_timeframe', success: true, message: 'Timeframe set to 5m.', finalizedAt: Date.now() },
      ],
      returnedCandles: [],
    });

    const r = await handleOrionMessage({ text: "what action did u just perform", ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('recent-action-summary');
    expect(r.message).toMatch(/Switch to AAPL/);
    // No LLM call made because setupReady could trigger chat normally, but this
    // route does not use the model.
    expect(r.message).not.toMatch(/ollama|ollama/i);
  });

  it('routes "what did you just do" to recent-action-summary and rejects "what did you do yesterday"', async () => {
    const ctx = makeCtx();
    ctx.executionLog.record({
      originalRequest: 'Switch to AAPL.',
      route: 'deterministic',
      ok: true,
      planSummary: 'Switch to AAPL.',
      template: { kind: 'chart_action', symbol: 'AAPL' },
      before: { symbol: '', date: '', timeframe: 1, isPlaying: false },
      after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 1, isPlaying: false },
      receipts: [{ planId: 'p', stepId: 's', capability: 'session.switch_symbol', success: true, message: 'Switched to AAPL.', finalizedAt: Date.now() }],
      returnedCandles: [],
    });

    const r1 = await handleOrionMessage({ text: 'what did you just do', ctx, setupReady: true });
    expect(r1.wasChat).toBe(true);
    expect(r1.route).toBe('recent-action-summary');
    expect(r1.message).toMatch(/Switch to AAPL/);

    // Historical questions should not be matched as recent-action queries.
    const r2 = await handleOrionMessage({ text: 'what did you do yesterday', ctx, setupReady: false });
    expect(r2.message).not.toMatch(/Switch to AAPL/);
  });
});

describe('handleOrionMessage canonical repeat', () => {
  it('replays the latest successful action deterministically', async () => {
    const ctx = makeCtx();
    ctx.executionLog.record({
      originalRequest: 'Switch to AAPL 5m.',
      route: 'deterministic',
      ok: true,
      planSummary: 'Switch to AAPL 5m.',
      template: { kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 },
      before: { symbol: '', date: '', timeframe: 1, isPlaying: false },
      after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
      receipts: [
        { planId: 'p', stepId: 's', capability: 'session.switch_symbol', success: true, message: 'Switched to AAPL.', finalizedAt: Date.now() },
        { planId: 'p', stepId: 't', capability: 'chart.set_timeframe', success: true, message: 'Timeframe set to 5m.', finalizedAt: Date.now() },
      ],
      returnedCandles: [],
    });

    const r = await handleOrionMessage({ text: 'Do that again.', ctx, setupReady: true });
    expect(r.route).toBe('deterministic');
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.resolve_symbol',
      'session.switch_symbol',
      'chart.set_timeframe',
    ]);
    expect(r.result?.receipts.some((rc) => rc.capability === 'session.switch_symbol' && rc.success)).toBe(true);
    expect(ctx.getState().symbol).toBe('AAPL');
  });

  it('skips a non-replayable reset and replays the prior action', async () => {
    const ctx = makeCtx();
    ctx.executionLog.record({
      originalRequest: 'Switch to AAPL 5m.',
      route: 'deterministic',
      ok: true,
      planSummary: 'Switch to AAPL 5m.',
      template: { kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 5 },
      before: { symbol: '', date: '', timeframe: 1, isPlaying: false },
      after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
      receipts: [
        { planId: 'p', stepId: 's', capability: 'session.switch_symbol', success: true, message: 'Switched to AAPL.', finalizedAt: Date.now() },
        { planId: 'p', stepId: 't', capability: 'chart.set_timeframe', success: true, message: 'Timeframe set to 5m.', finalizedAt: Date.now() },
      ],
      returnedCandles: [],
    });
    ctx.executionLog.record({
      originalRequest: 'chart_reset',
      route: 'ui-action',
      actionKind: 'chart_reset',
      ok: true,
      planSummary: 'Chart reset',
      before: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
      after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 5, isPlaying: false },
      receipts: [],
      returnedCandles: [],
    });

    const r = await handleOrionMessage({ text: 'Do that again.', ctx, setupReady: true });
    expect(r.route).toBe('deterministic');
    expect(r.plan?.steps.map((s) => s.capability)).toEqual([
      'session.resolve_symbol',
      'session.switch_symbol',
      'chart.set_timeframe',
    ]);
    expect(r.result?.receipts.some((rc) => rc.capability === 'session.switch_symbol' && rc.success)).toBe(true);
    expect(ctx.getState().symbol).toBe('AAPL');
  });

  it('clarifies when there is no replayable action', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Do that again.', ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('clarification');
    expect(r.message).toMatch(/no replayable action/i);
  });

  it('records each turn exactly once', async () => {
    const ctx = makeCtx();
    ctx.executionLog.record({
      originalRequest: 'Switch to AAPL.',
      route: 'deterministic',
      ok: true,
      planSummary: 'Switch to AAPL.',
      template: { kind: 'chart_action', symbol: 'AAPL' },
      before: { symbol: '', date: '', timeframe: 1, isPlaying: false },
      after: { symbol: 'AAPL', date: '2026-07-10', timeframe: 1, isPlaying: false },
      receipts: [{ planId: 'p', stepId: 's', capability: 'session.switch_symbol', success: true, message: 'Switched to AAPL.', finalizedAt: Date.now() }],
      returnedCandles: [],
    });

    const before = ctx.executionLog.getEntries().length;
    await handleOrionMessage({ text: 'Do that again.', ctx, setupReady: true });
    const after = ctx.executionLog.getEntries().length;
    expect(after).toBe(before + 1);
  });
});

describe('sanitizeIntentGrounding stale date/timeframe stripping', () => {
  it('strips a date/timeframe that matches the active session on a symbol switch', () => {
    const ctx = makeCtx();
    const state = ctx.getState();
    state.symbol = 'AAPL';
    state.replayDate = '2026-07-10';
    state.timeframe = 1;

    const resolved: any = {
      kind: 'chart_action',
      symbol: 'NVDA',
      date: { kind: 'absolute', value: '2026-07-10' },
      timeframeMinutes: 1,
    };
    const r = sanitizeIntentGrounding(
      resolved,
      'switch to NVDA',
      { source: 'latest_successful_action', mode: 'inherit', inherit: ['date', 'timeframe'] },
      ctx
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent!.symbol).toBe('NVDA');
    expect(r.intent!.date).toBeUndefined();
    expect(r.intent!.timeframeMinutes).toBeUndefined();
  });

  it('keeps a date that differs from the active session date', () => {
    const ctx = makeCtx();
    const state = ctx.getState();
    state.symbol = 'AAPL';
    state.replayDate = '2026-07-10';
    state.timeframe = 1;

    const resolved: any = {
      kind: 'chart_action',
      symbol: 'NVDA',
      date: { kind: 'absolute', value: '2026-07-09' },
      timeframeMinutes: 1,
    };
    const r = sanitizeIntentGrounding(
      resolved,
      'switch to NVDA',
      { source: 'latest_successful_action', mode: 'inherit', inherit: ['date', 'timeframe'] },
      ctx
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent!.symbol).toBe('NVDA');
    expect(r.intent!.date).toEqual({ kind: 'absolute', value: '2026-07-09' });
    expect(r.intent!.timeframeMinutes).toBeUndefined();
  });
});
