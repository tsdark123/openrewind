// =============================================================================
// Compact semantic-intent extraction and validation.
//
// Phase 4 replaces the expensive full-AgentPlan llama3.1:8b planner with a
// small, fast llama3.2 JSON extraction that returns a `SemanticIntent`. A
// deterministic compiler then turns the intent into an `AgentPlan`, validates
// it, and executes it.
//
// Phase 5 adds a bounded contextReference so anaphoric requests ("do that again",
// "same timeframe", "the previous candle") are represented structurally instead
// of relying on a growing list of English phrase checks.
// =============================================================================

import { agentTrace } from './config';
import { orionChat, ORION_AGENT_MODEL, type OrionChatMessage } from '../client';
import { parseChartCommand, extractTimes } from '../planner';
import {
  type ActionDimension,
  ALL_ACTION_DIMENSIONS,
  INHERIT_FIELD_TO_DIMENSION,
  getRequestedDimensions,
} from './dimensions';
import type {
  ChartActionIntent,
  SemanticIntent,
  SemanticPlayback,
  ContextReference,
  ContextReferenceSource,
  ContextReferenceMode,
  InheritableField,
  ExecutionContextStore,
} from './types';

// Re-export the moved types so existing consumers keep working.
export type {
  ChartActionIntent,
  ClarificationIntent,
  UnsupportedIntent,
  SemanticIntent,
  SemanticDate,
  SemanticPlayback,
  DateKind,
  PlaybackAction,
  FinalQuery,
  ContextReference,
} from './types';

export interface RequestContext {
  /** Actionable dimensions detected in the original request (e.g. symbol, date, timeframe). */
  dimensions: string[];
  /** Dimensions that the deterministic parser did NOT cover. */
  missing: string[];
  /** Base date for relative date resolution and date-request detection. */
  baseDate?: string;
  /** Ticker list for computing requested dimensions when a pre-computed list is not supplied. */
  availableTickers?: string[];
  /** Symbol aliases for the ticker-list fallback. */
  symbolAliases?: Record<string, string>;
  /** Human-readable details for each detected dimension, when available. */
  signals?: Record<string, string | undefined>;
  /** Short note about what the deterministic parser produced, if anything. */
  parserNote?: string;
}

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
            direction: { enum: ['forward', 'backward'], description: 'only for play_until; default forward' },
          },
        },
        finalQuery: { enum: ['current_candle', 'candle_at_time', 'compare_candles'] },
        queryTime: { type: 'string', description: 'HH:MM; only for candle_at_time' },
        previousSymbol: { type: 'boolean' },
        compare: {
          type: 'object',
          additionalProperties: false,
          required: ['left', 'right'],
          properties: {
            left: {
              type: 'object',
              additionalProperties: false,
              required: ['source'],
              properties: {
                source: { enum: ['latest_returned_candle', 'previous_returned_candle', 'current_chart_candle', 'market_time'] },
                marketTime: { type: 'string', description: 'HH:MM; only for market_time' },
              },
            },
            right: {
              type: 'object',
              additionalProperties: false,
              required: ['source'],
              properties: {
                source: { enum: ['latest_returned_candle', 'previous_returned_candle', 'current_chart_candle', 'market_time'] },
                marketTime: { type: 'string', description: 'HH:MM; only for market_time' },
              },
            },
          },
        },
        contextReference: {
          type: 'object',
          additionalProperties: false,
          required: ['source'],
          properties: {
            source: { enum: ['latest_successful_action', 'latest_failed_action', 'latest_returned_candle'] },
            mode: { enum: ['repeat', 'inherit', 'use_as_target', 'anchor_relative_date'] },
            inherit: {
              type: 'array',
              items: { enum: ['date', 'timeframe', 'seekTime', 'relativeSeekMinutes', 'playback', 'finalQuery'] },
            },
          },
        },
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

export function buildIntentExtractionPrompt(executionLog?: ExecutionContextStore): string {
  const recentActions = executionLog ? executionLog.renderForPrompt({ maxActions: 3, includeCandles: true }) : null;

  const sections = [
    'You are a compact intent parser for OpenRewind. Respond with one minified JSON object.',
    'Do not write prose, markdown, or the literal string "<today>".',
    '',
    'Schema:',
    semanticIntentSchemaJson(),
    '',
    'Rules:',
    '- Map company names to tickers: AAPL, MSFT, NVDA.',
    '- "prior trading session" -> date:{"kind":"relative_trading","count":1,"direction":"backward"}. No date value.',
    '- "next trading session" -> date:{"kind":"relative_trading","count":1,"direction":"forward"}.',
    '- "N-minute bars" -> timeframeMinutes:N (e.g. 15m -> 15).',
    '- "quarter past X" -> seekTime:"X:15".',
    '- "park the replay at X" means seekTime:X (do not pause).',
    '- "move the replay X minutes earlier/ago" -> relativeSeekMinutes:-X. "X minutes later/forward" -> relativeSeekMinutes:+X.',
    '- "take me back to the previous stock" -> previousSymbol:true.',
    '- "tell me what candle I\'m on" -> finalQuery:"current_candle".',
    '- "give me the bar at X" -> finalQuery:"candle_at_time", queryTime:X.',
    '- "give me the bar I land on" or "what bar is that" -> finalQuery:"current_candle". No queryTime.',
    '- "compare this candle with the previous candle you reported" -> finalQuery:"compare_candles", compare:{"left":{"source":"latest_returned_candle"},"right":{"source":"previous_returned_candle"}}.',
    '- "compare the current chart candle with the last candle you reported" -> finalQuery:"compare_candles", compare:{"left":{"source":"current_chart_candle"},"right":{"source":"latest_returned_candle"}}.',
    '- "compare the 11:30 candle with the 11:00 candle" -> finalQuery:"compare_candles", compare:{"left":{"source":"market_time","marketTime":"11:30"},"right":{"source":"market_time","marketTime":"11:00"}}.',
    '- queryTime must be a clock time (HH:MM), never a phrase like "the bar" or "30 minutes earlier".',
    '- Do NOT set playback unless the user explicitly says play, pause, or play_until.',
    '- playback play_until with an end time -> {"action":"play_until","untilTime":"HH:MM"}.',
    '- If the request is genuinely missing required info, return {"kind":"clarification","message":"..."}.',
    '- If the operation cannot be represented (e.g. VWAP, backtest), return {"kind":"unsupported","message":"..."}.',
    '',
    'Context reference rules:',
    '- If the user refers to a prior action with "do that again", "repeat that", or "again", set contextReference:{"source":"latest_successful_action","mode":"repeat"}.',
    '- If the user says "same timeframe", "same date as before", or "use the same X", set contextReference:{"source":"latest_successful_action","mode":"inherit","inherit":["X"]} where X is one or more of date/timeframe/seekTime/relativeSeekMinutes/playback/finalQuery.',
    '- If the user says "one session before that" or "prior session to that", set contextReference:{"source":"latest_successful_action","mode":"anchor_relative_date"} and date:{"kind":"relative_trading","count":1,"direction":"backward"}.',
    '- If the user says "go back to the candle we were discussing" or "the previous candle", set contextReference:{"source":"latest_returned_candle","mode":"use_as_target"}.',
    '- Explicit user values always win over inherited values. Do not include a field in "inherit" if the user gave a new value for it.',
    '- If the reference cannot be resolved (no prior action/candle), return clarification.',
    '',
  ];

  if (recentActions) {
    sections.push('RECENT ACTIONS');
    sections.push(recentActions);
    sections.push('');
  }

  sections.push(
    'Examples:',
    '- "set me up on <SYMBOL> for the prior trading session, use N-minute bars, park the replay at HH:MM and tell me what candle I\'m on" -> {"kind":"chart_action","symbol":"<SYMBOL>","date":{"kind":"relative_trading","count":1,"direction":"backward"},"timeframeMinutes":N,"seekTime":"HH:MM","finalQuery":"current_candle"}',
    '- "move the replay 30 minutes earlier and give me the bar" -> {"kind":"chart_action","relativeSeekMinutes":-30,"finalQuery":"current_candle"}',
    '- "take me back to the previous stock" -> {"kind":"chart_action","previousSymbol":true}',
    '- "Do that again on <SYMBOL>" -> {"kind":"chart_action","symbol":"<SYMBOL>","contextReference":{"source":"latest_successful_action","mode":"repeat"}}',
    '- "Use the same timeframe on <SYMBOL>" -> {"kind":"chart_action","symbol":"<SYMBOL>","contextReference":{"source":"latest_successful_action","mode":"inherit","inherit":["timeframe"]}}',
    '- "Use the same timeframe but go to the prior trading session" -> {"kind":"chart_action","date":{"kind":"relative_trading","count":1,"direction":"backward"},"contextReference":{"source":"latest_successful_action","mode":"inherit","inherit":["timeframe"]}}',
    '- "Go back to the candle we were discussing" -> {"kind":"chart_action","contextReference":{"source":"latest_returned_candle","mode":"use_as_target"}}',
    '- "Compare this candle with the previous candle you reported" -> {"kind":"chart_action","finalQuery":"compare_candles","compare":{"left":{"source":"latest_returned_candle"},"right":{"source":"previous_returned_candle"}}}',
    '- "Compare the current chart candle with the last candle you reported" -> {"kind":"chart_action","finalQuery":"compare_candles","compare":{"left":{"source":"current_chart_candle"},"right":{"source":"latest_returned_candle"}}}',
    '- "Compare the 11:30 candle with the 11:00 candle" -> {"kind":"chart_action","finalQuery":"compare_candles","compare":{"left":{"source":"market_time","marketTime":"11:30"},"right":{"source":"market_time","marketTime":"11:00"}}}',
    '- "Move it over there." -> {"kind":"clarification","message":"Where should I move it?"}',
    '- "Add VWAP and backtest a crossover." -> {"kind":"unsupported","message":"VWAP and backtest crossover are not supported."}',
    '',
    'Respond with minified JSON.'
  );

  return sections.join('\n');
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

const CONTEXT_REFERENCE_SOURCES: Set<ContextReferenceSource> = new Set([
  'latest_successful_action',
  'latest_failed_action',
  'latest_returned_candle',
]);

const CONTEXT_REFERENCE_MODES: Set<ContextReferenceMode> = new Set([
  'repeat',
  'inherit',
  'use_as_target',
  'anchor_relative_date',
]);

const COMPARE_SIDE_SOURCES: Set<import('./types').CompareSideSource> = new Set([
  'latest_returned_candle',
  'previous_returned_candle',
  'current_chart_candle',
  'market_time',
]);

const INHERITABLE_FIELDS_SET: Set<InheritableField> = new Set([
  'date',
  'timeframe',
  'seekTime',
  'relativeSeekMinutes',
  'playback',
  'finalQuery',
]);

export interface IntentValidationResult {
  ok: true;
  intent: SemanticIntent;
}

export interface IntentValidationError {
  ok: false;
  error: string;
}

function validateContextReference(raw: unknown): ContextReference | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'contextReference must be an object.';
  }
  const obj = raw as Record<string, unknown>;
  const err = hasUnknownFields(obj, new Set(['source', 'mode', 'inherit']));
  if (err) return err;

  if (!('source' in obj)) return 'contextReference requires a source.';
  const source = obj.source;
  if (!CONTEXT_REFERENCE_SOURCES.has(source as ContextReferenceSource)) {
    return `Unknown contextReference source "${String(source)}".`;
  }

  const ref: ContextReference = { source: source as ContextReferenceSource };

  if ('mode' in obj) {
    const mode = obj.mode;
    if (!CONTEXT_REFERENCE_MODES.has(mode as ContextReferenceMode)) {
      return `Unknown contextReference mode "${String(mode)}".`;
    }
    ref.mode = mode as ContextReferenceMode;
  }

  if ('inherit' in obj) {
    const inherit = obj.inherit;
    if (!Array.isArray(inherit) || inherit.length === 0) {
      return 'contextReference.inherit must be a non-empty array.';
    }
    const fields: InheritableField[] = [];
    for (const item of inherit) {
      if (!INHERITABLE_FIELDS_SET.has(item as InheritableField)) {
        return `Unknown inheritable field "${String(item)}".`;
      }
      fields.push(item as InheritableField);
    }
    ref.inherit = fields;
  }

  if (ref.mode === 'inherit' && !ref.inherit) {
    return 'contextReference mode "inherit" requires an inherit array.';
  }

  return ref;
}

function validateCompareSide(raw: unknown, side: 'left' | 'right'): import('./types').CompareSide | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `compare.${side} must be an object.`;
  }
  const obj = raw as Record<string, unknown>;
  const err = hasUnknownFields(obj, new Set(['source', 'marketTime']));
  if (err) return `compare.${side} ${err}`;

  if (!('source' in obj)) return `compare.${side} requires a source.`;
  const source = obj.source;
  if (!COMPARE_SIDE_SOURCES.has(source as import('./types').CompareSideSource)) {
    return `Unknown compare.${side} source "${String(source)}".`;
  }

  const sideObj: import('./types').CompareSide = { source: source as import('./types').CompareSideSource };

  if (source === 'market_time') {
    if (typeof obj.marketTime !== 'string' || !isValidTime(obj.marketTime)) {
      return `compare.${side} market_time requires a valid HH:MM marketTime.`;
    }
    sideObj.marketTime = obj.marketTime;
  } else if ('marketTime' in obj) {
    return `compare.${side} marketTime is only valid for source "market_time".`;
  }

  return sideObj;
}

function validateCompare(raw: unknown): import('./types').CompareSides | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'compare must be an object.';
  }
  const obj = raw as Record<string, unknown>;
  const err = hasUnknownFields(obj, new Set(['left', 'right']));
  if (err) return `compare ${err}`;

  if (!('left' in obj)) return 'compare requires a left side.';
  if (!('right' in obj)) return 'compare requires a right side.';

  const left = validateCompareSide(obj.left, 'left');
  if (typeof left === 'string') return left;
  const right = validateCompareSide(obj.right, 'right');
  if (typeof right === 'string') return right;

  return { left, right };
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
    'playback', 'finalQuery', 'queryTime', 'previousSymbol', 'contextReference', 'compare',
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
    const pbErr = hasUnknownFields(p, new Set(['action', 'speed', 'untilTime', 'direction']));
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

    if ('direction' in p) {
      if (action !== 'play_until') {
        return { ok: false, error: 'playback.direction is only valid for play_until.' };
      }
      const direction = p.direction;
      if (direction !== 'forward' && direction !== 'backward') {
        return { ok: false, error: 'playback.direction must be "forward" or "backward".' };
      }
      playback.direction = direction;
    }

    intent.playback = playback;
  }

  if ('finalQuery' in obj) {
    const value = obj.finalQuery;
    if (value !== 'current_candle' && value !== 'candle_at_time' && value !== 'compare_candles') {
      return { ok: false, error: 'finalQuery must be "current_candle", "candle_at_time", or "compare_candles".' };
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

  if ('contextReference' in obj) {
    const validation = validateContextReference(obj.contextReference);
    if (typeof validation === 'string') {
      return { ok: false, error: validation };
    }
    intent.contextReference = validation;
  }

  if ('compare' in obj) {
    const validation = validateCompare(obj.compare);
    if (typeof validation === 'string') {
      return { ok: false, error: validation };
    }
    intent.compare = validation;
  }

  if (intent.finalQuery === 'candle_at_time' && !intent.queryTime) {
    // The model tried "candle_at_time" with a non-clock phrase like "the bar I land on".
    // Fall back to current_candle.
    intent.finalQuery = 'current_candle';
  }

  if (intent.finalQuery === 'compare_candles') {
    const hasExplicitCompare = intent.compare && intent.compare.left && intent.compare.right;
    if (!hasExplicitCompare && (!intent.contextReference || intent.contextReference.source !== 'latest_returned_candle')) {
      return { ok: false, error: 'compare_candles requires either an explicit compare object or a latest_returned_candle contextReference.' };
    }
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
    !intent.finalQuery &&
    !intent.contextReference
  ) {
    return { ok: false, error: 'chart_action must include at least one actionable field.' };
  }

  return { ok: true, intent };
}

// ---------------------------------------------------------------------------
// Pre-validation grounding / sanitation
//
// Before strict validation, remove model-produced optional dimensions that were
// not requested or grounded in the user's text. This prevents an unrequested
// malformed optional field (e.g. timeframeMinutes: 0, a hallucinated date) from
// aborting the pipeline before sanitizeIntentGrounding can resolve or strip it.
// ---------------------------------------------------------------------------

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isDateInText(value: string, text: string): boolean {
  const nValue = normalizeForMatch(value);
  const nText = normalizeForMatch(text);
  if (!nValue || !nText) return false;
  if (nText.includes(nValue)) return true;

  // The user may write "7/30", "7/30/2026", "30/7/2026", etc. while the model
  // normalizes to an ISO date. Match month/day with a separator and an optional
  // year so abbreviated explicit dates are still treated as user-provided, while
  // avoiding false positives from bare 4-digit numbers like "1115".
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const month = m[2];
  const day = m[3];
  const dayNoPad = String(parseInt(day, 10));
  const monthNoPad = String(parseInt(month, 10));
  const patterns = [
    new RegExp(`\\b(?:\\d{4}[-/\\s.])?0?${monthNoPad}[-/\\s.]0?${dayNoPad}\\b`),
    new RegExp(`\\b0?${dayNoPad}[-/\\s.]0?${monthNoPad}(?:[-/\\s.]\\d{4})?\\b`),
  ];
  return patterns.some((re) => re.test(text));
}

function isTimeInText(value: string, text: string): boolean {
  const nValue = normalizeForMatch(value);
  const nText = normalizeForMatch(text);
  if (!nValue || !nText) return false;
  if (nText.includes(nValue)) return true;

  // The user may write a colloquial time and the model may normalize it (e.g.
  // "quarter past X" -> "X:15").  Trust explicit time extraction to decide
  // whether any time expression was said.
  return extractTimes(text).length > 0;
}

function isNumberInText(value: number, text: string): boolean {
  if (!text) return false;
  const re = new RegExp(`(?:^|\\D)${String(value)}(?!\\d)`, 'i');
  return re.test(text);
}

function isPlaybackActionGrounded(action: unknown, text: string): boolean {
  if (typeof action !== 'string') return false;
  const t = text.toLowerCase();
  if (action === 'play') return /\bplay\b/i.test(text) && !/\bplay\s+until\b/i.test(text) && !/\buntil\b/i.test(t);
  if (action === 'play_until') return /\b(?:play\s+until|play\s+till|until\s+\d|till\s+\d)\b/i.test(text);
  if (action === 'pause') return /\b(?:pause|stop|halt)\b/i.test(text);
  return false;
}

function isFinalQueryGrounded(finalQuery: unknown, text: string): boolean {
  const t = text.toLowerCase();
  if (finalQuery === 'current_candle') {
    return /\b(?:candle|bar|price|value|worth)\b/i.test(text) || /\b(?:current|now|latest)\b/i.test(t);
  }
  if (finalQuery === 'candle_at_time') {
    return extractTimes(text).length > 0 && /\b(?:candle|bar|price|value|worth)\b/i.test(text);
  }
  if (finalQuery === 'compare_candles') {
    return /\bcompare\b/i.test(t) || /\b(?:this|the|that)\s+candle\s+(?:with|to|against)\s+(?:the\s+)?(?:previous|last|prior|reported)\b/i.test(t);
  }
  return false;
}

function isSymbolInText(value: string, text: string): boolean {
  const nValue = normalizeForMatch(value);
  const nText = normalizeForMatch(text);
  if (!nValue || !nText) return false;
  return nText.includes(nValue);
}

function isPreviousSymbolGrounded(text: string): boolean {
  return /\b(?:take me back|previous symbol|previous stock|stock i was just on|was just on)\b/i.test(text);
}

function isPlaybackControlGrounded(text: string): boolean {
  return /\b(?:play|pause|rewind|fast[-\s]?forward|fastforward|speed up|slow down|set\s+speed)\b/.test(text);
}

function getContextAllowedDimensions(ref: ContextReference): Set<ActionDimension> {
  const dims = new Set<ActionDimension>();
  if (ref.mode === 'repeat') {
    for (const d of ALL_ACTION_DIMENSIONS) dims.add(d);
  } else if (ref.mode === 'inherit' && ref.inherit) {
    for (const f of ref.inherit) {
      const dim = INHERIT_FIELD_TO_DIMENSION[f];
      if (dim) dims.add(dim);
    }
  } else if (ref.mode === 'use_as_target') {
    dims.add('absoluteTime');
    dims.add('symbol');
    dims.add('date');
    dims.add('timeframe');
    dims.add('candleQuery');
  } else if (ref.mode === 'anchor_relative_date') {
    dims.add('date');
  }
  return dims;
}

const FIELD_TO_DIMENSION: Record<string, ActionDimension | undefined> = {
  symbol: 'symbol',
  previousSymbol: 'previousSymbol',
  date: 'date',
  timeframeMinutes: 'timeframe',
  seekTime: 'absoluteTime',
  relativeSeekMinutes: 'relativeSeek',
  playback: 'playbackControl',
  finalQuery: 'candleQuery',
  queryTime: 'absoluteTime',
};

function buildRequestedSet(text: string, raw: Record<string, unknown>, requestContext?: RequestContext): Set<ActionDimension> {
  const requested = new Set<ActionDimension>();

  if (requestContext?.dimensions) {
    for (const d of requestContext.dimensions) {
      if (ALL_ACTION_DIMENSIONS.includes(d as ActionDimension)) {
        requested.add(d as ActionDimension);
      }
    }
  } else {
    // Fallback: compute dimensions from the text alone when the orchestrator has
    // not pre-computed them (e.g. direct unit tests).
    const tickers = requestContext?.availableTickers ?? [];
    const aliases = requestContext?.symbolAliases;
    const cmd = parseChartCommand(text, tickers, aliases, requestContext?.baseDate);
    for (const d of getRequestedDimensions(text, cmd, requestContext?.baseDate)) {
      requested.add(d);
    }
  }

  // Context references authorize inherited dimensions even when the current text
  // does not explicitly name them.
  const ref = raw.contextReference as ContextReference | undefined;
  if (ref) {
    for (const d of getContextAllowedDimensions(ref)) {
      requested.add(d);
    }
  }

  return requested;
}

function isFieldMalformed(
  field: string,
  value: unknown
): boolean {
  if (field === 'symbol') {
    return typeof value !== 'string' || looksLikeInjection(value);
  }

  if (field === 'previousSymbol') {
    return value !== true;
  }

  if (field === 'date') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
    const d = value as Record<string, unknown>;
    if (d.kind !== 'absolute' && d.kind !== 'relative_trading') return true;
    if (d.kind === 'absolute') {
      const v = d.value;
      return typeof v !== 'string' || !isValidDate(v) || 'count' in d || 'direction' in d;
    }
    // relative_trading
    if ('value' in d) return true;
    const count = d.count;
    if (!isInteger(count) || count < 1) return true;
    const dir = d.direction;
    return dir !== 'backward' && dir !== 'forward';
  }

  if (field === 'timeframeMinutes') {
    return !isInteger(value) || value < 1;
  }

  if (field === 'seekTime' || field === 'queryTime') {
    return typeof value !== 'string' || !isValidTime(value) || looksLikeInjection(value);
  }

  if (field === 'relativeSeekMinutes') {
    return !isInteger(value);
  }

  if (field === 'playback') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
    const p = value as Record<string, unknown>;
    if (p.action !== 'play' && p.action !== 'pause' && p.action !== 'play_until') return true;
    if ('untilTime' in p) {
      if (p.action !== 'play_until') return true;
      if (typeof p.untilTime !== 'string' || !isValidTime(p.untilTime)) return true;
    }
    if ('speed' in p) {
      if (!isInteger(p.speed) || p.speed < 1) return true;
    }
    if ('direction' in p) {
      if (p.action !== 'play_until') return true;
      if (p.direction !== 'forward' && p.direction !== 'backward') return true;
    }
    return false;
  }

  if (field === 'finalQuery') {
    return value !== 'current_candle' && value !== 'candle_at_time' && value !== 'compare_candles';
  }

  if (field === 'contextReference') {
    return typeof validateContextReference(value) === 'string';
  }

  return false;
}

function isFieldGrounded(
  field: string,
  value: unknown,
  text: string
): boolean {
  if (value === undefined) return true;

  if (field === 'date') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const d = value as Record<string, unknown>;
    if (d.kind === 'absolute') {
      return typeof d.value === 'string' && isDateInText(d.value, text);
    }
    if (d.kind === 'relative_trading') {
      const count = typeof d.count === 'number' ? d.count : undefined;
      if (count !== undefined && isNumberInText(count, text)) return true;
      const dir = d.direction;
      if (dir === 'backward') return /\b(?:ago|back|before|prior|previous|last)\b/i.test(text);
      if (dir === 'forward') return /\b(?:ahead|forward|next|tomorrow)\b/i.test(text);
      return false;
    }
    return false;
  }

  if (field === 'timeframeMinutes') {
    return typeof value === 'number' && isNumberInText(value, text);
  }

  if (field === 'seekTime' || field === 'queryTime') {
    return typeof value === 'string' && isTimeInText(value, text);
  }

  if (field === 'relativeSeekMinutes') {
    return typeof value === 'number' && isNumberInText(Math.abs(value), text);
  }

  if (field === 'symbol') {
    return typeof value === 'string' && isSymbolInText(value, text);
  }

  if (field === 'previousSymbol') {
    return value === true && isPreviousSymbolGrounded(text);
  }

  if (field === 'finalQuery') {
    return isFinalQueryGrounded(value, text);
  }

  if (field === 'playback' && value && typeof value === 'object' && !Array.isArray(value)) {
    const pb = value as Record<string, unknown>;
    if (!isPlaybackActionGrounded(pb.action, text)) return false;
    if (pb.untilTime !== undefined && !isTimeInText(String(pb.untilTime), text)) return false;
    if (pb.speed !== undefined && typeof pb.speed === 'number' && !isNumberInText(pb.speed, text) && !isPlaybackControlGrounded(text)) return false;
    if (pb.direction !== undefined) {
      const dir = String(pb.direction);
      if (dir === 'forward' && !/\b(?:forward|ahead|next)\b/i.test(text)) return false;
      if (dir === 'backward' && !/\b(?:back|backward|rewind|reverse|prior)\b/i.test(text)) return false;
    }
    return true;
  }

  if (field === 'contextReference') {
    return true;
  }

  return false;
}

export function preValidateSanitize(raw: Record<string, unknown>, text: string, requestContext?: RequestContext): void {
  if (raw.kind !== 'chart_action') return;

  const requested = buildRequestedSet(text, raw, requestContext);

  // Normalize well-known nested objects: remove hallucinated extra fields that
  // are not valid for the selected kind so they do not trigger an unnecessary
  // repair loop. The user value itself is preserved.
  const date = raw.date as Record<string, unknown> | undefined;
  if (date && typeof date === 'object' && !Array.isArray(date)) {
    if (date.kind === 'absolute') {
      delete date.count;
      delete date.direction;
    } else if (date.kind === 'relative_trading') {
      delete date.value;
    }
  }

  // Strip top-level optional fields that are:
  //   - not requested by the user,
  //   - not grounded in the original text,
  //   - AND malformed (would fail strict validation).
  // Valid-but-ungrounded fields are left for sanitizeIntentGrounding, which can
  // either keep them or strip them safely. This prevents an unrequested
  // malformed optional field from killing an otherwise valid request without
  // pre-empting the post-validation grounding stage.
  for (const [field, dim] of Object.entries(FIELD_TO_DIMENSION)) {
    if (!(field in raw)) continue;
    if (dim && requested.has(dim)) continue;
    if (isFieldGrounded(field, raw[field], text)) continue;
    if (!isFieldMalformed(field, raw[field])) continue;

    agentTrace('llm intent sanitize', { reason: 'ungrounded malformed optional field', field, value: raw[field] });
    delete raw[field];
  }

  // compare is only valid with compare_candles and a compare request.
  if ('compare' in raw && raw.finalQuery !== 'compare_candles') {
    agentTrace('llm intent sanitize', { reason: 'ungrounded compare', value: raw.compare });
    delete raw.compare;
  }

  // If a contextReference is present, it was already used to authorize dimensions
  // and is resolved by resolveContextReference later.
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

export interface IntentExtractionOptions {
  /** Bounded verified runtime memory to render into the prompt. */
  executionLog?: ExecutionContextStore;
  /** Optional deterministic-parser context for diagnostics. */
  requestContext?: RequestContext;
}

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

export async function extractSemanticIntent(
  text: string,
  opts: IntentExtractionOptions = {}
): Promise<IntentExtractionResult> {
  const start = Date.now();
  agentTrace('llm intent start', { text, model: ORION_AGENT_MODEL });

  const system = buildIntentExtractionPrompt(opts.executionLog);
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
        options: { temperature: 0, seed: 42, num_predict: 160 },
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      agentTrace('llm intent offline', err);
      return { ok: false, kind: 'offline', message: `The agent model is not available right now (${err}).`, elapsed: Date.now() - start };
    }

    const callElapsed = Date.now() - callStart;
    agentTrace('llm intent response', { attempt, elapsed: callElapsed, contentLength: response.content.length });

    let raw = parseIntentJson(response.content);
    if (raw === undefined) {
      if (attempt === MAX_REPAIR_ATTEMPTS) {
        return { ok: false, kind: 'invalid', message: 'Could not parse a valid JSON intent.', elapsed: Date.now() - start };
      }
      lastValidation = 'Response was not valid JSON.';
      messages.push({ role: 'user', content: buildIntentRepairPrompt(lastValidation) });
      continue;
    }

    // Strip ungrounded/hallucinated optional fields before validation so that
    // unrequested malformed values do not abort the pipeline. Genuinely
    // user-provided dimensions (explicit values in the text or pre-computed
    // requested dimensions from the orchestrator) are preserved.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      preValidateSanitize(raw as Record<string, unknown>, text, opts.requestContext);
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

    return { ok: true, intent, elapsed: Date.now() - start };
  }

  return { ok: false, kind: 'invalid', message: 'Could not extract a valid intent.', elapsed: Date.now() - start };
}
