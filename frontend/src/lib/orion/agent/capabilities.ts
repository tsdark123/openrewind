// =============================================================================
// Agent capability registry — V1.
//
// This file is a thin semantic adapter. Each capability delegates to an
// existing, trusted operation and returns a typed ExecutionReceipt. It does
// NOT reimplement session creation, symbol switching, date probing, or
// timeframe/playback logic. It reuses:
//
//   - App.tsx `handleSymbolChange`      -> session.switch_symbol
//   - existing reducer / WebSocket      -> chart.set_timeframe, playback.*
//   - buildWorldState                   -> system.get_world_state
//   - resolveSymbol                     -> session.resolve_symbol
//   - resolveTradingDate (+ fetchCandles) -> session.resolve_trading_date
//   - ChartHandle.getRecentCandles      -> chart.get_current_candle
//
// Capabilities that cannot be safely connected in Phase 2 are registered
// explicitly and return PRECONDITION_FAILED / NOT_IMPLEMENTED receipts.
// =============================================================================

import type { AgentStep, ExecutionReceipt, AgentContext, CancellationToken } from './types';
import { successReceipt, failureReceipt } from './receipts';
import { buildWorldState } from '../worldState';
import { resolveSymbol } from './resolveSymbol';
import { resolveTradingDate } from './resolveTradingDate';
import { fetchCandles } from '../tools';
import { clampTimeframe } from '../planner';

// ---------------------------------------------------------------------------
// Capability definition shape
// ---------------------------------------------------------------------------

export type CapabilityKind = 'read' | 'mutate';

export interface CapabilitySchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface CapabilityDefinition {
  name: string;
  kind: CapabilityKind;
  description: string;
  /** Human-readable preconditions for the LLM catalog. */
  preconditions: string[];
  /** Schema hint for the LLM. */
  argSchema: CapabilitySchema;
  /** Which existing function or bridge the capability wraps. */
  delegatesTo: string;
  execute: (
    planId: string,
    step: AgentStep,
    ctx: AgentContext,
    token?: CancellationToken
  ) => Promise<ExecutionReceipt>;
}

const registry = new Map<string, CapabilityDefinition>();

export function registerCapability(cap: CapabilityDefinition): void {
  registry.set(cap.name, cap);
}

export function getCapability(name: string): CapabilityDefinition | undefined {
  return registry.get(name);
}

export function listCapabilities(): CapabilityDefinition[] {
  return Array.from(registry.values());
}

export function capabilitySchemasForPrompt(): Array<Record<string, unknown>> {
  return listCapabilities().map((c) => ({
    type: 'function',
    function: {
      name: c.name,
      description: c.description,
      parameters: c.argSchema,
    },
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wasCancelled(planId: string, step: AgentStep, token?: CancellationToken): ExecutionReceipt | null {
  if (!token?.cancelled) return null;
  return failureReceipt(planId, step, 'CANCELLED', 'Plan was cancelled.');
}

async function waitForState(
  ctx: AgentContext,
  predicate: (s: ReturnType<AgentContext['getState']>) => boolean,
  timeoutMs = 8000,
  intervalMs = 80
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(ctx.getState())) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function currentSessionSymbol(ctx: AgentContext): string | undefined {
  return ctx.getState().sessionActive ? ctx.getState().symbol : undefined;
}

// ---------------------------------------------------------------------------
// 1. system.get_world_state
// ---------------------------------------------------------------------------

registerCapability({
  name: 'system.get_world_state',
  kind: 'read',
  description: 'Returns a compact canonical snapshot of current OpenRewind state.',
  preconditions: ['None — always available.'],
  argSchema: { type: 'object', properties: {} },
  delegatesTo: 'buildWorldState(state, chartRef, performanceLog)',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;
    const world = buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog);
    return successReceipt(planId, step, 'WorldState captured.', { world }, [
      { key: 'worldState', before: null, after: world.builtAt },
    ]);
  },
});

// ---------------------------------------------------------------------------
// 2. session.resolve_symbol
// ---------------------------------------------------------------------------

registerCapability({
  name: 'session.resolve_symbol',
  kind: 'read',
  description: 'Resolve a company name or nickname to a ticker in the available dataset.',
  preconditions: ['availableTickers must be loaded.'],
  argSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  delegatesTo: 'resolveSymbol(name, { availableTickers })',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;
    const name = String(step.args.name ?? '');
    if (!name) {
      return failureReceipt(planId, step, 'INVALID_ARGUMENTS', 'No name provided for symbol resolution.');
    }
    const r = resolveSymbol(name, { availableTickers: ctx.availableTickers });
    if (r.ok) {
      return successReceipt(planId, step, `Resolved ${r.matchedTerm} to ${r.symbol}.`, {
        symbol: r.symbol,
        matchedTerm: r.matchedTerm,
        matchKind: r.matchKind,
        confidence: r.confidence,
      });
    }
    if (r.matchKind === 'ambiguous') {
      return failureReceipt(planId, step, 'SYMBOL_AMBIGUOUS', r.message, {
        candidates: r.candidates,
        needsClarification: r.needsClarification,
      });
    }
    if (r.matchKind === 'unavailable_alias') {
      return failureReceipt(planId, step, 'SYMBOL_UNAVAILABLE', r.message, {
        resolvedTicker: r.resolvedTicker,
      });
    }
    // Ticker-shaped unknown candidates get a concise unavailable message;
    // company-name/phrase fallbacks use the generic matcher wording.
    const query = name.trim();
    if (/^[A-Z0-9-]{1,8}$/.test(query)) {
      return failureReceipt(planId, step, 'SYMBOL_UNAVAILABLE', `${query} isn't available in the current OpenRewind dataset.`);
    }
    return failureReceipt(planId, step, 'SYMBOL_UNAVAILABLE', `No known ticker or company name matched "${query}".`);
  },
});

// ---------------------------------------------------------------------------
// 3. session.switch_symbol
// ---------------------------------------------------------------------------

registerCapability({
  name: 'session.switch_symbol',
  kind: 'mutate',
  description: 'Switch the active replay session to a symbol and optional date, waiting for the chart to confirm.',
  preconditions: ['Engine connected.', 'Symbol must be in availableTickers.', 'onSwitchSymbol bridge must be wired.'],
  argSchema: {
    type: 'object',
    properties: { symbol: { type: 'string' }, date: { type: 'string' } },
    required: ['symbol'],
  },
  delegatesTo: 'App.tsx handleSymbolChange -> POST /api/session/start',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    const symbol = String(step.args.symbol ?? '').toUpperCase();
    const date = step.args.date ? String(step.args.date) : undefined;
    if (!symbol) {
      return failureReceipt(planId, step, 'INVALID_ARGUMENTS', 'No symbol provided for session.switch_symbol.');
    }
    if (!ctx.availableTickers.includes(symbol)) {
      return failureReceipt(planId, step, 'SYMBOL_UNAVAILABLE', `No data is available for ${symbol}.`);
    }
    if (!ctx.onSwitchSymbol) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'Symbol-switch bridge is not wired.');
    }

    const before = ctx.getState();
    try {
      await Promise.resolve(ctx.onSwitchSymbol(symbol, date));
    } catch (e) {
      return failureReceipt(planId, step, 'ENGINE_ERROR', `Switch to ${symbol} threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (token?.cancelled) {
      return wasCancelled(planId, step, token)!;
    }

    const ok = await waitForState(ctx, (s) => s.symbol === symbol && s.sessionActive, 3000, 80);
    if (!ok) {
      const after = ctx.getState();
      const stillOn = after.sessionActive ? `${after.symbol} ${after.replayDate}` : 'no active session';
      return failureReceipt(
        planId,
        step,
        'ACKNOWLEDGMENT_TIMEOUT',
        `Switched to ${symbol}, but the session did not confirm in time. Still on ${stillOn}.`,
        { requestedSymbol: symbol, actualSymbol: after.symbol }
      );
    }

    const after = ctx.getState();
    return successReceipt(
      planId,
      step,
      `Switched to ${after.symbol} on ${after.replayDate}.`,
      { symbol: after.symbol, date: after.replayDate, totalCandles: after.totalCandles },
      [
        { key: 'symbol', before: before.symbol, after: after.symbol },
        { key: 'date', before: before.replayDate, after: after.replayDate },
      ].filter((sc) => sc.before !== sc.after)
    );
  },
});

// ---------------------------------------------------------------------------
// 4. session.switch_to_previous_symbol
// ---------------------------------------------------------------------------

registerCapability({
  name: 'session.switch_to_previous_symbol',
  kind: 'mutate',
  description: 'Switch back to the previous valid symbol/date. Requires a semantic action history.',
  preconditions: ['A previous valid session must be recorded in history.'],
  argSchema: { type: 'object', properties: {} },
  delegatesTo: 'semantic action history (Phase 5)',
  execute: async (planId, step, ctx) => {
    void ctx;
    return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'session.switch_to_previous_symbol is not implemented in V1.');
  },
});

// ---------------------------------------------------------------------------
// 5. session.resolve_trading_date
// ---------------------------------------------------------------------------

registerCapability({
  name: 'session.resolve_trading_date',
  kind: 'read',
  description: 'Resolve an explicit or relative date to an actual available trading session.',
  preconditions: ['Engine connected.', 'Active symbol (or symbol provided) to probe candle data.'],
  argSchema: {
    type: 'object',
    properties: { input: { type: 'object' }, symbol: { type: 'string' } },
    required: ['input'],
  },
  delegatesTo: 'resolveTradingDate(input, { hasData }) where hasData uses fetchCandles',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    const input = step.args.input as import('./resolveTradingDate').TradingDateInput | undefined;
    if (!input || typeof input !== 'object') {
      return failureReceipt(planId, step, 'INVALID_ARGUMENTS', 'Missing or invalid date input.');
    }
    const symbol = String(step.args.symbol ?? currentSessionSymbol(ctx) ?? '');
    if (!symbol) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No symbol to check date availability against.');
    }

    const hasData = async (date: string): Promise<boolean> => {
      try {
        const probe = await fetchCandles({ symbol, date, timeframe: 1, limit: 1, dataDir: ctx.dataDir }, ctx.apiBase);
        return !probe.missing;
      } catch (e) {
        console.warn('[agent] resolve_trading_date probe failed:', e);
        return false;
      }
    };

    const r = await resolveTradingDate(input, { hasData });
    if (token?.cancelled) {
      return wasCancelled(planId, step, token)!;
    }
    if (r.ok) {
      return successReceipt(planId, step, r.message, {
        date: r.date,
        requestedDate: r.requestedDate,
        adjustment: r.adjustment,
      });
    }
    return failureReceipt(planId, step, 'NO_DATA_FOR_DATE', r.message, {
      requestedDate: r.requestedDate,
      nearestAvailable: r.nearestAvailable,
    });
  },
});

// ---------------------------------------------------------------------------
// 6. chart.set_timeframe
// ---------------------------------------------------------------------------

registerCapability({
  name: 'chart.set_timeframe',
  kind: 'mutate',
  description: 'Set the active chart timeframe (1m, 5m, 15m, 1h, 4h, daily).',
  preconditions: ['Active session.', 'Engine connected.'],
  argSchema: { type: 'object', properties: { timeframe: { type: 'number' } }, required: ['timeframe'] },
  delegatesTo: 'send({ cmd: "set_timeframe", minutes }) + dispatch SET_TIMEFRAME',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    const tf = clampTimeframe(Number(step.args.timeframe));
    if (tf === undefined) {
      return failureReceipt(planId, step, 'INVALID_ARGUMENTS', 'Unsupported timeframe. Use 1, 5, 15, 60, 240, or 1440.');
    }
    if (!ctx.getState().sessionActive) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No active session to set timeframe on.');
    }

    const before = ctx.getState();
    ctx.send({ cmd: 'set_timeframe', minutes: tf });
    ctx.dispatch({ type: 'SET_TIMEFRAME', timeframe: tf });

    const ok = await waitForState(ctx, (s) => s.timeframe === tf, 3000, 50);
    if (!ok) {
      const after = ctx.getState();
      return failureReceipt(planId, step, 'ACKNOWLEDGMENT_TIMEOUT', `Timeframe did not confirm as ${tf}m.`, {
        requestedTimeframe: tf,
        actualTimeframe: after.timeframe,
      });
    }
    const after = ctx.getState();
    return successReceipt(planId, step, `Timeframe set to ${tf}m.`, { timeframe: tf }, [
      { key: 'timeframe', before: before.timeframe, after: after.timeframe },
    ]);
  },
});

// ---------------------------------------------------------------------------
// 7. playback.seek_relative
// ---------------------------------------------------------------------------

registerCapability({
  name: 'playback.seek_relative',
  kind: 'mutate',
  description: 'Seek forward or backward by a relative number of minutes.',
  preconditions: ['Active session.', 'Engine connected.'],
  argSchema: { type: 'object', properties: { minutes: { type: 'number' } }, required: ['minutes'] },
  delegatesTo: 'get current cursor, compute target timestamp, send seek',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;
    void ctx;
    return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'playback.seek_relative is not connected in Phase 2.');
  },
});

// ---------------------------------------------------------------------------
// 8. playback.seek_to_time
// ---------------------------------------------------------------------------

registerCapability({
  name: 'playback.seek_to_time',
  kind: 'mutate',
  description: 'Seek the chart to a specific market time (e.g. "10:35").',
  preconditions: ['Active session.', 'Engine connected.'],
  argSchema: { type: 'object', properties: { time: { type: 'string' } }, required: ['time'] },
  delegatesTo: 'toEngineTs + send({ cmd: "seek", timestamp })',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;
    void ctx;
    return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'playback.seek_to_time is not connected in Phase 2.');
  },
});

// ---------------------------------------------------------------------------
// 9. playback.play_until
// ---------------------------------------------------------------------------

registerCapability({
  name: 'playback.play_until',
  kind: 'mutate',
  description: 'Start playback, optionally stopping at a target timestamp.',
  preconditions: ['Active session.', 'Engine connected.'],
  argSchema: {
    type: 'object',
    properties: {
      speed: { type: 'number' },
      direction: { type: 'string', enum: ['forward', 'backward'] },
      until: { type: 'number' },
    },
  },
  delegatesTo: 'send({ cmd: "set_speed" }), send({ cmd: "play", speed, until }) + dispatch SET_PLAYING',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    if (!ctx.getState().sessionActive) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No active session to play.');
    }

    const speed = Math.max(1, Math.min(100, Number(step.args.speed ?? 1)));
    const direction = step.args.direction === 'backward' ? 'backward' : 'forward';
    const until = step.args.until !== undefined ? Number(step.args.until) : undefined;

    const before = ctx.getState();

    // Set direction and speed first so the play command uses the correct values.
    ctx.send({ cmd: 'set_direction', direction });
    ctx.send({ cmd: 'set_speed', speed });
    ctx.dispatch({ type: 'SET_SPEED', speed });
    ctx.send({ cmd: 'play', direction, speed, ...(until !== undefined ? { until } : {}) });
    ctx.dispatch({ type: 'SET_PLAYING', isPlaying: true });

    const ok = await waitForState(ctx, (s) => s.isPlaying === true && s.speed === speed, 3000, 50);
    if (!ok) {
      const after = ctx.getState();
      return failureReceipt(planId, step, 'ACKNOWLEDGMENT_TIMEOUT', `Playback did not confirm at ${speed}x.`, {
        requestedSpeed: speed,
        actualIsPlaying: after.isPlaying,
        actualSpeed: after.speed,
      });
    }
    const after = ctx.getState();
    return successReceipt(planId, step, `Playing ${direction} at ${speed}x.`, { speed, direction, until }, [
      { key: 'isPlaying', before: before.isPlaying, after: after.isPlaying },
      { key: 'speed', before: before.speed, after: after.speed },
    ]);
  },
});

// ---------------------------------------------------------------------------
// 10. playback.pause
// ---------------------------------------------------------------------------

registerCapability({
  name: 'playback.pause',
  kind: 'mutate',
  description: 'Pause auto-playback.',
  preconditions: ['Active session.', 'Engine connected.'],
  argSchema: { type: 'object', properties: {} },
  delegatesTo: 'send({ cmd: "pause" }) + dispatch SET_PLAYING',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    if (!ctx.getState().sessionActive) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No active session to pause.');
    }

    const before = ctx.getState();
    ctx.send({ cmd: 'pause' });
    ctx.dispatch({ type: 'SET_PLAYING', isPlaying: false });

    const ok = await waitForState(ctx, (s) => s.isPlaying === false, 3000, 50);
    if (!ok) {
      const after = ctx.getState();
      return failureReceipt(planId, step, 'ACKNOWLEDGMENT_TIMEOUT', 'Pause did not confirm.', {
        actualIsPlaying: after.isPlaying,
      });
    }
    const after = ctx.getState();
    return successReceipt(planId, step, 'Paused.', { isPlaying: false }, [
      { key: 'isPlaying', before: before.isPlaying, after: after.isPlaying },
    ]);
  },
});

// ---------------------------------------------------------------------------
// 11. chart.get_current_candle
// ---------------------------------------------------------------------------

registerCapability({
  name: 'chart.get_current_candle',
  kind: 'read',
  description: 'Return the most recent candle for the active session.',
  preconditions: ['Active session.', 'Chart loaded.'],
  argSchema: { type: 'object', properties: {} },
  delegatesTo: 'chartRef.current.getRecentCandles(1)[0]',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    const candle = ctx.chartRef?.current?.getRecentCandles(1)[0];
    if (!candle) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No current candle available.');
    }
    return successReceipt(planId, step, 'Current candle retrieved.', {
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });
  },
});

// ---------------------------------------------------------------------------
// 12. chart.get_candle_at_time
// ---------------------------------------------------------------------------

registerCapability({
  name: 'chart.get_candle_at_time',
  kind: 'read',
  description: 'Return the candle at a requested market time.',
  preconditions: ['Active session.', 'Chart loaded or engine data available.'],
  argSchema: { type: 'object', properties: { time: { type: 'string' } }, required: ['time'] },
  delegatesTo: 'fetchCandles for the active symbol/date/timeframe + binary search',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;
    void ctx;
    return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'chart.get_candle_at_time is not connected in Phase 2.');
  },
});
