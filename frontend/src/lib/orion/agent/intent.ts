// =============================================================================
// Compact semantic-intent extraction and validation.
//
// Phase 4 replaces the expensive full-AgentPlan llama3.1:8b planner with a
// small, fast llama3.2 JSON extraction that returns a `SemanticIntent`. A
// deterministic compiler then turns the intent into an `AgentPlan`, validates
// it, and executes it.
//
// This file is the single source of truth for the intent type, its JSON schema,
// validation rules and the LLM extraction prompt.
// =============================================================================

import { agentTrace } from './config';
import { orionChat, ORION_AGENT_MODEL, type OrionChatMessage } from '../client';

export interface RequestContext {
  /** Actionable dimensions detected in the original request (e.g. symbol, date, timeframe). */
  dimensions: string[];
  /** Dimensions that the deterministic parser did NOT cover. */
  missing: string[];
  /** Human-readable details for each detected dimension, when available. */
  signals?: Record<string, string | undefined>;
  /** Short note about what the deterministic parser produced, if anything. */
  parserNote?: string;
}

// ---------------------------------------------------------------------------
// Semantic intent schema — one versioned type and runtime schema.
// ---------------------------------------------------------------------------

export type DateKind = 'absolute' | 'relative_trading';
export type PlaybackAction = 'play' | 'pause' | 'play_until';
export type FinalQuery = 'current_candle' | 'candle_at_time';

export interface SemanticDate {
  kind: DateKind;
  value?: string; // YYYY-MM-DD; only valid for kind: 'absolute'
  count?: number; // positive integer; only valid for kind: 'relative_trading'
  direction?: 'backward' | 'forward'; // only valid for kind: 'relative_trading'
}

export interface SemanticPlayback {
  action: PlaybackAction;
  speed?: number;
  untilTime?: string; // HH:MM; only for play_until
}

export interface ChartActionIntent {
  kind: 'chart_action';
  symbol?: string;
  date?: SemanticDate;
  timeframeMinutes?: number;
  seekTime?: string; // HH:MM
  relativeSeekMinutes?: number; // positive = forward, negative = backward
  playback?: SemanticPlayback;
  finalQuery?: FinalQuery;
  queryTime?: string; // HH:MM; required when finalQuery is 'candle_at_time'
  previousSymbol?: boolean;
}

export interface ClarificationIntent {
  kind: 'clarification';
  message: string;
}

export interface UnsupportedIntent {
  kind: 'unsupported';
  message: string;
}

export type SemanticIntent = ChartActionIntent | ClarificationIntent | UnsupportedIntent;

// ---------------------------------------------------------------------------
// JSON Schema used in the prompt and for runtime validation.
// ---------------------------------------------------------------------------

export const SEMANTIC_INTENT_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { const: 'chart_action' },
        symbol: { type: 'string' },
        date: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { enum: ['absolute', 'relative_trading'] },
            value: { type: 'string', description: 'YYYY-MM-DD; only for absolute dates' },
            count: { type: 'integer', minimum: 1, description: 'only for relative_trading' },
            direction: { enum: ['backward', 'forward'], description: 'only for relative_trading' },
          },
        },
        timeframeMinutes: { type: 'integer', minimum: 1 },
        seekTime: { type: 'string', description: 'HH:MM' },
        relativeSeekMinutes: { type: 'integer', description: 'positive forward, negative backward' },
        playback: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { enum: ['play', 'pause', 'play_until'] },
            speed: { type: 'integer', minimum: 1 },
            untilTime: { type: 'string', description: 'HH:MM; only for play_until' },
          },
        },
        finalQuery: { enum: ['current_candle', 'candle_at_time'] },
        queryTime: { type: 'string', description: 'HH:MM; only for candle_at_time' },
        previousSymbol: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'message'],
      properties: {
        kind: { const: 'clarification' },
        message: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'message'],
      properties: {
        kind: { const: 'unsupported' },
        message: { type: 'string' },
      },
    },
  ],
};

// Stringified, compact version for the LLM system prompt.
export function semanticIntentSchemaJson(): string {
  return JSON.stringify(SEMANTIC_INTENT_SCHEMA).replace(/"/g, '"');
}

// ---------------------------------------------------------------------------
// Prompt generation
// ---------------------------------------------------------------------------

export function buildIntentExtractionPrompt(): string {
  return [
    'You are a compact intent parser for OpenRewind. Respond with one minified JSON object.',
    'Do not write prose, markdown, or the literal string "<today>".',
    '',
    'Schema:',
    semanticIntentSchemaJson(),
    '',
    'Rules:',
    '- Map company names to tickers: AAPL, MSFT, NVDA.',
    '- "prior trading session" -> date:{"kind":"relative_trading","count":1,"direction":"backward"}. No date value.',
    '- "fifteen-minute bars" -> timeframeMinutes:15.',
    '- "quarter past eleven" -> seekTime:"11:15".',
    '- "park the replay at X" means seekTime:X (do not pause).',
    '- "move the replay X minutes earlier/ago" -> relativeSeekMinutes:-X. "X minutes later/forward" -> relativeSeekMinutes:+X.',
    '- "take me back to the previous stock" -> previousSymbol:true.',
    '- "tell me what candle I\'m on" -> finalQuery:"current_candle".',
    '- "give me the bar at X" -> finalQuery:"candle_at_time", queryTime:X.',
    '- "give me the bar I land on" or "what bar is that" -> finalQuery:"current_candle". No queryTime.',
    '- queryTime must be a clock time (HH:MM), never a phrase like "the bar" or "30 minutes earlier".',
    '- Do NOT set playback unless the user explicitly says play, pause, or play_until.',
    '- playback play_until with an end time -> {"action":"play_until","untilTime":"HH:MM"}.',
    '- If the request is genuinely missing required info, return {"kind":"clarification","message":"..."}.',
    '- If the operation cannot be represented (e.g. VWAP, backtest), return {"kind":"unsupported","message":"..."}.',
    '',
    'Examples:',
    '- "set me up on NVDA for the prior trading session, fifteen-minute bars, park the replay at 11:15 and tell me what candle I\'m on" -> {"kind":"chart_action","symbol":"NVDA","date":{"kind":"relative_trading","count":1,"direction":"backward"},"timeframeMinutes":15,"seekTime":"11:15","finalQuery":"current_candle"}',
    '- "move the replay 30 minutes earlier and give me the bar" -> {"kind":"chart_action","relativeSeekMinutes":-30,"finalQuery":"current_candle"}',
    '- "take me back to the previous stock" -> {"kind":"chart_action","previousSymbol":true}',
    '- "Move it over there." -> {"kind":"clarification","message":"Where should I move it?"}',
    '- "Add VWAP and backtest a crossover." -> {"kind":"unsupported","message":"VWAP and backtest crossover are not supported."}',
    '',
    'Respond with minified JSON.',
  ].join('\n');
}

export function buildIntentRepairPrompt(validationError: string): string {
  return `Your previous JSON failed validation: ${validationError}. Return a corrected, minified JSON object matching the same schema.`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = [
  /javascript:/i,
  /data:/i,
  /file:\/\//i,
  /https?:\/\//i,
  /<script\b/i,
  /eval\s*\(/i,
  /new\s+Function\s*\(/i,
  /require\s*\(/i,
  /import\s*\(/i,
  /\\\\/i, // Windows backslash paths
  /\.\./i, // path traversal
  /</i,    // no literal placeholders such as <today>
];

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function looksLikeInjection(value: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(value));
}

function isValidTime(value: string): boolean {
  const m = TIME_RE.test(value) ? value.match(TIME_RE) : null;
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h >= 0 && h < 24 && min >= 0 && min < 60;
}

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && value === d.toISOString().slice(0, 10);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function hasUnknownFields(obj: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `Unknown field "${key}"`;
  }
  return null;
}

export interface IntentValidationResult {
  ok: true;
  intent: SemanticIntent;
}

export interface IntentValidationError {
  ok: false;
  error: string;
}

export function validateSemanticIntent(raw: unknown): IntentValidationResult | IntentValidationError {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Intent must be an object.' };
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === 'clarification' || kind === 'unsupported') {
    const err = hasUnknownFields(obj, new Set(['kind', 'message']));
    if (err) return { ok: false, error: err };
    const message = obj.message;
    if (typeof message !== 'string' || !message.trim()) {
      return { ok: false, error: `${kind} requires a non-empty message.` };
    }
    if (looksLikeInjection(message)) {
      return { ok: false, error: `${kind} message contains a forbidden pattern.` };
    }
    return { ok: true, intent: { kind, message } as SemanticIntent };
  }

  if (kind !== 'chart_action') {
    return { ok: false, error: `Unknown intent kind "${String(kind)}".` };
  }

  const chartErr = hasUnknownFields(obj, new Set([
    'kind', 'symbol', 'date', 'timeframeMinutes', 'seekTime', 'relativeSeekMinutes',
    'playback', 'finalQuery', 'queryTime', 'previousSymbol',
  ]));
  if (chartErr) return { ok: false, error: chartErr };

  const intent: ChartActionIntent = { kind: 'chart_action' };

  if ('previousSymbol' in obj) {
    const value = obj.previousSymbol;
    if (typeof value !== 'boolean') {
      return { ok: false, error: 'previousSymbol must be a boolean.' };
    }
    intent.previousSymbol = value;
  }

  if ('symbol' in obj) {
    const value = obj.symbol;
    if (typeof value !== 'string') return { ok: false, error: 'symbol must be a string.' };
    if (looksLikeInjection(value)) return { ok: false, error: 'symbol contains a forbidden pattern.' };
    intent.symbol = value;
  }

  if ('date' in obj) {
    const date = obj.date;
    if (!date || typeof date !== 'object' || Array.isArray(date)) {
      return { ok: false, error: 'date must be an object.' };
    }
    const d = date as Record<string, unknown>;
    const dateErr = hasUnknownFields(d, new Set(['kind', 'value', 'count', 'direction']));
    if (dateErr) return { ok: false, error: dateErr };
    if (d.kind !== 'absolute' && d.kind !== 'relative_trading') {
      return { ok: false, error: 'date.kind must be "absolute" or "relative_trading".' };
    }
    if (d.kind === 'absolute') {
      const value = d.value;
      if (typeof value !== 'string' || !isValidDate(value)) {
        return { ok: false, error: 'absolute date requires a valid YYYY-MM-DD value.' };
      }
      if ('count' in d || 'direction' in d) {
        return { ok: false, error: 'absolute date must not include count or direction.' };
      }
      intent.date = { kind: 'absolute', value };
    } else {
      if ('value' in d) {
        return { ok: false, error: 'relative_trading date must not include a value.' };
      }
      const count = d.count;
      if (!isInteger(count) || count < 1) {
        return { ok: false, error: 'relative_trading date requires a positive integer count.' };
      }
      const direction = d.direction;
      if (direction !== 'backward' && direction !== 'forward') {
        return { ok: false, error: 'relative_trading date direction must be "backward" or "forward".' };
      }
      intent.date = { kind: 'relative_trading', count, direction };
    }
  }

  if ('timeframeMinutes' in obj) {
    const value = obj.timeframeMinutes;
    if (!isInteger(value) || value < 1) {
      return { ok: false, error: 'timeframeMinutes must be a positive integer.' };
    }
    intent.timeframeMinutes = value;
  }

  if ('seekTime' in obj) {
    const value = obj.seekTime;
    if (typeof value !== 'string' || !isValidTime(value)) {
      return { ok: false, error: 'seekTime must be a valid HH:MM string.' };
    }
    if (looksLikeInjection(value)) return { ok: false, error: 'seekTime contains a forbidden pattern.' };
    intent.seekTime = value;
  }

  if ('relativeSeekMinutes' in obj) {
    const value = obj.relativeSeekMinutes;
    if (!isInteger(value)) {
      return { ok: false, error: 'relativeSeekMinutes must be an integer.' };
    }
    intent.relativeSeekMinutes = value;
  }

  if ('playback' in obj) {
    const pb = obj.playback;
    if (!pb || typeof pb !== 'object' || Array.isArray(pb)) {
      return { ok: false, error: 'playback must be an object.' };
    }
    const p = pb as Record<string, unknown>;
    const pbErr = hasUnknownFields(p, new Set(['action', 'speed', 'untilTime']));
    if (pbErr) return { ok: false, error: pbErr };
    if (p.action !== 'play' && p.action !== 'pause' && p.action !== 'play_until') {
      return { ok: false, error: 'playback.action must be "play", "pause", or "play_until".' };
    }
    const action = p.action as SemanticPlayback['action'];
    const playback: SemanticPlayback = { action };

    if ('speed' in p) {
      const speed = p.speed;
      if (!isInteger(speed) || speed < 1) {
        return { ok: false, error: 'playback.speed must be a positive integer.' };
      }
      playback.speed = speed;
    }

    if ('untilTime' in p) {
      if (action !== 'play_until') {
        return { ok: false, error: 'playback.untilTime is only valid for play_until.' };
      }
      const untilTime = p.untilTime;
      if (typeof untilTime !== 'string' || !isValidTime(untilTime)) {
        return { ok: false, error: 'playback.untilTime must be a valid HH:MM string.' };
      }
      playback.untilTime = untilTime;
    }

    intent.playback = playback;
  }

  if ('finalQuery' in obj) {
    const value = obj.finalQuery;
    if (value !== 'current_candle' && value !== 'candle_at_time') {
      return { ok: false, error: 'finalQuery must be "current_candle" or "candle_at_time".' };
    }
    intent.finalQuery = value;
  }

  if ('queryTime' in obj) {
    const value = obj.queryTime;
    if (typeof value === 'string' && isValidTime(value)) {
      intent.queryTime = value;
    } else if (obj.finalQuery !== 'candle_at_time') {
      return { ok: false, error: 'queryTime must be a valid HH:MM string.' };
    }
  }

  if (intent.finalQuery === 'candle_at_time' && !intent.queryTime) {
    // The model tried "candle_at_time" with a non-clock phrase like "the bar I land on".
    // Fall back to current_candle.
    intent.finalQuery = 'current_candle';
  }

  // Contradictory / nonsensical combinations.
  if (intent.previousSymbol) {
    if (intent.symbol) return { ok: false, error: 'previousSymbol cannot be combined with symbol.' };
    if (intent.date) return { ok: false, error: 'previousSymbol cannot be combined with date.' };
  }

  if (intent.seekTime !== undefined && intent.relativeSeekMinutes !== undefined) {
    return { ok: false, error: 'seekTime and relativeSeekMinutes are mutually exclusive.' };
  }

  // At least one actionable field must be present for chart_action.
  if (
    !intent.symbol &&
    !intent.previousSymbol &&
    !intent.date &&
    !intent.timeframeMinutes &&
    !intent.seekTime &&
    !intent.relativeSeekMinutes &&
    !intent.playback &&
    !intent.finalQuery
  ) {
    return { ok: false, error: 'chart_action must include at least one actionable field.' };
  }

  return { ok: true, intent };
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

export type IntentExtractionResult =
  | { ok: true; intent: ChartActionIntent; elapsed: number }
  | { ok: false; kind: 'clarification' | 'unsupported' | 'invalid' | 'offline'; message: string; elapsed: number };

const MAX_REPAIR_ATTEMPTS = 1;

function parseIntentJson(content: string): unknown {
  const cleaned = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!cleaned) return undefined;
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

export async function extractSemanticIntent(text: string): Promise<IntentExtractionResult> {
  const start = Date.now();
  agentTrace('llm intent start', { text, model: ORION_AGENT_MODEL });

  const system = buildIntentExtractionPrompt();
  const messages: OrionChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];

  let lastValidation: string | null = null;

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const callStart = Date.now();
    let response;
    try {
      response = await orionChat({
        tier: 'agent',
        messages,
        format: 'json',
        options: { temperature: 0, seed: 42, num_predict: 128 },
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      agentTrace('llm intent offline', err);
      return { ok: false, kind: 'offline', message: `The agent model is not available right now (${err}).`, elapsed: Date.now() - start };
    }

    const callElapsed = Date.now() - callStart;
    agentTrace('llm intent response', { attempt, elapsed: callElapsed, contentLength: response.content.length });

    const raw = parseIntentJson(response.content);
    if (raw === undefined) {
      if (attempt === MAX_REPAIR_ATTEMPTS) {
        return { ok: false, kind: 'invalid', message: 'Could not parse a valid JSON intent.', elapsed: Date.now() - start };
      }
      lastValidation = 'Response was not valid JSON.';
      messages.push({ role: 'user', content: buildIntentRepairPrompt(lastValidation) });
      continue;
    }

    const validation = validateSemanticIntent(raw);
    if (!validation.ok) {
      if (attempt === MAX_REPAIR_ATTEMPTS) {
        return { ok: false, kind: 'invalid', message: `Invalid intent: ${validation.error}`, elapsed: Date.now() - start };
      }
      lastValidation = validation.error;
      messages.push({ role: 'user', content: buildIntentRepairPrompt(lastValidation) });
      continue;
    }

    const intent = validation.intent;
    if (intent.kind === 'clarification') {
      return { ok: false, kind: 'clarification', message: intent.message, elapsed: Date.now() - start };
    }
    if (intent.kind === 'unsupported') {
      return { ok: false, kind: 'unsupported', message: intent.message, elapsed: Date.now() - start };
    }

    return { ok: true, intent: intent as ChartActionIntent, elapsed: Date.now() - start };
  }

  return { ok: false, kind: 'invalid', message: 'Could not extract a valid intent.', elapsed: Date.now() - start };
}
