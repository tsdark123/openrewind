// =============================================================================
// Action-dimension detection shared by the orchestrator, intent extractor,
// and grounding sanitizer. Centralizing these helpers keeps the pipeline
// consistent and lets the pre-validation sanitizer strip ungrounded optional
// fields before strict validation.
// =============================================================================

import { extractDateInput, extractTimeframe, type ChartCommand } from '../planner';

export type ActionDimension =
  | 'symbol'
  | 'date'
  | 'timeframe'
  | 'absoluteTime'
  | 'relativeSeek'
  | 'playbackControl'
  | 'candleQuery'
  | 'previousSymbol'
  | 'analysisRequest';

export const ALL_ACTION_DIMENSIONS: ActionDimension[] = [
  'symbol',
  'date',
  'timeframe',
  'absoluteTime',
  'relativeSeek',
  'playbackControl',
  'candleQuery',
  'previousSymbol',
  'analysisRequest',
];

export const INHERIT_FIELD_TO_DIMENSION: Record<string, ActionDimension | undefined> = {
  date: 'date',
  timeframe: 'timeframe',
  seekTime: 'absoluteTime',
  relativeSeekMinutes: 'relativeSeek',
  playback: 'playbackControl',
  finalQuery: 'candleQuery',
  analysisRequests: 'analysisRequest',
};

export function looksLikeSwitch(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(switch|go to|load|open|change to|show|pull)\b/.test(t);
}

export function textRequestsTimeframe(t: string): boolean {
  // The planner's timeframe extractor enforces the same rule: a number is only
  // a timeframe when it is paired with a unit (minute/hour/day/m/h/d) or a
  // recognized bar/timeframe suffix (bar/candle/timeframe/tf).  A bare number
  // followed by "chart" is not enough.
  return extractTimeframe(t) !== undefined;
}

export function textRequestsDate(t: string): boolean {
  // Reuse the planner's actual date extractor so any relative trading-session
  // phrase it recognizes is also treated as a date request here.
  return extractDateInput(t) !== undefined;
}

export function textRequestsAbsoluteTime(t: string): boolean {
  return (
    /\b\d{1,2}:\d{2}\b/.test(t) ||
    /\b\d{1,2}\s*(?:am|pm)\b/i.test(t) ||
    /\b(?:noon|midnight|market\s+open|market\s+close)\b/i.test(t) ||
    /\b(?:quarter|half)\s+(?:past|to)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(t) ||
    /\bo\'clock\b/i.test(t)
  );
}

export function textRequestsRelativeSeek(t: string): boolean {
  if (/\b(?:take me back|previous symbol|previous stock|stock i was just on|was just on)\b/i.test(t)) return false;
  return (
    /\b(?:\d+|half)\s*(?:an?\s+)?(?:minute|minutes|hour|hours|hr|hrs|min|mins)\s+(?:ago|earlier|later|before|after)\b/i.test(t) ||
    /\b(?:earlier|later)\b/i.test(t) ||
    /\b(?:go|move|skip|jump)\s+back\b/i.test(t) ||
    /\brewind\s+(?:\d+|half|a few)?\s*(?:minute|minutes|hour|hours)?/i.test(t)
  );
}

export function textRequestsPlaybackControl(t: string): boolean {
  return /\b(?:play|pause|rewind|fast[-\s]?forward|fastforward|speed up|slow down|set\s+speed)\b/.test(t);
}

export function textRequestsCandleQuery(t: string): boolean {
  if (/\b(?:candle|bar|ohlc)\s+(?:at|for|around|about)\b/i.test(t)) return true;
  if (/\b(?:current|this|the|latest)\s+(?:candle|bar|ohlc)\b/i.test(t)) return true;
  if (/\b(?:candle|bar|ohlc)\s+(?:now|here|right now|at this time|at the cursor)\b/i.test(t)) return true;
  if (/\b(?:what|which|tell|show|give)\s+(?:me\s+)?(?:the\s+)?(?:what\s+)?(?:candle|bar|ohlc)\b/i.test(t)) return true;
  if (/\b(?:price|worth|value)\b/i.test(t)) {
    return /\b(?:what|tell|give|show|which|the)\s+(?:price|worth|value)\b/i.test(t) ||
      /\b(?:price|worth|value)\s+(?:at|of)\b/i.test(t);
  }
  return false;
}

export function textRequestsPreviousSymbol(t: string): boolean {
  return /\b(?:take me back|previous symbol|previous stock|stock i was just on|was just on)\b/i.test(t);
}

export function textRequestsAnalysis(t: string): boolean {
  const text = t.toLowerCase();
  return (
    /\b(range|ohlc|open high low close|high low)\b/i.test(text) ||
    /\b(?:it|price|stock|this|the\s+stock)\s+(?:has\s+|did\s+)?(?:move|moved|moves)\b|\b(?:move|moved|moves)\s+(?:up|down|by|from|to|higher|lower|against)\b|\b(movement|change|changed|how did|do today|performed)\b/i.test(text) ||
    /\b(?:volum|vol|volume|total volume|average volume)\b/i.test(text) ||
    /\b(compare|vs|versus|compared to|against|higher than|lower than|more volume|less volume)\b/i.test(text) ||
    /\b(candle anatomy|body|wick|upper wick|lower wick|shadow|candle shape|what kind of candle|kind of candle|candle am i on|candle i'm on)\b/i.test(text) ||
    /\b(summary|overview|recap)\b/i.test(text) ||
    /\b(first|last)\s+\d+\s*(?:min|minute|hour|hr)s?\b/i.test(text) ||
    /\b(first hour|last hour|opening hour|closing hour|morning|mornig|afternoon|up to (?:cursor|here|where i)|where i'?m at|right now|rn)\b/i.test(text) ||
    /\bfrom\s+\d{1,2}:\d{2}\s+to\s+\d{1,2}:\d{2}\b/i.test(text) ||
    /\bfrom\s+\d{1,2}(?::\d{2})?\b.*\bto\s+\d{1,2}(?::\d{2})?\b/i.test(text)
  );
}

export function textRequestsCandleShape(t: string): boolean {
  const text = t.toLowerCase();
  return /\b(candle anatomy|body|wick|upper wick|lower wick|shadow|candle shape|what kind of candle|kind of candle|candle am i on|candle i'm on)\b/i.test(text);
}

export function textRequestsUnsupportedIndicator(t: string): boolean {
  const text = t.toLowerCase();
  return /\b(rsi|macd|bollinger|ema\d*|sma\d*|atr|stochastic|vwap|cci|adx|obv|momentum|williams %r|fibonacci|support|resistance|breakout|pattern|trend line)\b/i.test(text);
}

export function getRequestedDimensions(
  text: string,
  cmd: ChartCommand,
  baseDate?: string
): Set<ActionDimension> {
  const t = text;
  const dims = new Set<ActionDimension>();

  const switchHint = (cmd.intent === 'switch' || (cmd.intent === 'unknown' && looksLikeSwitch(text))) && !textRequestsAnalysis(t);
  if (cmd.symbol || switchHint) {
    dims.add('symbol');
  }
  if (cmd.date || cmd.dateInput || extractDateInput(text, baseDate)) {
    dims.add('date');
  } else if (textRequestsDate(t)) {
    dims.add('date');
  }
  if (cmd.timeframe !== undefined) {
    dims.add('timeframe');
  } else if (textRequestsTimeframe(t)) {
    dims.add('timeframe');
  }
  const wantsCandle = textRequestsCandleQuery(t) || (cmd.intent === 'candle_query' && !textRequestsAnalysis(t));
  if ((cmd.startTime || cmd.endTime) && (!textRequestsAnalysis(t) || wantsCandle)) {
    dims.add('absoluteTime');
  } else if (textRequestsAbsoluteTime(t) && !textRequestsAnalysis(t)) {
    dims.add('absoluteTime');
  }
  if (!textRequestsAnalysis(t)) {
    if (cmd.relativeMinutes !== undefined) {
      dims.add('relativeSeek');
    } else if (textRequestsRelativeSeek(t)) {
      dims.add('relativeSeek');
    }
  }
  if (
    (cmd.speed !== undefined || ['play', 'pause', 'rewind', 'fast_forward', 'set_speed', 'seek'].includes(cmd.intent)) &&
    !textRequestsAnalysis(t)
  ) {
    dims.add('playbackControl');
  } else if (textRequestsPlaybackControl(t)) {
    dims.add('playbackControl');
  }
  if (wantsCandle) {
    dims.add('candleQuery');
  }
  if (textRequestsPreviousSymbol(t)) {
    dims.add('previousSymbol');
  }
  if (textRequestsAnalysis(t)) {
    dims.add('analysisRequest');
  }
  return dims;
}
