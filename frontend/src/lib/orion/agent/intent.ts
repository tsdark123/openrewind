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
import {
  parseChartCommand,
  extractTimes,
  formatTime,
  US_EQUITY_MARKET_OPEN,
  US_EQUITY_MARKET_CLOSE,
  MORNING_END,
  AFTERNOON_START,
} from '../planner';
import {
  type ActionDimension,
  ALL_ACTION_DIMENSIONS,
  INHERIT_FIELD_TO_DIMENSION,
  getRequestedDimensions,
  textRequestsAnalysis,
  textRequestsCandleQuery,
  textRequestsCandleShape,
  textRequestsDate,
  textRequestsSummary,
  textRequestsTimeframe,
  textRequestsAbsoluteTime,
  textRequestsRelativeSeek,
  textRequestsPlaybackControl,
  textRequestsPreviousSymbol,
  textRequestsContextReference,
  detectAnalysisConcepts,
  hasCompareLanguage,
  hasNonPhrasalDirection,
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
  AnalysisRequest,
  AnalysisWindow,
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
  AnalysisRequest,
  AnalysisWindow,
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

export const ANALYSIS_WINDOW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { enum: ['whole_session', 'up_to_cursor', 'time_range'] },
    fromTime: { type: 'string', description: 'HH:MM; only for time_range' },
    toTime: { type: 'string', description: 'HH:MM; only for time_range' },
  },
};

export const ANALYSIS_REQUEST_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { const: 'window_ohlc' },
        window: ANALYSIS_WINDOW_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { const: 'window_change' },
        window: ANALYSIS_WINDOW_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { const: 'window_volume' },
        window: ANALYSIS_WINDOW_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { const: 'window_compare' },
        left: ANALYSIS_WINDOW_SCHEMA,
        right: ANALYSIS_WINDOW_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { const: 'candle_shape' },
        source: { enum: ['current_chart_candle', 'market_time'], description: 'Defaults to current_chart_candle if omitted.' },
        marketTime: { type: 'string', description: 'HH:MM; only when source is market_time' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { const: 'window_summary' },
        window: ANALYSIS_WINDOW_SCHEMA,
      },
    },
  ],
};

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
        analysisRequests: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: ANALYSIS_REQUEST_SCHEMA,
        },
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
              items: { enum: ['date', 'timeframe', 'seekTime', 'relativeSeekMinutes', 'playback', 'finalQuery', 'analysisRequests'] },
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

// ---------------------------------------------------------------------------
// Compact, LLM-facing schemas derived from the runtime schemas.
// These strip `description` fields and avoid a large oneOf for analysis
// requests, while remaining compatible with validateSemanticIntent.
// ---------------------------------------------------------------------------

const COMPACT_ANALYSIS_WINDOW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { enum: ['whole_session', 'up_to_cursor', 'time_range'] },
    fromTime: { type: 'string' },
    toTime: { type: 'string' },
  },
};

const ANALYSIS_REQUEST_KINDS = [
  'window_ohlc',
  'window_change',
  'window_volume',
  'window_compare',
  'candle_shape',
  'window_summary',
];

function compactWindowItemProps(kinds: string[]): Record<string, unknown> {
  const props: Record<string, unknown> = { kind: { enum: kinds } };
  const needsWindow = kinds.some((k) => ['window_ohlc', 'window_change', 'window_volume', 'window_summary'].includes(k));
  const needsCandle = kinds.includes('candle_shape');
  const needsCompare = kinds.includes('window_compare');
  if (needsWindow) props.window = COMPACT_ANALYSIS_WINDOW_SCHEMA;
  if (needsCandle) {
    props.source = { enum: ['current_chart_candle', 'market_time'] };
    props.marketTime = { type: 'string' };
  }
  if (needsCompare) {
    props.left = COMPACT_ANALYSIS_WINDOW_SCHEMA;
    props.right = COMPACT_ANALYSIS_WINDOW_SCHEMA;
  }
  return props;
}

function buildCompactAnalysisRequestSchema(kinds?: string[]): Record<string, unknown> {
  const effectiveKinds = kinds && kinds.length > 0 ? kinds : ANALYSIS_REQUEST_KINDS;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: compactWindowItemProps(effectiveKinds),
  };
}

const COMPACT_ANALYSIS_REQUEST_SCHEMA = buildCompactAnalysisRequestSchema();

const COMPACT_COMPARE_SIDE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: { type: 'string' },
    marketTime: { type: 'string' },
  },
};

const COMPARE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['left', 'right'],
  properties: {
    left: COMPACT_COMPARE_SIDE_SCHEMA,
    right: COMPACT_COMPARE_SIDE_SCHEMA,
  },
};

const ALL_CHART_ACTION_PROPERTIES: Record<string, unknown> = {
  symbol: { type: 'string' },
  date: {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { enum: ['absolute', 'relative_trading'] },
      value: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
      direction: { enum: ['backward', 'forward'] },
    },
  },
  timeframeMinutes: { type: 'integer', minimum: 1 },
  seekTime: { type: 'string' },
  relativeSeekMinutes: { type: 'integer' },
  playback: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { enum: ['play', 'pause', 'play_until'] },
      speed: { type: 'integer', minimum: 1 },
      untilTime: { type: 'string' },
      direction: { enum: ['forward', 'backward'] },
    },
  },
  finalQuery: { enum: ['current_candle', 'candle_at_time', 'compare_candles'] },
  queryTime: { type: 'string' },
  previousSymbol: { type: 'boolean' },
  analysisRequests: { type: 'array', minItems: 1, maxItems: 4, items: COMPACT_ANALYSIS_REQUEST_SCHEMA },
  compare: COMPARE_SCHEMA,
  contextReference: {
    type: 'object',
    additionalProperties: false,
    required: ['source'],
    properties: {
      source: { type: 'string' },
      mode: { type: 'string' },
      inherit: { type: 'array', items: { type: 'string' } },
    },
  },
};

export const EXAMPLE_LIBRARY = [
  { fields: ['symbol', 'date', 'timeframe', 'seekTime', 'finalQuery'], text: 'Set me up on NVDA prior session 15m 11:15 and tell me what candle I\'m on', json: '{"kind":"chart_action","symbol":"NVDA","date":{"kind":"relative_trading","count":1,"direction":"backward"},"timeframeMinutes":15,"seekTime":"11:15","finalQuery":"current_candle"}' },
  { fields: ['seekTime'], text: 'Park the replay at 2:45 p.m.', json: '{"kind":"chart_action","seekTime":"14:45"}' },
  { fields: ['analysisRequests'], text: 'How much did it move up to here?', json: '{"kind":"chart_action","analysisRequests":[{"kind":"window_change","window":{"kind":"up_to_cursor"}}]}' },
  { fields: ['analysisRequests'], text: 'Compare the opening 30 minutes with the final 30 minutes', json: '{"kind":"chart_action","analysisRequests":[{"kind":"window_compare","left":{"kind":"time_range","fromTime":"09:30","toTime":"10:00"},"right":{"kind":"time_range","fromTime":"15:30","toTime":"16:00"}}]}' },
  { fields: ['relativeSeekMinutes', 'finalQuery'], text: 'Move 30 minutes earlier and give me the bar', json: '{"kind":"chart_action","relativeSeekMinutes":-30,"finalQuery":"current_candle"}' },
  { fields: ['previousSymbol'], text: 'Take me back to the previous stock', json: '{"kind":"chart_action","previousSymbol":true}' },
  { fields: ['finalQuery', 'queryTime'], text: 'Give me the bar at 11:30', json: '{"kind":"chart_action","finalQuery":"candle_at_time","queryTime":"11:30"}' },
  { fields: ['finalQuery'], text: 'Tell me what candle I\'m on', json: '{"kind":"chart_action","finalQuery":"current_candle"}' },
  { fields: ['compare', 'finalQuery'], text: 'Compare this candle with the previous one you reported', json: '{"kind":"chart_action","finalQuery":"compare_candles","compare":{"left":{"source":"latest_returned_candle"},"right":{"source":"previous_returned_candle"}}}' },
  { fields: ['analysisRequests'], text: 'What was the range in the first hour', json: '{"kind":"chart_action","analysisRequests":[{"kind":"window_ohlc","window":{"kind":"time_range","fromTime":"09:30","toTime":"10:30"}}]}' },
  { fields: ['analysisRequests'], text: 'Describe the shape of the candle currently on the chart', json: '{"kind":"chart_action","analysisRequests":[{"kind":"candle_shape","source":"current_chart_candle"}]}' },
  { fields: ['analysisRequests'], text: 'What was the overall session summary for this symbol', json: '{"kind":"chart_action","analysisRequests":[{"kind":"window_summary","window":{"kind":"whole_session"}}]}' },
  { fields: ['contextReference'], text: 'Do that again', json: '{"kind":"chart_action","contextReference":{"source":"latest_successful_action","mode":"repeat"}}' },
  { fields: ['contextReference', 'analysisRequests'], text: 'Do the same analysis but only for the opening hour', json: '{"kind":"chart_action","contextReference":{"source":"latest_successful_action","mode":"inherit","inherit":["analysisRequests"]},"analysisRequests":[{"kind":"window_ohlc","window":{"kind":"time_range","fromTime":"09:30","toTime":"10:30"}}]}' },
  { fields: ['analysisRequests'], text: 'What was the move and total volume from 10 to noon?', json: '{"kind":"chart_action","analysisRequests":[{"kind":"window_change","window":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"}},{"kind":"window_volume","window":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"}}]}' },
  { fields: ['analysisRequests'], text: 'Which had more volume, the morning or the afternoon?', json: '{"kind":"chart_action","analysisRequests":[{"kind":"window_compare","left":{"kind":"time_range","fromTime":"09:30","toTime":"12:00"},"right":{"kind":"time_range","fromTime":"12:00","toTime":"16:00"}},{"kind":"window_volume","window":{"kind":"time_range","fromTime":"09:30","toTime":"16:00"}}]}' },
  { fields: ['analysisRequests'], text: 'Was the morning turnover higher than near the close?', json: '{"kind":"chart_action","analysisRequests":[{"kind":"window_compare","left":{"kind":"time_range","fromTime":"09:30","toTime":"12:00"},"right":{"kind":"time_range","fromTime":"15:30","toTime":"16:00"}},{"kind":"window_volume","window":{"kind":"time_range","fromTime":"09:30","toTime":"16:00"}}]}' },
  { fields: ['analysisRequests'], text: 'What was the move, total volume and candle structure from 10 to noon?', json: '{"kind":"chart_action","analysisRequests":[{"kind":"window_change","window":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"}},{"kind":"window_volume","window":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"}},{"kind":"candle_shape","source":"market_time","marketTime":"12:00"}]}' },
  { fields: ['contextReference', 'analysisRequests'], text: 'What was the volume like for the same window', json: '{"kind":"chart_action","contextReference":{"source":"latest_successful_action","mode":"inherit","inherit":["analysisRequests"]},"analysisRequests":[{"kind":"window_volume"}]}' },
  { fields: ['symbol', 'contextReference'], text: 'Do that same analysis on NVDA', json: '{"kind":"chart_action","symbol":"NVDA","contextReference":{"source":"latest_successful_action","mode":"repeat"}}' },
  { fields: ['contextReference', 'analysisRequests'], text: 'How does that compare with the closing hour?', json: '{"kind":"chart_action","contextReference":{"source":"latest_successful_action","mode":"inherit","inherit":["analysisRequests"]},"analysisRequests":[{"kind":"window_compare","left":{"kind":"time_range","fromTime":"09:30","toTime":"15:00"},"right":{"kind":"time_range","fromTime":"15:00","toTime":"16:00"}},{"kind":"window_volume","window":{"kind":"time_range","fromTime":"09:30","toTime":"16:00"}}]}' },
  { fields: ['playback'], text: 'Play until 16:00', json: '{"kind":"chart_action","playback":{"action":"play_until","untilTime":"16:00"}}' },
];

function buildCompactChartActionProperties(selectedFields?: Set<string>, analysisKinds?: string[]): Record<string, unknown> {
  const props: Record<string, unknown> = { kind: { const: 'chart_action' } };
  if (!selectedFields) {
    for (const [key, value] of Object.entries(ALL_CHART_ACTION_PROPERTIES)) {
      props[key] = value;
    }
    return props;
  }
  for (const [key, value] of Object.entries(ALL_CHART_ACTION_PROPERTIES)) {
    if (selectedFields.has(key)) {
      if (key === 'analysisRequests') {
        props[key] = {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: buildCompactAnalysisRequestSchema(analysisKinds),
        };
      } else {
        props[key] = value;
      }
    }
  }
  return props;
}

function buildCompactSchema(selectedFields?: Set<string>, analysisKinds?: string[]): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: buildCompactChartActionProperties(selectedFields, analysisKinds),
      },
      { type: 'object', additionalProperties: false, required: ['kind', 'message'], properties: { kind: { const: 'clarification' }, message: { type: 'string' } } },
      { type: 'object', additionalProperties: false, required: ['kind', 'message'], properties: { kind: { const: 'unsupported' }, message: { type: 'string' } } },
    ],
  };
}

function textAsksForCandleAtTime(text: string): boolean {
  return /(?:what|which)\s+(?:candle|bar)|tell\s+me(?:\s+what)?\s+(?:candle|bar)|give\s+me\s+(?:the\s+)?(?:bar|candle)|what\s+bar\s+is\s+that/i.test(text);
}

function textContainsSymbol(text: string, requestContext?: RequestContext): boolean {
  const available = requestContext?.availableTickers;
  if (available && available.length > 0) {
    const t = text.toLowerCase();
    for (const ticker of available) {
      if (t.includes(ticker.toLowerCase())) return true;
    }
    for (const [alias] of Object.entries(requestContext?.symbolAliases ?? {})) {
      if (t.includes(alias.toLowerCase())) return true;
    }
  }
  try {
    const cmd = parseChartCommand(text, requestContext?.availableTickers ?? [], requestContext?.symbolAliases, requestContext?.baseDate);
    return !!cmd.symbol;
  } catch {
    return false;
  }
}

function selectedTopLevelFields(text: string, requestContext?: RequestContext, hasPriorAction = false): Set<string> {
  const selected = new Set<string>();
  const dims = new Set<string>([...(requestContext?.dimensions ?? []), ...(requestContext?.missing ?? [])]);
  const hasDim = (d: string) => dims.has(d);

  if (hasDim('symbol') || textContainsSymbol(text, requestContext)) selected.add('symbol');
  if (hasDim('date') || textRequestsDate(text)) selected.add('date');
  if (hasDim('timeframe') || textRequestsTimeframe(text)) selected.add('timeframeMinutes');
  if (hasDim('absoluteTime') || textRequestsAbsoluteTime(text)) {
    selected.add('seekTime');
    selected.add('queryTime');
  }
  if (hasDim('relativeSeek') || textRequestsRelativeSeek(text)) selected.add('relativeSeekMinutes');
  if (hasDim('playbackControl') || textRequestsPlaybackControl(text)) selected.add('playback');
  if (hasDim('candleQuery') || textAsksForCandleAtTime(text) || textRequestsCandleQuery(text)) {
    selected.add('finalQuery');
    selected.add('queryTime');
  }
  if (hasDim('previousSymbol') || textRequestsPreviousSymbol(text)) selected.add('previousSymbol');
  if (hasDim('analysisRequest') || textRequestsAnalysis(text)) selected.add('analysisRequests');
  if (/\bcompare\s+(?:this|that|the|current)\s+(?:candle|bar)\s+(?:with|to|against)\s+(?:the\s+)?(?:previous|last|reported|one|other|candle|bar)\b/i.test(text)) {
    selected.add('compare');
    selected.add('finalQuery');
    selected.add('queryTime');
  }
  if (textRequestsContextReference(text, hasPriorAction)) {
    selected.add('contextReference');
    // Contextual follow-ups can also change the metric (e.g. "and the range?"),
    // so expose analysisRequests in the schema.
    selected.add('analysisRequests');
  }

  return selected;
}

function isFullFallback(requestContext: RequestContext | undefined, text: string, hasPriorAction = false): boolean {
  if (!requestContext || !requestContext.missing) return true;
  if (requestContext.missing.length === 0 || requestContext.missing.length > 2) return true;
  if (text.trim().length < 4) return true;
  const selected = selectedTopLevelFields(text, requestContext, hasPriorAction);
  if (selected.size === 0) return true;
  return false;
}

function addMarketMinutes(t: { hour: number; minute: number }, minutes: number): { hour: number; minute: number } {
  const total = t.hour * 60 + t.minute + minutes;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return { hour: h, minute: m };
}

const MARKET_OPEN_MINUTES = US_EQUITY_MARKET_OPEN.hour * 60 + US_EQUITY_MARKET_OPEN.minute;
const MARKET_CLOSE_MINUTES = US_EQUITY_MARKET_CLOSE.hour * 60 + US_EQUITY_MARKET_CLOSE.minute;
const SESSION_MINUTES = MARKET_CLOSE_MINUTES - MARKET_OPEN_MINUTES;

function minutesFromTime(t: string): number | undefined {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return hour * 60 + minute;
}

function timeFromMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function isTimeInSession(minutes: number): boolean {
  return minutes >= MARKET_OPEN_MINUTES && minutes <= MARKET_CLOSE_MINUTES;
}

type DurationResult = { ok: true; value: number } | { ok: false } | undefined;

function parseDurationFromObject(w: Record<string, unknown>, canonical: string): DurationResult {
  if (typeof w.minutes === 'number') {
    if (w.minutes > 0) return { ok: true, value: w.minutes };
    if (w.minutes <= 0) return { ok: false };
  }
  if (typeof w.minutes === 'string') {
    const n = Number(w.minutes);
    if (!Number.isNaN(n) && n > 0) return { ok: true, value: n };
    if (!Number.isNaN(n) && n <= 0) return { ok: false };
  }
  if (typeof w.n === 'number') {
    if (w.n <= 0) return { ok: false };
    if (/hour|hr/.test(canonical)) return { ok: true, value: w.n * 60 };
    return { ok: true, value: w.n };
  }
  if (typeof w.n === 'string') {
    const n = Number(w.n);
    if (!Number.isNaN(n) && n <= 0) return { ok: false };
    if (!Number.isNaN(n) && n > 0) {
      if (/hour|hr/.test(canonical)) return { ok: true, value: n * 60 };
      return { ok: true, value: n };
    }
  }
  return undefined;
}

function parseDurationFromKind(canonical: string): DurationResult {
  // Match a bounded number + optional unit anywhere in the canonical kind.
  // "last_hour", "last_60_minutes", "lasthour" and "first_30" are all valid.
  const unitMatch = canonical.match(/(\d+)?_?(min|mins|minute|minutes|hour|hours|hr|hrs)(?:_|$)/);
  if (unitMatch) {
    const nStr = unitMatch[1];
    const unit = unitMatch[2] ?? '';
    if (nStr === undefined) {
      if (unit.startsWith('hour') || unit.startsWith('hr')) return { ok: true, value: 60 };
      if (unit.startsWith('min')) return { ok: true, value: 1 };
      return undefined;
    }
    const n = Number(nStr);
    if (Number.isNaN(n) || n <= 0) return { ok: false };
    if (unit.startsWith('hour') || unit.startsWith('hr')) return { ok: true, value: n * 60 };
    return { ok: true, value: n };
  }
  // Bare number suffix (e.g. first_30) means minutes.
  const nMatch = canonical.match(/(\d+)(?:_|$)/);
  if (nMatch) {
    const n = Number(nMatch[1]);
    if (Number.isNaN(n) || n <= 0) return { ok: false };
    return { ok: true, value: n };
  }
  return undefined;
}

function makeFirstMinutesWindow(n: number): { kind: 'time_range'; fromTime: string; toTime: string } | undefined {
  if (!Number.isFinite(n) || n <= 0 || n > SESSION_MINUTES) return undefined;
  const fromMinutes = MARKET_OPEN_MINUTES;
  const toMinutes = fromMinutes + n;
  if (toMinutes > MARKET_CLOSE_MINUTES) return undefined;
  return { kind: 'time_range', fromTime: timeFromMinutes(fromMinutes), toTime: timeFromMinutes(toMinutes) };
}

function makeLastMinutesWindow(n: number): { kind: 'time_range'; fromTime: string; toTime: string } | undefined {
  if (!Number.isFinite(n) || n <= 0 || n > SESSION_MINUTES) return undefined;
  const toMinutes = MARKET_CLOSE_MINUTES;
  const fromMinutes = toMinutes - n;
  if (fromMinutes < MARKET_OPEN_MINUTES) return undefined;
  return { kind: 'time_range', fromTime: timeFromMinutes(fromMinutes), toTime: timeFromMinutes(toMinutes) };
}

function makeFixedWindow(
  fromTime: { hour: number; minute: number },
  toTime: { hour: number; minute: number }
): { kind: 'time_range'; fromTime: string; toTime: string } {
  return { kind: 'time_range', fromTime: formatTime(fromTime), toTime: formatTime(toTime) };
}

export function normalizeAnalysisWindow(win: unknown): unknown {
  if (!win || typeof win !== 'object' || Array.isArray(win)) return win;
  const w = win as Record<string, unknown>;

  // Accept common aliases for fromTime/toTime.
  if (w.from !== undefined && w.fromTime === undefined) {
    w.fromTime = w.from;
    delete w.from;
  }
  if (w.to !== undefined && w.toTime === undefined) {
    w.toTime = w.to;
    delete w.to;
  }

  // Explicit valid fromTime/toTime always take precedence.
  if (w.fromTime !== undefined || w.toTime !== undefined) {
    const fromMinutes = w.fromTime !== undefined ? minutesFromTime(String(w.fromTime)) : undefined;
    const toMinutes = w.toTime !== undefined ? minutesFromTime(String(w.toTime)) : undefined;
    if (
      fromMinutes !== undefined &&
      toMinutes !== undefined &&
      isTimeInSession(fromMinutes) &&
      isTimeInSession(toMinutes) &&
      fromMinutes < toMinutes
    ) {
      return {
        kind: 'time_range',
        fromTime: timeFromMinutes(fromMinutes),
        toTime: timeFromMinutes(toMinutes),
      };
    }
    // Invalid or incomplete explicit range: leave the original object invalid
    // so strict validation and repair can reject it.
    return win;
  }

  const rawKind = typeof w.kind === 'string' ? w.kind : '';
  const canonical = rawKind.toLowerCase().replace(/[\s-]+/g, '_');

  if (canonical === 'whole_session' || canonical === 'up_to_cursor') return w;

  const objectDuration = parseDurationFromObject(w, canonical);
  const kindDuration = parseDurationFromKind(canonical);

  // Any explicit invalid duration (0, negative, NaN) should fail validation
  // instead of falling back to a default window.
  if (objectDuration?.ok === false || kindDuration?.ok === false) {
    return win;
  }

  let n = objectDuration?.value ?? kindDuration?.value;

  // Bare first/last/opening/closing aliases default to one full hour.
  if (n === undefined && ['first', 'last', 'opening', 'final', 'closing'].includes(canonical)) {
    n = 60;
  }

  if (n === undefined) {
    // No bounded duration was found and the kind is not a recognized bare alias.
    return win;
  }

  if (canonical === 'morning') return makeFixedWindow(US_EQUITY_MARKET_OPEN, MORNING_END);
  if (canonical === 'afternoon') return makeFixedWindow(AFTERNOON_START, US_EQUITY_MARKET_CLOSE);

  // Recognize both underscore-separated and concatenated aliases
  // (e.g. "last_hour", "lasthour", "first_30_minutes", "first_30").
  const isFirstWindow =
    /^(first|opening)(?:_|$|\d|hour|minute|min|hrs?)/.test(canonical);
  const isLastWindow =
    /^(last|final|closing)(?:_|$|\d|hour|minute|min|hrs?)/.test(canonical);

  if (isFirstWindow) {
    const window = makeFirstMinutesWindow(n);
    if (window) return window;
  } else if (isLastWindow) {
    const window = makeLastMinutesWindow(n);
    if (window) return window;
  }

  // Unknown named window kinds are deliberately left invalid so validation
  // can fail and the repair loop can ask for clarification.
  return win;
}

function buildMarketWindowRules(): string[] {
  const open = formatTime(US_EQUITY_MARKET_OPEN);
  const close = formatTime(US_EQUITY_MARKET_CLOSE);
  const oneHourAfterOpen = formatTime(addMarketMinutes(US_EQUITY_MARKET_OPEN, 60));
  const morningEnd = formatTime(MORNING_END);
  const afternoonStart = formatTime(AFTERNOON_START);
  const lastHourStart = formatTime(addMarketMinutes(US_EQUITY_MARKET_CLOSE, -60));
  const first30End = formatTime(addMarketMinutes(US_EQUITY_MARKET_OPEN, 30));
  const final45Start = formatTime(addMarketMinutes(US_EQUITY_MARKET_CLOSE, -45));
  const closing20Start = formatTime(addMarketMinutes(US_EQUITY_MARKET_CLOSE, -20));

  return [
    `Market hours are ${open}–${close} America/New_York. Use ${open} for market open (the opening bell) and ${close} for market close (the closing bell).`,
    `first hour / opening hour -> time_range from "${open}" to "${oneHourAfterOpen}". first N minutes -> from "${open}" to ("${open}"+N). Example: first 30 minutes -> "${open}"–"${first30End}".`,
    `last hour / closing hour -> time_range from "${lastHourStart}" to "${close}". last/final/closing N minutes -> ("${close}"-N) to "${close}". Examples: final 45 minutes -> "${final45Start}"–"${close}"; closing 20 minutes -> "${closing20Start}"–"${close}".`,
    `morning -> "${open}"–"${morningEnd}"; afternoon -> "${afternoonStart}"–"${close}".`,
    `near open = start around "${open}"; near close = end around "${close}".`,
    'half an hour = 30 minutes; a quarter of an hour = 15 minutes; three quarters of an hour = 45 minutes; from the bell = market open.',
    'Explicit user clock times (e.g. "from 10:00 to 12:00") override named-window defaults.',
  ];
}

function buildRules(selectedFields?: Set<string>): string[] {
  const rules: string[] = [];
  rules.push('Do NOT include computed numbers in analysisRequests (no open, high, low, close, volume, percent change, etc.). Only request the operation and the window.');
  rules.push('Clock times must be HH:MM (00:00-23:59). If the user gives an invalid or out-of-range time, return clarification. Do not guess a time.');
  rules.push('Do not set play, pause, or play_until fields unless the user explicitly asks for them.');
  rules.push('Up to 4 analysisRequests are allowed in one turn, but never more than 4 and never none.');

  if (!selectedFields || selectedFields.has('symbol')) {
    rules.push('Map company names to tickers: AAPL, MSFT, NVDA.');
  }
  if (!selectedFields || selectedFields.has('date') || selectedFields.has('timeframeMinutes')) {
    rules.push('prior trading session -> date:{"kind":"relative_trading","count":1,"direction":"backward"}; next session -> forward.');
    rules.push('N-minute bars -> timeframeMinutes:N (e.g. 15m -> 15).');
  }
  if (!selectedFields || selectedFields.has('seekTime') || selectedFields.has('relativeSeekMinutes')) {
    rules.push('quarter past X -> seekTime:"X:15"; quarter to X -> seekTime:"(X-1):45"; half past X -> seekTime:"X:30"; noon -> 12:00; midnight -> 00:00.');
    rules.push('a.m./p.m. (with or without dots) convert to 24-hour HH:MM.');
    rules.push('park the replay at X -> seekTime:X (do not pause).');
    rules.push('move X minutes earlier/ago -> relativeSeekMinutes:-X; later/forward -> relativeSeekMinutes:+X.');
  }
  if (!selectedFields || selectedFields.has('playback')) {
    rules.push('playback play_until with an end time -> {"action":"play_until","untilTime":"HH:MM"}.');
  }
  if (!selectedFields || selectedFields.has('finalQuery') || selectedFields.has('queryTime')) {
    rules.push('"what candle" / "what bar" / "tell me what candle I\'m on" -> finalQuery:"current_candle".');
    rules.push('"give me the bar at X" -> finalQuery:"candle_at_time", queryTime:X.');
    rules.push('"the bar I land on" or "what bar is that" -> finalQuery:"current_candle" with no queryTime.');
  }
  if (!selectedFields || selectedFields.has('compare')) {
    rules.push('"compare this candle with the previous one" -> finalQuery:"compare_candles", compare:{"left":{"source":"latest_returned_candle"},"right":{"source":"previous_returned_candle"}}.');
    rules.push('"compare current chart with the last reported" -> left:"current_chart_candle", right:"latest_returned_candle".');
    rules.push('"compare 11:30 with 11:00" -> left:"market_time" marketTime:"11:30", right:"market_time" marketTime:"11:00".');
  }
  if (!selectedFields || selectedFields.has('analysisRequests')) {
    rules.push('Use analysisRequests with kind one of window_ohlc, window_change, window_volume, window_compare, candle_shape, window_summary.');
    rules.push('For window_* and window_summary include window. For candle_shape include source and optional marketTime. For window_compare include left and right.');
    rules.push('Questions about candle body, wick, anatomy, shape, kind, type, structure, or describing a candle use kind:"candle_shape", NOT finalQuery.');
    rules.push('If the chart has an active session, "what kind of candle am I on" / "what candle is this" -> kind:"candle_shape", source:"current_chart_candle". Do not ask for a previously reported candle.');
    rules.push('If the user names a specific clock time for a candle shape request (e.g. "the 11:30 candle" or "candle anatomy at 2:45"), use kind:"candle_shape", source:"market_time", marketTime:"HH:MM". Never use current_chart_candle.');
    rules.push('A bare summary request ("how did X do", "how was X", "how did X perform") should emit only window_summary unless the user explicitly asks for OHLC, volume, or change.');
    rules.push('Compound requests (move + volume, OHLC + volume, candle shape + window, comparisons, summary + metric) can emit multiple analysisRequests.');
    rules.push(...buildMarketWindowRules());
  }
  if (!selectedFields || selectedFields.has('contextReference')) {
    rules.push('"do that again" / "again" -> contextReference:{"source":"latest_successful_action","mode":"repeat"}.');
    rules.push('"same X" / "use the same X" -> contextReference:{"source":"latest_successful_action","mode":"inherit","inherit":["X"]} where X is date/timeframe/seekTime/relativeSeekMinutes/playback/finalQuery/analysisRequests.');
    rules.push('"one session before that" -> contextReference:{"source":"latest_successful_action","mode":"anchor_relative_date"} with date backward 1.');
    rules.push('"go back to the candle we were discussing" / "the previous candle" -> contextReference:{"source":"latest_returned_candle","mode":"use_as_target"}.');
    rules.push('Explicit user values always win over inherited values. If the reference cannot be resolved, return clarification.');
  }

  return rules;
}

function buildExamples(selectedFields?: Set<string>, analysisKinds?: string[]): string[] {
  const always = [
    '- "Jump to 25:00." -> {"kind":"clarification","message":"25:00 is not a valid clock time. Use HH:MM (00:00-23:59)."}',
    '- "Add VWAP and backtest." -> {"kind":"unsupported","message":"VWAP and backtest are not supported."}',
  ];
  if (!selectedFields) {
    return EXAMPLE_LIBRARY.map((ex) => `- "${ex.text}" -> ${ex.json}`).concat(always);
  }
  const kindSet = analysisKinds ? new Set<string>(analysisKinds) : undefined;
  const scored = EXAMPLE_LIBRARY
    .filter((ex) => {
      const fieldMatch = ex.fields.some((f) => selectedFields.has(f));
      if (!fieldMatch) return false;
      if (selectedFields.has('analysisRequests') && kindSet) {
        try {
          const parsed = JSON.parse(ex.json) as Record<string, unknown>;
          const requests = (parsed?.analysisRequests ?? []) as Array<{ kind?: string }>;
          const requestKinds = new Set(requests.map((r) => r.kind).filter(Boolean) as string[]);
          for (const k of requestKinds) {
            if (!kindSet.has(k)) return false;
          }
        } catch {
          // keep the example if we cannot parse it
        }
      }
      return true;
    })
    .map((ex) => {
      let score = ex.fields.filter((f) => selectedFields.has(f)).length;
      if (selectedFields.has('analysisRequests')) {
        try {
          const parsed = JSON.parse(ex.json) as Record<string, unknown>;
          const requests = (parsed?.analysisRequests ?? []) as Array<{ kind?: string }>;
          const requestKinds = new Set(requests.map((r) => r.kind).filter(Boolean) as string[]);
          if (kindSet && requestKinds.size > 0) {
            for (const k of requestKinds) {
              if (kindSet.has(k)) score += 2;
            }
          } else if (!kindSet) {
            // Compound/ambiguous context: prefer examples with multiple request
            // kinds or, when context is selected, a contextReference to inherit from.
            if (requestKinds.size >= 2) score += 3;
            if (selectedFields.has('contextReference') && parsed?.contextReference) score += 4;
          }
        } catch {
          // ignore malformed example JSON
        }
      }
      return { ex, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 4).map(({ ex }) => `- "${ex.text}" -> ${ex.json}`).concat(always);
}

function needsCandleContext(text: string, selectedFields?: Set<string>): boolean {
  if (selectedFields && (selectedFields.has('finalQuery') || selectedFields.has('compare'))) return true;
  if (textRequestsCandleShape(text) || textRequestsCandleQuery(text)) return true;
  if (selectedFields?.has('analysisRequests') && textRequestsCandleShape(text)) return true;
  return false;
}

export interface IntentExtractionPromptInput {
  executionLog?: ExecutionContextStore;
  requestContext?: RequestContext;
  text?: string;
}

// ---------------------------------------------------------------------------
// Prompt generation
// ---------------------------------------------------------------------------

export function selectedAnalysisKinds(text: string, hasContextReference = false): string[] | undefined {
  // Context inheritance and genuinely compound/ambiguous requests receive the
  // full safe set of analysis kinds so the model can repeat/inherit/combine.
  if (hasContextReference) return undefined;

  const d = detectAnalysisConcepts(text);
  const isCandleShape = textRequestsCandleShape(text);
  const isSummary = textRequestsSummary(text);
  const hasCompare = hasCompareLanguage(text, d);
  const hasVolume = d.concepts.has('volume');
  const hasChange =
    d.concepts.has('change') ||
    d.concepts.has('move') ||
    hasNonPhrasalDirection(d) ||
    d.concepts.has('gain') ||
    d.concepts.has('loss') ||
    /\b(?:percent|pct|%)\b/i.test(text);
  const hasOhlc =
    d.concepts.has('range') ||
    d.concepts.has('high') ||
    d.concepts.has('low') ||
    d.concepts.has('open') ||
    d.concepts.has('close') ||
    d.concepts.has('ohlc') ||
    d.concepts.has('total') ||
    d.concepts.has('average') ||
    d.concepts.has('price');

  // More than one metric cluster, an implicit compare, summary+candle/window,
  // or compare combined with a metric means the request is compound.
  const metricClusters = [hasVolume, hasChange, hasOhlc, isCandleShape].filter(Boolean).length;
  const summaryPlusMetric = isSummary && (hasVolume || hasChange || hasOhlc || isCandleShape);
  const multipleMetrics = metricClusters >= 2 || summaryPlusMetric;

  // A comparison paired with only window/boundary nouns ("range", "hour",
  // "first", "last", etc.) is a bare window comparison; concrete metrics like
  // volume, change, or high/low/open/close make it compound.
  const nonCompareWindowNouns = new Set([
    'compare', 'range', 'hour', 'minute', 'period', 'first', 'last', 'final',
    'opening', 'closing', 'morning', 'afternoon', 'session', 'day', 'today', 'now',
  ]);
  const compareHasConcreteMetric =
    hasCompare &&
    Array.from(d.concepts).some((c) => !nonCompareWindowNouns.has(c)) &&
    !isCandleShape;
  const comparePlusMetric =
    hasCompare && (hasVolume || hasChange || hasOhlc || isCandleShape || isSummary);
  if ((comparePlusMetric && !compareHasConcreteMetric) || multipleMetrics) {
    // isSummary with an explicit clock time + shape word is still a
    // candle-shape request, not a whole-session summary.
    if (isCandleShape && extractTimes(text).length > 0) {
      return ['candle_shape'];
    }
    // Whole-session summary + candle mention without a specific time is a
    // session summary.
    if (isSummary && isCandleShape && extractTimes(text).length === 0 &&
        (d.concepts.has('session') || d.concepts.has('today') || d.concepts.has('day'))) {
      return ['window_summary'];
    }
  }
  if ((compareHasConcreteMetric && comparePlusMetric) || multipleMetrics) return undefined;

  // A bare comparison (no other metric) is still compound but only needs
  // window_compare; the compare capability can derive OHLC and volume.
  if (hasCompare) return ['window_compare'];

  const kinds: string[] = [];
  if (isCandleShape) kinds.push('candle_shape');
  if (isSummary) kinds.push('window_summary');
  if (hasVolume) kinds.push('window_volume');
  if (hasChange) kinds.push('window_change');
  if (hasOhlc) kinds.push('window_ohlc');

  // A bare named window or a lone OHLC metric defaults to window_ohlc.
  if (kinds.length === 0 && (
    d.concepts.has('first') || d.concepts.has('last') || d.concepts.has('final') ||
    d.concepts.has('opening') || d.concepts.has('closing') ||
    d.concepts.has('morning') || d.concepts.has('afternoon') ||
    d.concepts.has('period') || d.concepts.has('open') || d.concepts.has('close')
  )) {
    kinds.push('window_ohlc');
  }

  if (kinds.length === 0) return undefined;
  return kinds;
}

export function buildIntentExtractionPrompt(
  executionLogOrContext?: ExecutionContextStore | IntentExtractionPromptInput
): string {
  let executionLog: ExecutionContextStore | undefined;
  let requestContext: RequestContext | undefined;
  let text = '';

  if (executionLogOrContext && typeof (executionLogOrContext as ExecutionContextStore).renderForPrompt === 'function') {
    executionLog = executionLogOrContext as ExecutionContextStore;
  } else if (executionLogOrContext) {
    const ctx = executionLogOrContext as IntentExtractionPromptInput;
    executionLog = ctx.executionLog;
    requestContext = ctx.requestContext;
    text = ctx.text ?? '';
  }

  const hasPriorAction = executionLog ? executionLog.latestSuccessfulAction() != null : false;
  const fallback = isFullFallback(requestContext, text, hasPriorAction);
  const selectedFields = fallback ? undefined : selectedTopLevelFields(text, requestContext, hasPriorAction);
  const hasContextReference = selectedFields?.has('contextReference') ?? false;
  const analysisKinds = fallback ? undefined : selectedAnalysisKinds(text, hasContextReference);
  const maxActions = hasContextReference ? 1 : 3;
  const recentActions = executionLog
    ? executionLog.renderForPrompt({ maxActions, includeCandles: needsCandleContext(text, selectedFields) })
    : null;

  const sections: string[] = [
    'You are a compact intent parser for OpenRewind. Respond with one minified JSON object.',
    'Do not write prose, markdown, or the literal string "<today>".',
    '',
    'Schema:',
    JSON.stringify(buildCompactSchema(selectedFields, analysisKinds)),
    '',
    'Rules:',
    ...buildRules(selectedFields),
  ];

  if (recentActions) {
    sections.push('');
    sections.push('RECENT ACTIONS');
    sections.push(recentActions);
  }

  sections.push(
    '',
    'Examples:',
    ...buildExamples(selectedFields, analysisKinds),
    '',
    'Respond with minified JSON.'
  );

  return sections.join('\n');
}

export function buildIntentRepairPrompt(_validationError: string): string {
  return 'Return a corrected, minified JSON object. If the user gave an invalid or out-of-range clock time, return clarification. Do not invent a time.';
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
  'analysisRequests',
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

function validateAnalysisWindow(raw: unknown): AnalysisWindow | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'window must be an object.';
  }
  const obj = raw as Record<string, unknown>;
  const err = hasUnknownFields(obj, new Set(['kind', 'fromTime', 'toTime']));
  if (err) return `window ${err}`;

  const kind = obj.kind;
  if (kind !== 'whole_session' && kind !== 'up_to_cursor' && kind !== 'time_range') {
    return `window.kind must be one of whole_session, up_to_cursor, time_range.`;
  }

  if (kind === 'time_range') {
    if (typeof obj.fromTime !== 'string' || !isValidTime(obj.fromTime)) {
      return 'time_range window requires a valid HH:MM fromTime.';
    }
    if (typeof obj.toTime !== 'string' || !isValidTime(obj.toTime)) {
      return 'time_range window requires a valid HH:MM toTime.';
    }
    return { kind: 'time_range', fromTime: obj.fromTime, toTime: obj.toTime };
  }

  return { kind };
}

function validateAnalysisRequest(raw: unknown, index: number): AnalysisRequest | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `analysisRequests[${index}] must be an object.`;
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (
    kind !== 'window_ohlc' &&
    kind !== 'window_change' &&
    kind !== 'window_volume' &&
    kind !== 'window_compare' &&
    kind !== 'candle_shape' &&
    kind !== 'window_summary'
  ) {
    return `analysisRequests[${index}] has unknown kind "${String(kind)}".`;
  }

  if (kind === 'candle_shape') {
    const err = hasUnknownFields(obj, new Set(['kind', 'source', 'marketTime']));
    if (err) return `analysisRequests[${index}] ${err}`;
    let source = obj.source;
    if (source !== undefined && source !== null && typeof source !== 'string') {
      return `analysisRequests[${index}] candle_shape source must be a string.`;
    }
    if (source === undefined || source === null) {
      source = 'current_chart_candle';
    }
    const normalizedSource = (source as string).toLowerCase().replace(/[-\s]+/g, '_');
    if (
      normalizedSource === 'current' ||
      normalizedSource === 'current_candle' ||
      normalizedSource === 'current_chart' ||
      normalizedSource === 'current_chart_candle' ||
      normalizedSource === 'now' ||
      normalizedSource === 'here' ||
      normalizedSource === 'cursor'
    ) {
      return { kind: 'candle_shape', source: 'current_chart_candle' };
    }
    if (normalizedSource === 'market_time' || normalizedSource === 'time' || normalizedSource === 'specific_time') {
      if (typeof obj.marketTime !== 'string' || !isValidTime(obj.marketTime)) {
        return `analysisRequests[${index}] candle_shape market_time requires a valid HH:MM marketTime.`;
      }
      return { kind: 'candle_shape', source: 'market_time', marketTime: obj.marketTime };
    }
    return `analysisRequests[${index}] candle_shape source must be "current_chart_candle" or "market_time".`;
  }

  if (kind === 'window_compare') {
    const err = hasUnknownFields(obj, new Set(['kind', 'left', 'right']));
    if (err) return `analysisRequests[${index}] ${err}`;
    const left = 'left' in obj ? validateAnalysisWindow(obj.left) : undefined;
    if (typeof left === 'string') return `analysisRequests[${index}] left: ${left}`;
    const right = 'right' in obj ? validateAnalysisWindow(obj.right) : undefined;
    if (typeof right === 'string') return `analysisRequests[${index}] right: ${right}`;
    return { kind: 'window_compare', left, right };
  }

  const err = hasUnknownFields(obj, new Set(['kind', 'window']));
  if (err) return `analysisRequests[${index}] ${err}`;
  const window = 'window' in obj ? validateAnalysisWindow(obj.window) : undefined;
  if (typeof window === 'string') return `analysisRequests[${index}] window: ${window}`;
  return { kind, window } as AnalysisRequest;
}

function validateAnalysisRequests(raw: unknown): AnalysisRequest[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) {
    return 'analysisRequests must be an array with 1 to 4 items.';
  }
  const requests: AnalysisRequest[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = validateAnalysisRequest(raw[i], i);
    if (typeof r === 'string') return r;
    requests.push(r);
  }
  return requests;
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
    'analysisRequests',
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

  if ('analysisRequests' in obj) {
    const validation = validateAnalysisRequests(obj.analysisRequests);
    if (typeof validation === 'string') {
      return { ok: false, error: validation };
    }
    intent.analysisRequests = validation;
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
    !intent.contextReference &&
    (!intent.analysisRequests || intent.analysisRequests.length === 0)
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

const ANALYSIS_KINDS = [
  'window_ohlc',
  'window_change',
  'window_volume',
  'window_compare',
  'candle_shape',
  'window_summary',
];

const FORBIDDEN_ANALYSIS_KEYS = new Set([
  'open',
  'high',
  'low',
  'close',
  'volume',
  'percentChange',
  'range',
  'bodyRange',
  'upperWick',
  'lowerWick',
  'totalVolume',
  'averageVolume',
  'largestVolume',
]);

function isAnalysisWindowMalformed(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const w = value as Record<string, unknown>;
  if (w.kind !== 'whole_session' && w.kind !== 'up_to_cursor' && w.kind !== 'time_range') return true;
  if (hasUnknownFields(w, new Set(['kind', 'fromTime', 'toTime']))) return true;
  if (w.kind === 'time_range') {
    if (typeof w.fromTime !== 'string' || !isValidTime(w.fromTime)) return true;
    if (typeof w.toTime !== 'string' || !isValidTime(w.toTime)) return true;
  }
  return false;
}

function isAnalysisRequestMalformed(value: unknown, _index: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const r = value as Record<string, unknown>;
  if (!ANALYSIS_KINDS.includes(String(r.kind))) return true;
  if (Object.keys(r).some((k) => FORBIDDEN_ANALYSIS_KEYS.has(k))) return true;

  if (r.kind === 'candle_shape') {
    if (hasUnknownFields(r, new Set(['kind', 'source', 'marketTime']))) return true;
    if (r.source !== 'current_chart_candle' && r.source !== 'market_time') return true;
    if (r.source === 'market_time' && (typeof r.marketTime !== 'string' || !isValidTime(r.marketTime))) return true;
    return false;
  }

  if (r.kind === 'window_compare') {
    if (hasUnknownFields(r, new Set(['kind', 'left', 'right']))) return true;
    if (r.left !== undefined && isAnalysisWindowMalformed(r.left)) return true;
    if (r.right !== undefined && isAnalysisWindowMalformed(r.right)) return true;
    return false;
  }

  if (hasUnknownFields(r, new Set(['kind', 'window']))) return true;
  if (r.window !== undefined && isAnalysisWindowMalformed(r.window)) return true;
  return false;
}

function isAnalysisRequestsMalformed(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return true;
  for (let i = 0; i < value.length; i++) {
    if (isAnalysisRequestMalformed(value[i], i)) return true;
  }
  return false;
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
  analysisRequests: 'analysisRequest',
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

  if (field === 'analysisRequests') {
    return isAnalysisRequestsMalformed(value);
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

  if (field === 'analysisRequests') {
    return Array.isArray(value) && value.length > 0 && textRequestsAnalysis(text);
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

  // Structural repair: some models place chart_action fields inside the
  // contextReference object.  Lift those fields to the top level so the schema
  // validates, while preserving the contextReference's valid source/mode/inherit.
  const TOP_LEVEL_FIELDS = new Set([
    'symbol', 'date', 'timeframeMinutes', 'seekTime', 'relativeSeekMinutes',
    'playback', 'finalQuery', 'queryTime', 'analysisRequests', 'compare', 'previousSymbol',
  ]);
  const ctxRef = raw.contextReference as Record<string, unknown> | undefined;
  if (ctxRef && typeof ctxRef === 'object' && !Array.isArray(ctxRef)) {
    for (const [field, value] of Object.entries(ctxRef)) {
      if (TOP_LEVEL_FIELDS.has(field) && !(field in raw)) {
        agentTrace('llm intent sanitize', { reason: 'lift nested field from contextReference', field });
        (raw as Record<string, unknown>)[field] = value;
        delete ctxRef[field];
      }
    }
  }

  // Normalize analysis requests to the fields allowed for their kind.
  if ('analysisRequests' in raw && Array.isArray(raw.analysisRequests)) {
    raw.analysisRequests = (raw.analysisRequests as Record<string, unknown>[]).map((r) => {
      const kind = r.kind;
      if (kind === 'candle_shape') {
        if (typeof r.marketTime === 'string' && r.marketTime) {
          return { kind, source: 'market_time', marketTime: r.marketTime };
        }
        const source = typeof r.source === 'string' ? r.source : 'current_chart_candle';
        if (source === 'market_time') return { kind, source: 'current_chart_candle' };
        return { kind, source };
      }
      if (kind === 'window_compare') {
        const out: Record<string, unknown> = { kind };
        if (r.left !== undefined) out.left = normalizeAnalysisWindow(r.left);
        if (r.right !== undefined) out.right = normalizeAnalysisWindow(r.right);
        return out;
      }
      const out: Record<string, unknown> = { kind };
      if (r.window !== undefined) out.window = normalizeAnalysisWindow(r.window);
      return out;
    });
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
  /** Optional abort signal so a newer request can cancel this model call. */
  signal?: AbortSignal;
}

export type IntentExtractionResult =
  | { ok: true; intent: ChartActionIntent; elapsed: number }
  | { ok: false; kind: 'clarification' | 'unsupported' | 'invalid' | 'offline' | 'aborted'; message: string; elapsed: number };

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

  const system = buildIntentExtractionPrompt({ executionLog: opts.executionLog, requestContext: opts.requestContext, text });
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
        signal: opts.signal,
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string })?.code;
      agentTrace('llm intent failed', { err, code });
      if (code === 'ABORTED') {
        return { ok: false, kind: 'aborted', message: '', elapsed: Date.now() - start };
      }
      if (code === 'TIMEOUT') {
        return { ok: false, kind: 'offline', message: 'The local model did not respond in time. Please try again.', elapsed: Date.now() - start };
      }
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
