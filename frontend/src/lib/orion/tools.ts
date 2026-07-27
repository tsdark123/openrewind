// =============================================================================
// tools — Central registry of Orion's capabilities.
//
// This is the ONE place any Orion feature is added. Every capability the
// agent can invoke — reading world state, fetching candles, later navigating
// the chart, placing automated orders, running a strategy — is declared here
// with:
//
//   * a stable string `name` (also the LLM tool-call name)
//   * a JSON `parameters` schema (Ollama /api/chat tools[] format)
//   * a typed `execute` implementation
//   * a `mode` guard controlling whether it is dispatched in `chat` or
//     `driving` sessions (write tools stay disabled outside driving mode)
//
// PR-2 ships only the read-only tools. Write / navigation / strategy tools
// arrive in PR-3+ with the automation driver.
// =============================================================================

import type { WorldState } from './worldState';
import type { ActiveSessionTrade, AppAction, AppState, CandleData, PerformanceLog } from '../../types';
import type { ChatMessage, OrionThreads } from '../orionThreads';
import { GLOBAL_THREAD_KEY, threadKeyForContext } from '../orionThreads';
import { buildWorldState } from './worldState';
import type { ChartHandle } from '../../components/Chart';
import { runStrategy as executeStrategy, getStrategy, num, ema, sma, stddev, atr, rangeOf } from './strategies';
import type { EndCondition, StrategyResult } from './strategies';
import type { Position, Side } from '../../types';

// -----------------------------------------------------------------------------
// Tool dispatcher context — everything a tool might need, threaded through so
// tools remain pure functions of their args + ambient runtime state.
// -----------------------------------------------------------------------------

export type OrionMode = 'chat' | 'driving';

export interface OrionRuntimeContext {
  mode: OrionMode;
  state: AppState;
  chartRef: { current: ChartHandle | null } | null;
  performanceLog: PerformanceLog;
  threads: OrionThreads;
  // In Tauri builds the engine is on 127.0.0.1:9000; in browser dev mode
  // the empty string routes through the Vite proxy. Mirrors App.tsx.
  apiBase: string;
  // Write / session tools need these to control the live engine/redux state.
  send?: (cmd: Record<string, unknown>) => void;
  dispatch?: (action: AppAction) => void;
  // Snapshot accessor for tools that need the most recent WS-updated state
  // (e.g. after next_candle or place_order).
  getState?: () => AppState;
  // Controller-level hooks that close the automation loop.
  postChatMessage?: (text: string) => Promise<void>;
  restoreSnapshot?: () => Promise<void>;
}

export interface OrionToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface OrionToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  // JSON schema for LLM tool-calling (Ollama /api/chat tools[] format).
  parameters: Record<string, unknown>;
  // Which modes may invoke this tool. Read-only tools are 'both'; write
  // tools declare 'driving' and are refused in chat mode.
  mode: 'both' | 'chat' | 'driving';
  execute: (args: TArgs, ctx: OrionRuntimeContext) => Promise<OrionToolResult<TResult>>;
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const registry = new Map<string, OrionToolDefinition<any, any>>();

export function registerOrionTool<A, R>(def: OrionToolDefinition<A, R>): void {
  registry.set(def.name, def as OrionToolDefinition<any, any>);
}

export function listOrionTools(mode: OrionMode): OrionToolDefinition<any, any>[] {
  const out: OrionToolDefinition<any, any>[] = [];
  for (const t of registry.values()) {
    if (t.mode === 'both' || t.mode === mode) out.push(t);
  }
  return out;
}

export function getOrionTool(name: string): OrionToolDefinition<any, any> | undefined {
  return registry.get(name);
}

/**
 * Central dispatcher. Every tool invocation — from the LLM or from
 * deterministic controller code — should go through this so the mode gate
 * and error normalization are honored uniformly.
 */
export async function invokeOrionTool<T = unknown>(
  name: string,
  args: unknown,
  ctx: OrionRuntimeContext
): Promise<OrionToolResult<T>> {
  const tool = registry.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  if (tool.mode !== 'both' && tool.mode !== ctx.mode) {
    return {
      ok: false,
      error: `Tool "${name}" is disabled in ${ctx.mode} mode.`,
    };
  }
  try {
    return (await tool.execute(args as any, ctx)) as OrionToolResult<T>;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// -----------------------------------------------------------------------------
// Ollama tool-schema helper — turns the registry into the array shape that
// Ollama's /api/chat `tools` field expects. Used by the two-tier client in
// PR-3.
// -----------------------------------------------------------------------------

export function ollamaToolSchemas(mode: OrionMode): Array<Record<string, unknown>> {
  return listOrionTools(mode).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// =============================================================================
// Read-only tools (PR-2)
// =============================================================================

registerOrionTool<Record<string, never>, WorldState>({
  name: 'getWorldState',
  description:
    'Returns a canonical JSON snapshot of the entire OpenRewind app state ' +
    'right now: session (symbol/date/timeframe/cursor/speed), account ' +
    '(balance/equity/positions/orders), active indicators, recent candles ' +
    'from the chart, session-scoped trades, and lifetime journal summary.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  mode: 'both',
  execute: async (_args, ctx) => {
    return { ok: true, data: buildWorldState(ctx.state, ctx.chartRef, ctx.performanceLog) };
  },
});

interface GetCandlesArgs {
  symbol: string;
  date?: string;
  timeframe?: number;
  limit?: number;
}

interface GetCandlesResult {
  symbol: string;
  date: string;
  timeframe: number;
  candles: CandleData[];
  missing: boolean;
  reason?: string;
  // If the requested date is missing, this tells the caller which nearby
  // date was actually loaded.
  fallbackUsed?: boolean;
  fallbackDate?: string;
}

/**
 * Fetch candles from the engine. If the requested date is missing, probe
 * the previous 10 calendar days (skipping weekends) to find the nearest
 * available bar set. This keeps the agent loop from stalling when a user
 * asks for a holiday or weekend date.
 */
export async function fetchCandles(
  args: GetCandlesArgs,
  apiBase: string
): Promise<GetCandlesResult> {
  const buildParams = (date?: string) => {
    const p = new URLSearchParams({ symbol: args.symbol });
    if (date) p.set('date', date);
    if (args.timeframe) p.set('timeframe', String(args.timeframe));
    if (args.limit) p.set('limit', String(args.limit));
    return p;
  };

  const tryFetch = async (date?: string): Promise<{ ok: true; body: GetCandlesResult } | { ok: false; status: number }> => {
    const res = await fetch(`${apiBase}/api/candles?${buildParams(date).toString()}`);
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as GetCandlesResult;
    return { ok: true, body };
  };

  const first = await tryFetch(args.date);
  if (!first.ok) {
    throw new Error(`Engine returned ${first.status}`);
  }
  if (!first.body.missing) return first.body;

  // No date filter means the engine already tried the full history and failed.
  if (!args.date) return first.body;

  const base = new Date(`${args.date}T00:00:00`);
  for (let offset = 1; offset <= 10; offset++) {
    const candidate = new Date(base);
    candidate.setDate(base.getDate() - offset);
    const day = candidate.getDay();
    if (day === 0 || day === 6) continue; // skip weekends
    const y = candidate.getFullYear();
    const m = String(candidate.getMonth() + 1).padStart(2, '0');
    const d = String(candidate.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;
    const fb = await tryFetch(dateStr);
    if (fb.ok && !fb.body.missing) {
      return { ...fb.body, date: args.date, fallbackUsed: true, fallbackDate: dateStr };
    }
  }

  return { ...first.body, fallbackUsed: false };
}

registerOrionTool<GetCandlesArgs, GetCandlesResult>({
  name: 'getCandles',
  description:
    'Loads historical OHLCV candles for any symbol/date without touching ' +
    'the active replay session. Returns up to `limit` bars aggregated to ' +
    'the requested timeframe. If the local data cache does not contain the ' +
    'requested date the result has `missing: true` so the caller can ' +
    'offer to run scripts/fetch_data.py --mode sync. The tool automatically ' +
    'tries nearby weekdays if the requested date is missing.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker symbol, e.g. AAPL.' },
      date: {
        type: 'string',
        description: 'YYYY-MM-DD filter. Optional; omit to load full history.',
      },
      timeframe: {
        type: 'integer',
        description: 'Minutes per bar (1/5/15/60/240/1440). Defaults to 1.',
      },
      limit: {
        type: 'integer',
        description: 'Max bars to return (hard cap 5000). Defaults to 500.',
      },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  mode: 'both',
  execute: async (args, ctx) => {
    try {
      const body = await fetchCandles(args, ctx.apiBase);
      return { ok: true, data: body };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

interface GetTradeHistoryArgs {
  symbol?: string;
  date?: string;
  limit?: number;
}

registerOrionTool<GetTradeHistoryArgs, unknown[]>({
  name: 'getTradeHistory',
  description:
    'Returns closed trades from the persisted journal, optionally filtered ' +
    'by symbol and/or date. Includes symbol on every record so foreign ' +
    'trades are never mistaken for the currently-loaded ticker.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      limit: { type: 'integer', description: 'Cap on records returned (default 50).' },
    },
    additionalProperties: false,
  },
  mode: 'both',
  execute: async (args, ctx) => {
    const limit = Math.max(1, Math.min(1000, args.limit ?? 50));
    const records = Object.values(ctx.performanceLog).flat();
    const trades: unknown[] = [];
    for (const rec of records) {
      if (args.symbol && rec.symbol !== args.symbol) continue;
      if (args.date && rec.date !== args.date) continue;
      const source = rec.trades ?? rec.closedTrades ?? [];
      for (const t of source) {
        trades.push({ ...t, symbol: rec.symbol, date: rec.date });
      }
    }
    trades.sort((a: any, b: any) => (b.exitTime ?? b.closed_at ?? 0) - (a.exitTime ?? a.closed_at ?? 0));
    return { ok: true, data: trades.slice(0, limit) };
  },
});

interface RecallConversationArgs {
  symbol?: string;
  date?: string;
  scope?: 'session' | 'global';
  limit?: number;
}

registerOrionTool<RecallConversationArgs, ChatMessage[]>({
  name: 'recallConversation',
  description:
    'Pulls prior Orion chat messages from a specific thread. Defaults to ' +
    'the currently-active thread. Use scope="global" for cross-symbol ' +
    'conversation memory.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      scope: { type: 'string', enum: ['session', 'global'] },
      limit: { type: 'integer', description: 'Max messages to return (default 20).' },
    },
    additionalProperties: false,
  },
  mode: 'both',
  execute: async (args, ctx) => {
    const limit = Math.max(1, Math.min(500, args.limit ?? 20));
    let key: string;
    if (args.scope === 'global') {
      key = GLOBAL_THREAD_KEY;
    } else if (args.symbol && args.date) {
      key = `session:${args.symbol}:${args.date}`;
    } else {
      key = threadKeyForContext(ctx.state.symbol, ctx.state.replayDate, ctx.state.sessionActive);
    }
    const messages = ctx.threads[key]?.messages ?? [];
    return { ok: true, data: messages.slice(-limit) };
  },
});

// =============================================================================
// Driving-mode tools (PR-5)
// =============================================================================

interface RunStrategyArgs {
  name: string;
  symbol: string;
  date?: string;
  timeframe?: number;
  limit?: number;
  params?: Record<string, unknown>;
  endCondition?: EndCondition;
}

registerOrionTool<RunStrategyArgs, StrategyResult>({
  name: 'runStrategy',
  description:
    'Backtest a named strategy against historical candles for a symbol/date. ' +
    'Fetches data (with weekday fallback if the date is missing), runs the ' +
    'strategy, and returns simulated trades, total PnL, win rate, and the ' +
    'end-condition status. End-condition guardrails are enforced even if the ' +
    'caller does not supply them.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        enum: ['openingRangeBreakout', 'emaCross', 'supportResistance', 'meanReversion'],
      },
      symbol: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      timeframe: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 2000 },
      params: { type: 'object', description: 'Strategy-specific parameters.' },
      endCondition: {
        type: 'object',
        description: 'Guardrails: maxTrades, maxBars, maxLoss, profitTarget, maxDurationMs.',
        properties: {
          maxTrades: { type: 'integer' },
          maxBars: { type: 'integer' },
          maxLoss: { type: 'number' },
          profitTarget: { type: 'number' },
          maxDurationMs: { type: 'integer' },
        },
        additionalProperties: false,
      },
    },
    required: ['name', 'symbol', 'date'],
    additionalProperties: false,
  },
  mode: 'driving',
  execute: async (args, ctx) => {
    const candleRes = await fetchCandles(
      {
        symbol: args.symbol,
        date: args.date,
        timeframe: args.timeframe ?? 1,
        limit: args.limit ?? 2000,
      },
      ctx.apiBase
    );
    if (candleRes.missing) {
      return {
        ok: false,
        error: `No candles for ${args.symbol} on ${args.date}. ${
          candleRes.fallbackDate
            ? `Tried fallback ${candleRes.fallbackDate} also with no luck.`
            : 'No recent fallback found.'
        }`,
      };
    }
    const result = executeStrategy(
      args.name,
      candleRes.candles,
      args.params ?? {},
      args.endCondition
    );
    return { ok: result.ok, data: result, error: result.error };
  },
});

interface PlaceOrderArgs {
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  quantity: number;
  stop_loss?: number;
  take_profit?: number;
  entry_price?: number;
}

function validSide(side: string): side is PlaceOrderArgs['side'] {
  return side === 'buy' || side === 'sell';
}

function validOrderType(type: string): type is PlaceOrderArgs['type'] {
  return type === 'market' || type === 'limit' || type === 'stop';
}

registerOrionTool<PlaceOrderArgs, { dispatched: boolean }>({
  name: 'placeOrder',
  description:
    'Places an order on the currently-active replay session. Use market ' +
    'orders for immediate fills, limit/stop orders for price-triggered fills. ' +
    'Stop-loss and take-profit are optional. Only available when Orion is in ' +
    'control of the workspace.',
  parameters: {
    type: 'object',
    properties: {
      side: { type: 'string', enum: ['buy', 'sell'] },
      type: { type: 'string', enum: ['market', 'limit', 'stop'] },
      quantity: { type: 'number' },
      stop_loss: { type: 'number' },
      take_profit: { type: 'number' },
      entry_price: { type: 'number', description: 'Required for limit and stop orders.' },
    },
    required: ['side', 'type', 'quantity'],
    additionalProperties: false,
  },
  mode: 'driving',
  execute: async (args, ctx) => {
    if (!ctx.send) return { ok: false, error: 'No WebSocket send bridge available.' };
    if (!validSide(args.side)) return { ok: false, error: `Invalid side: ${args.side}` };
    if (!validOrderType(args.type)) return { ok: false, error: `Invalid type: ${args.type}` };
    if (args.quantity <= 0) return { ok: false, error: 'quantity must be positive' };

    const cmd: Record<string, unknown> = {
      cmd: 'place_order',
      side: args.side,
      type: args.type,
      quantity: args.quantity,
    };
    if (args.stop_loss !== undefined && args.stop_loss > 0) cmd.stop_loss = args.stop_loss;
    if (args.take_profit !== undefined && args.take_profit > 0) cmd.take_profit = args.take_profit;
    if (args.type !== 'market' && args.entry_price !== undefined) {
      cmd.entry_price = args.entry_price;
    }

    ctx.send(cmd);
    // Give the engine a moment to broadcast the updated session_state.
    await new Promise((r) => setTimeout(r, 350));
    return { ok: true, data: { dispatched: true } };
  },
});

registerOrionTool<{ position_id: number }, { dispatched: boolean }>({
  name: 'closePosition',
  description:
    'Closes an open position by position_id on the active session. ' +
    'Position id equals the originating order_id in this engine.',
  parameters: {
    type: 'object',
    properties: {
      position_id: { type: 'integer' },
    },
    required: ['position_id'],
    additionalProperties: false,
  },
  mode: 'driving',
  execute: async (args, ctx) => {
    if (!ctx.send) return { ok: false, error: 'No WebSocket send bridge available.' };
    ctx.send({ cmd: 'close_position', position_id: args.position_id });
    await new Promise((r) => setTimeout(r, 350));
    return { ok: true, data: { dispatched: true } };
  },
});

interface SetSessionArgs {
  symbol: string;
  date?: string;
  starting_balance?: number;
}

registerOrionTool<SetSessionArgs, { symbol: string; date: string; totalCandles: number; fallbackUsed: boolean }>({
  name: 'setSession',
  description:
    "Starts a new replay session for the requested symbol and date. If the " +
    "date is not available, tries the previous weekdays and reports the " +
    "fallback date used. This changes the user's chart/workspace; the " +
    "automation driver will restore the prior session at task end.",
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD. Optional.' },
      starting_balance: { type: 'number', default: 100000 },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  mode: 'driving',
  execute: async (args, ctx) => {
    const candleRes = await fetchCandles(
      { symbol: args.symbol, date: args.date, timeframe: 1, limit: 1 },
      ctx.apiBase
    );
    if (candleRes.missing) {
      return { ok: false, error: `No data for ${args.symbol} ${args.date ?? ''}.` };
    }
    const sessionDate = candleRes.fallbackDate ?? args.date ?? '';
    try {
      const res = await fetch(`${ctx.apiBase}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: args.symbol,
          start_date: sessionDate,
          starting_balance: args.starting_balance ?? 100000,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: `Engine start failed (${res.status}): ${text}` };
      }
      const body = (await res.json()) as { total_candles?: number };
      // Let the WS session_started/session_state messages reach the reducer.
      await new Promise((r) => setTimeout(r, 600));
      return {
        ok: true,
        data: {
          symbol: args.symbol,
          date: sessionDate,
          totalCandles: body.total_candles ?? 0,
          fallbackUsed: candleRes.fallbackUsed ?? false,
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// ---------------------------------------------------------------------------
// Playback controls
// ---------------------------------------------------------------------------

registerOrionTool<Record<string, never>, { dispatched: boolean; isPlaying: boolean }>({
  name: 'play',
  description: 'Starts auto-playback of the current replay session.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  mode: 'driving',
  execute: async (_args, ctx) => {
    if (!ctx.send) return { ok: false, error: 'No WebSocket send bridge.' };
    ctx.send({ cmd: 'play' });
    if (ctx.dispatch) ctx.dispatch({ type: 'SET_PLAYING', isPlaying: true });
    const state = ctx.getState?.() ?? ctx.state;
    return { ok: true, data: { dispatched: true, isPlaying: state.isPlaying } };
  },
});

registerOrionTool<Record<string, never>, { dispatched: boolean; isPlaying: boolean }>({
  name: 'pause',
  description: 'Pauses auto-playback of the current replay session.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  mode: 'driving',
  execute: async (_args, ctx) => {
    if (!ctx.send) return { ok: false, error: 'No WebSocket send bridge.' };
    ctx.send({ cmd: 'pause' });
    if (ctx.dispatch) ctx.dispatch({ type: 'SET_PLAYING', isPlaying: false });
    const state = ctx.getState?.() ?? ctx.state;
    return { ok: true, data: { dispatched: true, isPlaying: state.isPlaying } };
  },
});

registerOrionTool<{ speed: number }, { dispatched: boolean; speed: number }>({
  name: 'setSpeed',
  description: 'Sets the replay playback speed multiplier (e.g. 1, 5, 10).',
  parameters: {
    type: 'object',
    properties: { speed: { type: 'integer', minimum: 1, maximum: 100 } },
    required: ['speed'],
    additionalProperties: false,
  },
  mode: 'driving',
  execute: async (args, ctx) => {
    if (!ctx.send) return { ok: false, error: 'No WebSocket send bridge.' };
    const speed = Math.max(1, Math.min(100, args.speed ?? 1));
    ctx.send({ cmd: 'set_speed', speed });
    if (ctx.dispatch) ctx.dispatch({ type: 'SET_SPEED', speed });
    const state = ctx.getState?.() ?? ctx.state;
    return { ok: true, data: { dispatched: true, speed: state.speed } };
  },
});

registerOrionTool<Record<string, never>, CandleData>({
  name: 'nextCandle',
  description:
    'Advances the replay by one candle and returns the new candle. Use this ' +
    'to walk the chart bar-by-bar while the agent makes trading decisions.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  mode: 'driving',
  execute: async (_args, ctx) => {
    if (!ctx.send) return { ok: false, error: 'No WebSocket send bridge.' } as OrionToolResult<CandleData>;
    ctx.send({ cmd: 'next_candle' });
    // Give the engine time to advance and broadcast candle_update/session_state.
    await new Promise((r) => setTimeout(r, 300));
    const latest = ctx.chartRef?.current?.getRecentCandles(1)?.[0];
    if (latest) {
      return { ok: true, data: latest };
    }
    const state = ctx.getState?.() ?? ctx.state;
    const price = state.currentPrice ?? 0;
    return {
      ok: true,
      data: {
        timestamp: 0,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
      },
    };
  },
});

registerOrionTool<{ order_id: number }, { dispatched: boolean }>({
  name: 'cancelOrder',
  description: 'Cancels a pending order by order_id.',
  parameters: {
    type: 'object',
    properties: { order_id: { type: 'integer' } },
    required: ['order_id'],
    additionalProperties: false,
  },
  mode: 'driving',
  execute: async (args, ctx) => {
    if (!ctx.send) return { ok: false, error: 'No WebSocket send bridge.' };
    ctx.send({ cmd: 'cancel_order', order_id: args.order_id });
    await new Promise((r) => setTimeout(r, 250));
    return { ok: true, data: { dispatched: true } };
  },
});

// =============================================================================
// Live strategy execution (PR-6)
// =============================================================================

interface LiveSignal {
  action: 'buy' | 'sell' | 'close' | 'hold';
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
}

function getLiveSignal(
  name: string,
  candles: CandleData[],
  params: Record<string, unknown>,
  position: { side: Side; entryPrice: number } | null
): LiveSignal {
  const lastIdx = candles.length - 1;
  if (lastIdx < 0) return { action: 'hold', quantity: 0 };
  const c = candles[lastIdx];

  switch (name) {
    case 'openingRangeBreakout': {
      const rangeBars = Math.max(1, Math.min(60, num(params.rangeBars, 15)));
      const quantity = Math.max(1, num(params.quantity, 10));
      if (lastIdx < rangeBars) return { action: 'hold', quantity };
      const tpMultiplier = Math.max(0.1, num(params.tpMultiplier, 1.5));
      const slBuffer = Math.max(0, num(params.slBuffer, 0));
      const opening = rangeOf(candles, 0, rangeBars - 1);
      const range = opening.high - opening.low;
      if (!position) {
        if (c.close > opening.high + slBuffer) {
          return {
            action: 'buy',
            quantity,
            stopLoss: opening.low - slBuffer,
            takeProfit: c.close + range * tpMultiplier,
          };
        }
        if (c.close < opening.low - slBuffer) {
          return {
            action: 'sell',
            quantity,
            stopLoss: opening.high + slBuffer,
            takeProfit: c.close - range * tpMultiplier,
          };
        }
      }
      return { action: 'hold', quantity };
    }

    case 'emaCross': {
      const fastPeriod = Math.max(2, Math.min(50, num(params.fastPeriod, 12)));
      const slowPeriod = Math.max(fastPeriod + 1, Math.min(200, num(params.slowPeriod, 26)));
      const quantity = Math.max(1, num(params.quantity, 10));
      const slAtr = Math.max(0.1, num(params.slAtr, 1.5));
      const tpAtr = Math.max(0.1, num(params.tpAtr, 3));
      const warmup = slowPeriod;
      if (lastIdx < warmup) return { action: 'hold', quantity };

      const closes = candles.map((x) => x.close);
      const fast = ema(closes, fastPeriod);
      const slow = ema(closes, slowPeriod);
      const atrValues = atr(candles, 14);
      const atrValue = atrValues[lastIdx] ?? c.high - c.low;

      if (position) {
        if (
          (position.side === 'buy' && fast[lastIdx] < slow[lastIdx]) ||
          (position.side === 'sell' && fast[lastIdx] > slow[lastIdx])
        ) {
          return { action: 'close', quantity: 0 };
        }
        return { action: 'hold', quantity: 0 };
      }

      if (lastIdx > 0) {
        const prevFast = fast[lastIdx - 1];
        const prevSlow = slow[lastIdx - 1];
        const curFast = fast[lastIdx];
        const curSlow = slow[lastIdx];
        if (prevFast <= prevSlow && curFast > curSlow) {
          return {
            action: 'buy',
            quantity,
            stopLoss: c.close - atrValue * slAtr,
            takeProfit: c.close + atrValue * tpAtr,
          };
        }
        if (prevFast >= prevSlow && curFast < curSlow) {
          return {
            action: 'sell',
            quantity,
            stopLoss: c.close + atrValue * slAtr,
            takeProfit: c.close - atrValue * tpAtr,
          };
        }
      }
      return { action: 'hold', quantity };
    }

    case 'supportResistance': {
      const lookback = Math.max(5, Math.min(100, num(params.lookback, 20)));
      const quantity = Math.max(1, num(params.quantity, 10));
      const confirmation = Math.max(1, Math.min(10, num(params.confirmation, 1)));
      const tpMultiplier = Math.max(0.1, num(params.tpMultiplier, 1.5));
      const slBuffer = Math.max(0, num(params.slBuffer, 0.05));
      const startIdx = lookback + confirmation - 1;
      if (lastIdx < startIdx) return { action: 'hold', quantity };
      if (position) return { action: 'hold', quantity };

      const isConfirmed = (i: number, above: boolean, level: number) => {
        for (let j = i - confirmation + 1; j <= i; j++) {
          if (j < 0) return false;
          if (above) {
            if (candles[j].close <= level + slBuffer) return false;
          } else {
            if (candles[j].close >= level - slBuffer) return false;
          }
        }
        return true;
      };

      const window = rangeOf(candles, lastIdx - lookback, lastIdx - 1);
      const range = window.high - window.low;
      if (isConfirmed(lastIdx, true, window.high)) {
        return {
          action: 'buy',
          quantity,
          stopLoss: window.low - slBuffer,
          takeProfit: c.close + range * tpMultiplier,
        };
      }
      if (isConfirmed(lastIdx, false, window.low)) {
        return {
          action: 'sell',
          quantity,
          stopLoss: window.high + slBuffer,
          takeProfit: c.close - range * tpMultiplier,
        };
      }
      return { action: 'hold', quantity };
    }

    case 'meanReversion': {
      const lookback = Math.max(5, Math.min(100, num(params.lookback, 20)));
      const k = Math.max(0.5, num(params.stdDev, 2));
      const quantity = Math.max(1, num(params.quantity, 10));
      if (lastIdx < lookback) return { action: 'hold', quantity };

      const closes = candles.map((x) => x.close);
      const mean = sma(closes, lookback);
      const sigma = stddev(closes, lookback);
      const m = mean[lastIdx];
      const s = sigma[lastIdx];
      if (m === null || s === null || s === 0) return { action: 'hold', quantity };

      const upper = m + k * s;
      const lower = m - k * s;
      if (position) {
        if (position.side === 'buy' && c.close >= m) return { action: 'close', quantity: 0 };
        if (position.side === 'sell' && c.close <= m) return { action: 'close', quantity: 0 };
        return { action: 'hold', quantity: 0 };
      }
      if (c.close < lower) return { action: 'buy', quantity, stopLoss: c.close - s, takeProfit: m };
      if (c.close > upper) return { action: 'sell', quantity, stopLoss: c.close + s, takeProfit: m };
      return { action: 'hold', quantity };
    }

    default:
      return { action: 'hold', quantity: 0 };
  }
}

async function waitForNextCandle(
  ctx: OrionRuntimeContext,
  timeoutMs = 1500
): Promise<CandleData | null> {
  if (!ctx.send) return null;
  const startCursor = ctx.getState?.().cursor ?? ctx.state.cursor;
  ctx.send({ cmd: 'next_candle' });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
    const state = ctx.getState?.();
    if (state && state.cursor > startCursor) {
      const c = ctx.chartRef?.current?.getRecentCandles(1)?.[0];
      if (c) return c;
    }
  }
  return ctx.chartRef?.current?.getRecentCandles(1)?.[0] ?? null;
}

async function waitForPosition(
  ctx: OrionRuntimeContext,
  side: Side,
  timeoutMs = 1500
): Promise<Position | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
    const state = ctx.getState?.() ?? ctx.state;
    const pos = state.openPositions.find((p) => p.side === side);
    if (pos) return pos;
  }
  return null;
}

function formatMoney(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function gradePerformance(pnl: number, winRate: number, maxDrawdownPct: number): string {
  if (pnl > 0 && winRate >= 60 && maxDrawdownPct < 5) return 'A';
  if (pnl > 0) return 'B';
  if (pnl >= 0) return 'C';
  return 'F';
}

interface StrategyReport {
  totalTrades: number;
  winRate: number;
  netPnl: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  grade: string;
  markdown: string;
}

function compileStrategyReport(
  strategyName: string,
  trades: ActiveSessionTrade[],
  startingBalance: number,
  bars: number,
  symbol: string,
  date: string
): StrategyReport {
  const sorted = [...trades].sort((a, b) => a.closed_at - b.closed_at);
  const totalTrades = sorted.length;
  const netPnl = Number(sorted.reduce((sum, t) => sum + t.realized_pnl, 0).toFixed(2));
  const winners = sorted.filter((t) => t.realized_pnl > 0).length;
  const winRate = totalTrades > 0 ? Math.round((winners / totalTrades) * 100) : 0;

  let equity = startingBalance;
  let peak = equity;
  let maxDrawdown = 0;
  for (const t of sorted) {
    equity += t.realized_pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const maxDrawdownPct = peak > 0 ? Number(((maxDrawdown / peak) * 100).toFixed(2)) : 0;
  const grade = gradePerformance(netPnl, winRate, maxDrawdownPct);

  const markdown = [
    `## Orion Strategy Report — \`${strategyName}\``,
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| **Total Trades** | ${totalTrades} |`,
    `| **Win Rate** | ${winRate}% |`,
    `| **Net PnL** | ${formatMoney(netPnl)} |`,
    `| **Max Drawdown** | ${formatMoney(maxDrawdown)} (${maxDrawdownPct}%) |`,
    `| **Grade** | ${grade} |`,
    '',
    `**Symbol:** ${symbol || '-'} · **Date:** ${date || '-'} · **Bars Processed:** ${bars}`,
  ].join('\n');

  return { totalTrades, winRate, netPnl, maxDrawdown, maxDrawdownPct, grade, markdown };
}

interface RunLiveStrategyArgs {
  name: string;
  params?: Record<string, unknown>;
  endCondition?: EndCondition;
}

registerOrionTool<
  RunLiveStrategyArgs,
  { bars: number; trades: number; endReason: string; pnl: number; finalBalance: number }
>({
  name: 'runLiveStrategy',
  description:
    'Runs a strategy against the live replay session, stepping one candle at a ' +
    'time and placing real market orders with stop-loss and take-profit. The ' +
    'session must already be loaded; use setSession first if needed. End-condition ' +
    'guardrails are enforced so the run cannot go on indefinitely.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        enum: ['openingRangeBreakout', 'emaCross', 'supportResistance', 'meanReversion'],
      },
      params: { type: 'object', description: 'Strategy-specific parameters.' },
      endCondition: {
        type: 'object',
        description: 'Guardrails: maxTrades, maxBars, maxLoss, profitTarget, maxDurationMs.',
        properties: {
          maxTrades: { type: 'integer' },
          maxBars: { type: 'integer' },
          maxLoss: { type: 'number' },
          profitTarget: { type: 'number' },
          maxDurationMs: { type: 'integer' },
        },
        additionalProperties: false,
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  mode: 'driving',
  execute: async (args, ctx) => {
    if (!ctx.send) return { ok: false, error: 'No WebSocket send bridge.' };
    if (!ctx.getState) return { ok: false, error: 'State accessor not available.' };

    // Halt any auto-play so we control the stepping.
    ctx.send({ cmd: 'pause' });
    if (ctx.dispatch) ctx.dispatch({ type: 'SET_PLAYING', isPlaying: false });

    // Seed history with everything the chart has already seen.
    const history = ctx.chartRef?.current?.getRecentCandles(1_000_000) ?? [];
    if (history.length === 0) {
      return { ok: false, error: 'No chart history. Start a session first.' };
    }

    const def = getStrategy(args.name);
    if (!def) return { ok: false, error: `Unknown strategy: ${args.name}` };

    const merged: EndCondition = {
      maxTrades: 10,
      maxBars: 100,
      maxLoss: -500,
      profitTarget: 2000,
      maxDurationMs: 60_000,
      ...def.defaultEndCondition,
      ...args.endCondition,
    };
    // Hard ceiling for live stepping: no more than 500 bars or 2 minutes.
    if (typeof merged.maxBars === 'number') merged.maxBars = Math.min(merged.maxBars, 500);
    if (typeof merged.maxDurationMs === 'number') merged.maxDurationMs = Math.min(merged.maxDurationMs, 120_000);

    const startMs = Date.now();
    const startBalance = ctx.getState().balance;
    let currentPosition: { side: Side; entryPrice: number; id: number } | null = null;
    let bars = 1; // current bar is already visible
    let trades = 0;
    let endReason = 'completed';

    const refreshPosition = () => {
      const pos = ctx.getState!().openPositions[0] ?? null;
      if (pos) {
        currentPosition = { side: pos.side, entryPrice: pos.entry_price, id: pos.id };
      } else {
        currentPosition = null;
      }
    };
    refreshPosition();

    while (true) {
      if (ctx.getState!().cursor >= (ctx.getState!().totalCandles - 1)) {
        endReason = 'end-of-data';
        break;
      }
      if (merged.maxBars !== undefined && bars >= merged.maxBars) {
        endReason = 'max-bars';
        break;
      }
      if (merged.maxTrades !== undefined && trades >= merged.maxTrades) {
        endReason = 'max-trades';
        break;
      }
      if (merged.maxDurationMs !== undefined && Date.now() - startMs > merged.maxDurationMs) {
        endReason = 'max-duration';
        break;
      }

      const signal = getLiveSignal(args.name, history, args.params ?? {}, currentPosition);

      if (signal.action === 'close' && currentPosition) {
        await invokeOrionTool('closePosition', { position_id: currentPosition.id }, ctx);
        await new Promise((r) => setTimeout(r, 300));
        refreshPosition();
        if (!currentPosition) trades++;
      } else if ((signal.action === 'buy' || signal.action === 'sell') && !currentPosition) {
        await invokeOrionTool('placeOrder', {
          side: signal.action,
          type: 'market',
          quantity: signal.quantity,
          stop_loss: signal.stopLoss,
          take_profit: signal.takeProfit,
        }, ctx);
        const pos = await waitForPosition(ctx, signal.action);
        if (pos) {
          currentPosition = { side: pos.side, entryPrice: pos.entry_price, id: pos.id };
        } else {
          refreshPosition();
        }
      }

      const next = await waitForNextCandle(ctx);
      if (!next) {
        endReason = 'end-of-data';
        break;
      }
      history.push(next);
      bars++;
      refreshPosition();

      const pnl = ctx.getState!().balance - startBalance;
      if (merged.maxLoss !== undefined && pnl <= merged.maxLoss) {
        endReason = 'max-loss';
        break;
      }
      if (merged.profitTarget !== undefined && pnl >= merged.profitTarget) {
        endReason = 'profit-target';
        break;
      }
    }

    // Close any open position before compiling the report.
    if (currentPosition) {
      await invokeOrionTool('closePosition', { position_id: currentPosition.id }, ctx);
      await new Promise((r) => setTimeout(r, 300));
      refreshPosition();
      if (!currentPosition) trades++;
    }

    const finalState = ctx.getState!();
    const automatedTrades = finalState.activeSessionTrades.filter((t) => t.is_automated === true);
    const report = compileStrategyReport(
      args.name,
      automatedTrades,
      startBalance,
      bars,
      finalState.symbol,
      finalState.replayDate
    );

    await ctx.postChatMessage?.(report.markdown);
    await ctx.restoreSnapshot?.();

    return {
      ok: true,
      data: {
        bars,
        trades: report.totalTrades,
        endReason,
        pnl: report.netPnl,
        grade: report.grade,
        finalBalance: finalState.balance,
      },
    };
  },
});
