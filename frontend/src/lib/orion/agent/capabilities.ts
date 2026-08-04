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

import type { AgentStep, ExecutionReceipt, AgentContext, CancellationToken, CandleSnapshot } from './types';
import { successReceipt, failureReceipt } from './receipts';
import { buildWorldState } from '../worldState';
import { resolveSymbol } from './resolveSymbol';
import { resolveTradingDate } from './resolveTradingDate';
import { fetchCandles } from '../tools';
import { clampTimeframe, toEngineTs, toEtTime, formatTime } from '../planner';

// Tracks previous sessions so session.switch_to_previous_symbol can restore them.
const sessionHistory: Array<{ symbol: string; date: string }> = [];

export function clearSessionHistory(): void {
  sessionHistory.length = 0;
}

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

function parseTimeString(input: string): { hour: number; minute: number } | null {
  const t = input.trim().toLowerCase();
  const m1 = t.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\b/);
  if (m1) {
    let h = parseInt(m1[1], 10);
    const min = parseInt(m1[2], 10);
    const meridian = m1[3];
    if (meridian === 'am' && h === 12) h = 0;
    if (meridian === 'pm' && h !== 12) h += 12;
    if (h >= 0 && h < 24 && min >= 0 && min < 60) return { hour: h, minute: min };
  }
  const m2 = t.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (m2) {
    let h = parseInt(m2[1], 10);
    const meridian = m2[2];
    if (meridian === 'am' && h === 12) h = 0;
    if (meridian === 'pm' && h !== 12) h += 12;
    if (h >= 0 && h < 24) return { hour: h, minute: 0 };
  }
  return null;
}

function currentCandleTimestamp(ctx: AgentContext): number | undefined {
  const candle = ctx.chartRef?.current?.getRecentCandles(1)[0];
  return candle?.timestamp;
}

function waitForCandleAt(ctx: AgentContext, target: number, timeoutMs = 3000, intervalMs = 50): Promise<boolean> {
  const start = Date.now();
  const check = () => {
    const ts = currentCandleTimestamp(ctx);
    return ts !== undefined && ts >= target && ts - target <= 600;
  };
  if (check()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (check() || Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(check());
      }
    }, intervalMs);
  });
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
  argSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    if (before.sessionActive && before.symbol) {
      sessionHistory.push({ symbol: before.symbol, date: before.replayDate });
    }
    try {
      await Promise.resolve(ctx.onSwitchSymbol(symbol, date));
    } catch (e) {
      sessionHistory.pop();
      return failureReceipt(planId, step, 'ENGINE_ERROR', `Switch to ${symbol} threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (token?.cancelled) {
      sessionHistory.pop();
      return wasCancelled(planId, step, token)!;
    }

    const ok = await waitForState(
      ctx,
      (s) => s.symbol === symbol && s.sessionActive && (date === undefined || s.replayDate === date),
      3000,
      80
    );
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
  argSchema: { type: 'object', properties: {}, additionalProperties: false },
  delegatesTo: 'sessionHistory stack',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    if (sessionHistory.length === 0) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No previous session to switch to.');
    }

    const previous = sessionHistory[sessionHistory.length - 1];
    if (!ctx.availableTickers.includes(previous.symbol)) {
      return failureReceipt(planId, step, 'SYMBOL_UNAVAILABLE', `Previous session ${previous.symbol} is no longer available.`);
    }
    if (!ctx.onSwitchSymbol) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'Symbol-switch bridge is not wired.');
    }

    try {
      await Promise.resolve(ctx.onSwitchSymbol(previous.symbol, previous.date));
    } catch (e) {
      return failureReceipt(planId, step, 'ENGINE_ERROR', `Switch to previous ${previous.symbol} threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (token?.cancelled) {
      return wasCancelled(planId, step, token)!;
    }

    const ok = await waitForState(
      ctx,
      (s) => s.symbol === previous.symbol && s.sessionActive && s.replayDate === previous.date,
      3000,
      80
    );
    if (!ok) {
      return failureReceipt(planId, step, 'ACKNOWLEDGMENT_TIMEOUT', `Did not switch back to ${previous.symbol} ${previous.date}.`);
    }

    sessionHistory.pop();
    const after = ctx.getState();
    return successReceipt(
      planId,
      step,
      `Switched back to ${after.symbol} on ${after.replayDate}.`,
      { symbol: after.symbol, date: after.replayDate, totalCandles: after.totalCandles }
    );
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
        // A fallback result means the requested date is not itself a trading
        // session; the resolver must keep walking rather than accepting it.
        return !probe.missing && !probe.fallbackUsed;
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
  argSchema: {
    type: 'object',
    properties: { timeframe: { type: 'integer' } },
    required: ['timeframe'],
  },
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
  argSchema: { type: 'object', properties: { minutes: { type: 'integer' } }, required: ['minutes'] },
  delegatesTo: 'get current cursor, compute target timestamp, send seek',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    if (!ctx.getState().sessionActive) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No active session to seek in.');
    }

    const minutes = Number(step.args.minutes ?? 0);
    if (Number.isNaN(minutes)) {
      return failureReceipt(planId, step, 'INVALID_ARGUMENTS', 'Need a number of minutes to seek.');
    }

    const currentTs = currentCandleTimestamp(ctx);
    if (currentTs === undefined) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No current candle to seek from.');
    }

    const target = currentTs + minutes * 60;
    ctx.send({ cmd: 'seek', timestamp: target });

    const ok = await waitForCandleAt(ctx, target, 3000, 50);
    if (!ok) {
      return failureReceipt(planId, step, 'ACKNOWLEDGMENT_TIMEOUT', `Did not confirm seek to ${new Date(target * 1000).toISOString()}.`);
    }
    const candle = currentCandleTimestamp(ctx) ?? target;
    return successReceipt(planId, step, `Sought ${minutes > 0 ? 'forward' : 'backward'} ${Math.abs(minutes)} minutes.`, {
      target,
      timestamp: candle,
    });
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

    if (!ctx.getState().sessionActive) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No active session to seek in.');
    }

    const time = String(step.args.time ?? '');
    const parsed = parseTimeString(time);
    if (!parsed) {
      return failureReceipt(planId, step, 'INVALID_ARGUMENTS', `Could not parse time "${time}".`);
    }

    const date = ctx.getState().replayDate;
    if (!date) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No active session date to seek on.');
    }

    const target = toEngineTs(date, parsed.hour, parsed.minute);
    ctx.send({ cmd: 'seek', timestamp: target });

    const ok = await waitForCandleAt(ctx, target, 3000, 50);
    if (!ok) {
      return failureReceipt(planId, step, 'ACKNOWLEDGMENT_TIMEOUT', `Did not confirm seek to ${time}.`);
    }
    const candle = currentCandleTimestamp(ctx) ?? target;
    return successReceipt(planId, step, `Seeked to ${time}.`, {
      time,
      timestamp: candle,
      target,
    });
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
      speed: { type: 'integer' },
      direction: { type: 'string', enum: ['forward', 'backward'] },
      until: { type: 'number' },
      untilTime: { type: 'string' },
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
    let until: number | undefined;
    if (step.args.until !== undefined) {
      until = Number(step.args.until);
    } else if (step.args.untilTime !== undefined) {
      const parsed = parseTimeString(String(step.args.untilTime));
      if (parsed) {
        const date = ctx.getState().replayDate;
        if (date) until = toEngineTs(date, parsed.hour, parsed.minute);
      }
    }

    const before = ctx.getState();

    // Set direction and speed first so the play command uses the correct values.
    ctx.send({ cmd: 'set_direction', direction });
    ctx.send({ cmd: 'set_speed', speed });
    ctx.dispatch({ type: 'SET_SPEED', speed });
    ctx.send({ cmd: 'play', direction, speed, ...(until !== undefined ? { until } : {}) });
    ctx.dispatch({ type: 'SET_PLAYING', isPlaying: true });

    const started = await waitForState(ctx, (s) => s.isPlaying === true && s.speed === speed, 3000, 50);
    if (!started) {
      const after = ctx.getState();
      return failureReceipt(planId, step, 'ACKNOWLEDGMENT_TIMEOUT', `Playback did not confirm at ${speed}x.`, {
        requestedSpeed: speed,
        actualIsPlaying: after.isPlaying,
        actualSpeed: after.speed,
      });
    }

    // If the caller requested a stop time, wait for the engine to stop.
    if (until !== undefined) {
      const stopped = await waitForState(ctx, (s) => s.isPlaying === false, 120000, 100);
      if (!stopped) {
        const after = ctx.getState();
        return failureReceipt(planId, step, 'ACKNOWLEDGMENT_TIMEOUT', `Playback did not stop at the target time.`, {
          requestedUntil: until,
          actualIsPlaying: after.isPlaying,
        });
      }

      // Make sure the chart has actually arrived at or passed the target.
      const atTarget = await waitForCandleAt(ctx, until, 3000, 50);
      if (!atTarget) {
        return failureReceipt(planId, step, 'ACKNOWLEDGMENT_TIMEOUT', `Playback stopped but the chart did not reach the target time.`, {
          requestedUntil: until,
        });
      }
    }

    const after = ctx.getState();
    const finalCandle = currentCandleTimestamp(ctx);
    let finalTime = '';
    if (until !== undefined && after.replayDate) {
      const et = toEtTime(finalCandle ?? until, after.replayDate);
      finalTime = formatTime(et);
    }
    const message = until !== undefined
      ? `Played ${direction} at ${speed}x and stopped at ${finalTime}.`
      : `Playing ${direction} at ${speed}x.`;

    const data: Record<string, unknown> = { speed, direction, until };
    if (finalCandle !== null) data.finalTimestamp = finalCandle;
    if (finalTime) data.finalTime = finalTime;

    return successReceipt(planId, step, message, data, [
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
  argSchema: { type: 'object', properties: {}, additionalProperties: false },
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
  argSchema: { type: 'object', properties: {}, additionalProperties: false },
  delegatesTo: 'chartRef.current.getRecentCandles(1)[0]',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    const candle = ctx.chartRef?.current?.getRecentCandles(1)[0];
    if (!candle) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No current candle available.');
    }
    const message = `The candle has close ${candle.close}, open ${candle.open}, high ${candle.high}, low ${candle.low}, volume ${candle.volume}.`;
    return successReceipt(planId, step, message, {
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

    if (!ctx.getState().sessionActive) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No active session to read a candle from.');
    }

    const time = String(step.args.time ?? '');
    const parsed = parseTimeString(time);
    if (!parsed) {
      return failureReceipt(planId, step, 'INVALID_ARGUMENTS', `Could not parse time "${time}".`);
    }

    const symbol = ctx.getState().symbol;
    const date = ctx.getState().replayDate;
    const timeframe = ctx.getState().timeframe;
    if (!symbol || !date) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No active symbol/date to read a candle from.');
    }

    const target = toEngineTs(date, parsed.hour, parsed.minute);
    try {
      const res = await fetchCandles({ symbol, date, timeframe, limit: 5000, dataDir: ctx.dataDir }, ctx.apiBase);
      if (res.missing || res.candles.length === 0) {
        return failureReceipt(planId, step, 'NO_DATA_FOR_DATE', `No candles for ${symbol} ${date} at ${timeframe}m.`);
      }

      const idx = res.candles.findIndex((c) => c.timestamp >= target);
      const candle = idx >= 0 ? res.candles[idx] : res.candles[res.candles.length - 1];
      const explanation = `For "price" at this time, the OHLCV is open ${candle.open}, high ${candle.high}, low ${candle.low}, close ${candle.close}.`;
      return successReceipt(planId, step, explanation, {
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      });
    } catch (e) {
      return failureReceipt(planId, step, 'ENGINE_ERROR', `Failed to fetch candles: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});

// ---------------------------------------------------------------------------
// 13. analysis.compare_candles
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

function pct(diff: number, base: number): string {
  if (!Number.isFinite(base) || base === 0) return 'n/a';
  return `${((diff / Math.abs(base)) * 100).toFixed(2)}%`;
}

type CompareSideResolution =
  | { kind: 'success'; candle: CandleSnapshot }
  | { kind: 'failure'; receipt: ExecutionReceipt };

function resolveCompareSide(
  planId: string,
  step: AgentStep,
  sideKey: 'left' | 'right',
  ctx: AgentContext
): CompareSideResolution {
  const raw = step.args[sideKey] as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || !('source' in raw)) {
    return {
      kind: 'failure',
      receipt: failureReceipt(planId, step, 'INVALID_ARGUMENTS', `Missing ${sideKey} operand.`),
    };
  }

  const source = String(raw.source);

  if (source === 'chart') {
    const current = ctx.chartRef?.current?.getRecentCandles(1)[0];
    if (!current) {
      return {
        kind: 'failure',
        receipt: failureReceipt(planId, step, 'PRECONDITION_FAILED', `No live chart candle available for ${sideKey}.`),
      };
    }
    const state = ctx.getState();
    const marketTime = state.replayDate
      ? formatTime(toEtTime(current.timestamp, state.replayDate))
      : '';
    return {
      kind: 'success',
      candle: {
        snapshotId: 0,
        source: 'current_candle',
        symbol: state.symbol,
        date: state.replayDate ?? '',
        timeframe: state.timeframe,
        timestamp: current.timestamp,
        marketTime,
        open: current.open,
        high: current.high,
        low: current.low,
        close: current.close,
        volume: current.volume,
      },
    };
  }

  if (source === 'snapshot') {
    const symbol = String(raw.symbol ?? '');
    const date = String(raw.date ?? '');
    const timeframe = Number(raw.timeframe ?? 0);
    const timestamp = Number(raw.timestamp ?? 0);
    if (!symbol || !date || !timeframe || !timestamp) {
      return {
        kind: 'failure',
        receipt: failureReceipt(planId, step, 'INVALID_ARGUMENTS', `Missing ${sideKey} snapshot coordinates.`),
      };
    }
    const snapshotId = raw.snapshotId !== undefined ? Number(raw.snapshotId) : undefined;
    const found = ctx.executionLog.findCandle({ snapshotId, symbol, date, timeframe, timestamp });
    if (!found) {
      return {
        kind: 'failure',
        receipt: failureReceipt(
          planId,
          step,
          'PRECONDITION_FAILED',
          `The ${sideKey} referenced candle ${symbol} ${date} ${timeframe}m @ ${raw.marketTime ?? ''} was not found in the execution log.`
        ),
      };
    }
    return { kind: 'success', candle: found };
  }

  return {
    kind: 'failure',
    receipt: failureReceipt(planId, step, 'INVALID_ARGUMENTS', `Unknown ${sideKey} source "${source}".`),
  };
}

registerCapability({
  name: 'analysis.compare_candles',
  kind: 'read',
  description: 'Compare two explicit candle operands and return a verified, structured comparison.',
  preconditions: ['Active session.', 'Both candle operands must be resolvable.'],
  argSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['left', 'right'],
    properties: {
      left: {
        type: 'object',
        additionalProperties: false,
        required: ['source'],
        properties: {
          source: { enum: ['chart', 'snapshot'] },
          snapshotId: { type: 'integer' },
          symbol: { type: 'string' },
          date: { type: 'string' },
          timeframe: { type: 'integer' },
          timestamp: { type: 'integer' },
          marketTime: { type: 'string' },
        },
      },
      right: {
        type: 'object',
        additionalProperties: false,
        required: ['source'],
        properties: {
          source: { enum: ['chart', 'snapshot'] },
          snapshotId: { type: 'integer' },
          symbol: { type: 'string' },
          date: { type: 'string' },
          timeframe: { type: 'integer' },
          timestamp: { type: 'integer' },
          marketTime: { type: 'string' },
        },
      },
    },
  },
  delegatesTo: 'ctx.executionLog.findCandle + chartRef.getRecentCandles',
  execute: async (planId, step, ctx, token) => {
    const c = wasCancelled(planId, step, token);
    if (c) return c;

    const state = ctx.getState();
    if (!state.sessionActive) {
      return failureReceipt(planId, step, 'PRECONDITION_FAILED', 'No active session to compare candles.');
    }

    const left = await resolveCompareSide(planId, step, 'left', ctx);
    if (left.kind === 'failure') {
      return left.receipt;
    }
    const right = await resolveCompareSide(planId, step, 'right', ctx);
    if (right.kind === 'failure') {
      return right.receipt;
    }

    const a = left.candle;
    const b = right.candle;

    const sameCandle =
      a.timestamp === b.timestamp &&
      a.symbol === b.symbol &&
      a.date === b.date &&
      a.timeframe === b.timeframe;

    const openDiff = a.open - b.open;
    const highDiff = a.high - b.high;
    const lowDiff = a.low - b.low;
    const closeDiff = a.close - b.close;
    const volumeDiff = a.volume - b.volume;

    const aRange = a.high - a.low;
    const bRange = b.high - b.low;
    const rangeDiff = aRange - bRange;

    const aDir = a.close >= a.open ? 'bullish' : 'bearish';
    const bDir = b.close >= b.open ? 'bullish' : 'bearish';

    const data = {
      left: {
        symbol: a.symbol,
        date: a.date,
        timeframe: a.timeframe,
        timestamp: a.timestamp,
        marketTime: a.marketTime,
        open: a.open,
        high: a.high,
        low: a.low,
        close: a.close,
        volume: a.volume,
        direction: aDir,
      },
      right: {
        symbol: b.symbol,
        date: b.date,
        timeframe: b.timeframe,
        timestamp: b.timestamp,
        marketTime: b.marketTime,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        direction: bDir,
      },
      deltas: {
        open: openDiff,
        openPercent: pct(openDiff, b.open),
        high: highDiff,
        highPercent: pct(highDiff, b.high),
        low: lowDiff,
        lowPercent: pct(lowDiff, b.low),
        close: closeDiff,
        closePercent: pct(closeDiff, b.close),
        volume: volumeDiff,
        volumePercent: pct(volumeDiff, b.volume),
        range: rangeDiff,
      },
    };

    const aLabel = `${a.marketTime} ${a.symbol} ${a.date} ${a.timeframe}m`;
    const bLabel = `${b.marketTime} ${b.symbol} ${b.date} ${b.timeframe}m`;

    if (sameCandle) {
      return successReceipt(planId, step, `The left candle (${aLabel}) and the right candle (${bLabel}) are the same.`, data);
    }

    const summary = [
      `${aDir} candle at ${a.marketTime} vs ${bDir} candle at ${b.marketTime}:`,
      `open ${fmt(a.open)} (${openDiff >= 0 ? '+' : ''}${fmt(openDiff)}, ${data.deltas.openPercent})`,
      `high ${fmt(a.high)} (${highDiff >= 0 ? '+' : ''}${fmt(highDiff)}, ${data.deltas.highPercent})`,
      `low ${fmt(a.low)} (${lowDiff >= 0 ? '+' : ''}${fmt(lowDiff)}, ${data.deltas.lowPercent})`,
      `close ${fmt(a.close)} (${closeDiff >= 0 ? '+' : ''}${fmt(closeDiff)}, ${data.deltas.closePercent})`,
      `range ${fmt(aRange)} (diff ${rangeDiff >= 0 ? '+' : ''}${fmt(rangeDiff)})`,
      `volume ${fmt(a.volume)} (${volumeDiff >= 0 ? '+' : ''}${fmt(volumeDiff)}, ${data.deltas.volumePercent})`,
    ].join(' · ');

    return successReceipt(planId, step, summary, data);
  },
});
