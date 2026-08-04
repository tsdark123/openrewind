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
  | 'previousSymbol';

export const ALL_ACTION_DIMENSIONS: ActionDimension[] = [
  'symbol',
  'date',
  'timeframe',
  'absoluteTime',
  'relativeSeek',
  'playbackControl',
  'candleQuery',
  'previousSymbol',
];

export const INHERIT_FIELD_TO_DIMENSION: Record<string, ActionDimension | undefined> = {
  date: 'date',
  timeframe: 'timeframe',
  seekTime: 'absoluteTime',
  relativeSeekMinutes: 'relativeSeek',
  playback: 'playbackControl',
  finalQuery: 'candleQuery',
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
  if (/\b(?:candle|bar|ohlc)\b/i.test(t)) return true;
  if (/\b(?:price|worth|value)\b/i.test(t)) {
    return /\b(?:what|tell|give|show|which|the)\s+(?:price|worth|value)\b/i.test(t) ||
      /\b(?:price|worth|value)\s+(?:at|of)\b/i.test(t);
  }
  return false;
}

export function textRequestsPreviousSymbol(t: string): boolean {
  return /\b(?:take me back|previous symbol|previous stock|stock i was just on|was just on)\b/i.test(t);
}

export function getRequestedDimensions(
  text: string,
  cmd: ChartCommand,
  baseDate?: string
): Set<ActionDimension> {
  const t = text;
  const dims = new Set<ActionDimension>();

  if (cmd.symbol || cmd.intent === 'switch' || (cmd.intent === 'unknown' && looksLikeSwitch(text))) {
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
  if (cmd.startTime || cmd.endTime) {
    dims.add('absoluteTime');
  } else if (textRequestsAbsoluteTime(t)) {
    dims.add('absoluteTime');
  }
  if (cmd.relativeMinutes !== undefined) {
    dims.add('relativeSeek');
  } else if (textRequestsRelativeSeek(t)) {
    dims.add('relativeSeek');
  }
  if (cmd.speed !== undefined || ['play', 'pause', 'rewind', 'fast_forward', 'set_speed', 'seek'].includes(cmd.intent)) {
    dims.add('playbackControl');
  } else if (textRequestsPlaybackControl(t)) {
    dims.add('playbackControl');
  }
  if (cmd.intent === 'candle_query') {
    dims.add('candleQuery');
    if (cmd.startTime || cmd.endTime) dims.add('absoluteTime');
  } else if (textRequestsCandleQuery(t)) {
    dims.add('candleQuery');
  }
  if (textRequestsPreviousSymbol(t)) {
    dims.add('previousSymbol');
  }
  return dims;
}
