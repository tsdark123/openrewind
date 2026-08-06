// =============================================================================
// planner — Deterministic chart-control planner for Orion.
//
// Instead of hard-coding one regex per command combination, this module
// extracts entities (symbol, date, start/end times, speed, direction) and
// builds a small plan against the user's actual chart state. It then executes
// the minimum set of engine/WebSocket commands needed to fulfill the request.
//
// This is the offline path: it works when Ollama is unavailable and gives
// Orion real access to the current session, candles, and playback state.
// =============================================================================

import type { AppState, AppAction, PerformanceLog } from '../../types';
import type { ChartHandle } from '../../components/Chart';
import { buildWorldState, type WorldState } from './worldState';
import { fetchCandles } from './tools';
import { orionChat } from './client';
import { SYMBOL_ALIASES as ALIASES } from './symbolAliases';
import { resolveSymbol } from './agent/resolveSymbol';

export type ChartIntent =
  | 'switch'
  | 'fast_forward'
  | 'rewind'
  | 'play'
  | 'pause'
  | 'seek'
  | 'set_speed'
  | 'set_timeframe'
  | 'step_forward'
  | 'step_backward'
  | 'candle_query'
  | 'unknown';

export interface ParsedTime { hour: number; minute: number; }

export const SUPPORTED_TIMEFRAMES = [1, 5, 15, 60, 240, 1440] as const;

export interface MarketTime { hour: number; minute: number; }

export const US_EQUITY_MARKET_OPEN: MarketTime = { hour: 9, minute: 30 };
export const US_EQUITY_MARKET_CLOSE: MarketTime = { hour: 16, minute: 0 };
export const MORNING_END: MarketTime = { hour: 12, minute: 0 };
export const AFTERNOON_START: MarketTime = { hour: 12, minute: 0 };

export interface DateInputSpec {
  kind: 'explicit' | 'relative_calendar' | 'relative_trading' | 'today';
  /** Number of sessions/days to walk. */
  count?: number;
  direction?: 'backward' | 'forward';
  /** Anchor/base date (YYYY-MM-DD). */
  from?: string;
  /** Explicit YYYY-MM-DD for 'explicit'. */
  date?: string;
}

export interface CommandIssue {
  kind: 'invalid_time' | 'unknown_symbol' | 'unavailable_symbol' | 'ambiguous_symbol';
  message: string;
  raw?: string;
}

export interface ChartCommand {
  intent: ChartIntent;
  symbol?: string;
  date?: string;
  /** Structured date request when the parser cannot produce a concrete calendar date. */
  dateInput?: DateInputSpec;
  startTime?: ParsedTime;
  endTime?: ParsedTime;
  speed?: number;
  direction?: 'forward' | 'backward';
  relativeMinutes?: number;
  timeframe?: number;
  /** Deterministic preflight problems discovered while parsing. */
  issues?: CommandIssue[];
}

export interface PlannerContext {
  /** Initial app-state snapshot. */
  appState: AppState;
  /** Live state accessor for waits and re-checks. */
  getState: () => AppState;
  chartRef: { current: ChartHandle | null } | null;
  performanceLog: PerformanceLog;
  apiBase: string;
  // Local Data directory passed to engine calls. Managed mode omits it.
  dataDir?: string;
  availableTickers: string[];
  send: (payload: Record<string, unknown>) => void;
  dispatch: (action: AppAction) => void;
  onSwitchSymbol: (symbol: string, date?: string) => void | Promise<void>;
  /** Optional progress callback for long operations. */
  onMessage?: (text: string) => void;
}

export interface PlanResult {
  ok: boolean;
  message: string;
  executed: boolean;
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

const SKIP = new Set([
  'switch', 'change', 'go', 'to', 'the', 'a', 'an', 'my', 'on', 'im', "i'm", 'current',
  'stock', 'symbol', 'chart', 'load', 'open', 'show', 'please', 'can', 'you', 'of', 'for',
  'in', 'is', 'it', 'this', 'that', 'your', 'our', 'me', 'i', 'be', 'am', 'are', 'and', 'or',
  'if', 'what', 'how', 'do', 'does', 'did', 'with', 'into', 'at', 'by', 'from', 'as',
  'run', 'execute', 'play', 'pause', 'fast', 'forward', 'rewind', 'back', 'seek', 'jump',
]);

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function todayEt(): { y: number; m: number; d: number } {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

function baseDateParts(base?: string): { y: number; m: number; d: number } {
  if (base && /^\d{4}-\d{2}-\d{2}$/.test(base)) {
    const [y, mo, d] = base.split('-').map((n) => parseInt(n, 10));
    return { y, m: mo, d };
  }
  return todayEt();
}

function offsetDate(offsetDays: number, base?: string): string {
  const { y, m, d } = baseDateParts(base);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayOfWeekDate(target: number, direction: 'last' | 'next', base?: string): string {
  const { y, m, d } = baseDateParts(base);
  const date = new Date(y, m - 1, d);
  const current = date.getDay();
  let delta: number;
  if (direction === 'last') {
    delta = (current - target + 7) % 7 || 7;
    date.setDate(date.getDate() - delta);
  } else {
    delta = (target - current + 7) % 7 || 7;
    date.setDate(date.getDate() + delta);
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseRelativeDate(input: string, base?: string): string | undefined {
  const t = input.toLowerCase();

  if (/\byesterday\b/.test(t)) return offsetDate(-1, base);
  if (/\b(today|tonight)\b/.test(t)) return offsetDate(0, base);
  if (/\btomorrow\b/.test(t)) return offsetDate(1, base);

  const daysMatch = /\b(\d+)\s*days?\s*(ago|from\s*now|ahead|back)\b/.exec(t);
  if (daysMatch) {
    const n = parseInt(daysMatch[1], 10);
    const dir = daysMatch[2].replace(/\s+/g, ' ').trim();
    if (dir === 'ago' || dir === 'back') return offsetDate(-n, base);
    return offsetDate(n, base);
  }

  if (/\b(?:last|previous)\s+week\b/.test(t)) return offsetDate(-7, base);
  if (/\bthis\s+week\b/.test(t)) return offsetDate(0, base);
  if (/\bnext\s+week\b/.test(t)) return offsetDate(7, base);

  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayMatch = /\b(?:(last|next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (dayMatch) {
    const target = days.indexOf(dayMatch[2]);
    const qualifier = dayMatch[1];
    let direction: 'last' | 'next';
    if (qualifier === 'last') direction = 'last';
    else if (qualifier === 'next' || qualifier === 'this') direction = 'next';
    else direction = 'last';
    return dayOfWeekDate(target, direction, base);
  }

  return undefined;
}

function parseDate(input: string, base?: string): string | undefined {
  const iso = input.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  const slash = input.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;

  const monthRe = MONTHS.join('|');
  const m1 = new RegExp(`\\b(${monthRe})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{2,4}))?\\b`, 'i').exec(input);
  if (m1) {
    const month = String(MONTHS.indexOf(m1[1].toLowerCase()) + 1).padStart(2, '0');
    const day = m1[2].padStart(2, '0');
    const year = m1[3] ? (m1[3].length === 2 ? `20${m1[3]}` : m1[3]) : String(baseDateParts(base).y);
    return `${year}-${month}-${day}`;
  }

  const m2 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthRe})[a-z]*(?:\\s+(\\d{2,4}))?\\b`, 'i').exec(input);
  if (m2) {
    const month = String(MONTHS.indexOf(m2[2].toLowerCase()) + 1).padStart(2, '0');
    const day = m2[1].padStart(2, '0');
    const year = m2[3] ? (m2[3].length === 2 ? `20${m2[3]}` : m2[3]) : String(baseDateParts(base).y);
    return `${year}-${month}-${day}`;
  }

  return parseRelativeDate(input, base);
}

function numberWord(n: string): number | undefined {
  const map: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12,
  };
  const digit = parseInt(n, 10);
  if (!Number.isNaN(digit)) return digit;
  return map[n.toLowerCase()];
}

function parseMinuteToken(token: string): number | undefined {
  const t = token.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const digit = parseInt(t, 10);
  if (!Number.isNaN(digit)) return digit;

  const ones: Record<string, number> = {
    oh: 0, o: 0, zero: 0, oclock: 0, "o'clock": 0,
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  };
  const tens: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  };

  if (ones[t] !== undefined) return ones[t];
  if (tens[t] !== undefined) return tens[t];

  const parts = t.split(/[-]/);
  if (parts.length === 2) {
    const ten = tens[parts[0]];
    const one = ones[parts[1]];
    if (ten !== undefined && one !== undefined) return ten + one;
  }

  return undefined;
}

export function extractDateInput(text: string, baseDate?: string): DateInputSpec | undefined {
  const t = text.toLowerCase();
  const anchor = baseDate || new Date().toISOString().slice(0, 10);
  const countWords = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';

  // "prior trading session", "previous session", "last trading day"
  const priorMatch = /\b(?:prior|previous|last)\s+(?:trading\s+)?(?:session|day)s?\b/.exec(t);
  if (priorMatch) {
    return { kind: 'relative_trading', count: 1, direction: 'backward', from: anchor };
  }

  // "next trading session", "next session"
  const nextMatch = /\b(?:next)\s+(?:trading\s+)?(?:session|day)s?\b/.exec(t);
  if (nextMatch) {
    return { kind: 'relative_trading', count: 1, direction: 'forward', from: anchor };
  }

  // "go back two sessions", "go back two trading sessions", "jump forward three days"
  const goBackMatch = new RegExp(
    `\\b(?:go|jump|move|step|skip)?\\s*(back|backward|forward|ahead)\\s+(\\d+|${countWords})\\s+(?:trading\\s+)?(?:session|day)s?\\b`,
    'i'
  ).exec(t);
  if (goBackMatch) {
    const n = numberWord(goBackMatch[2]);
    if (n !== undefined) {
      const dir = goBackMatch[1].toLowerCase();
      return {
        kind: 'relative_trading',
        count: n,
        direction: dir === 'forward' || dir === 'ahead' ? 'forward' : 'backward',
        from: anchor,
      };
    }
  }

  // "two sessions ago", "one session before", "two days back", "two sessions from now"
  const countDirMatch = new RegExp(
    `\\b(\\d+|${countWords})\\s+(?:trading\\s+)?(?:session|day)s?\\s+(ago|back|before|from\\s+now|ahead|later)\\b`,
    'i'
  ).exec(t);
  if (countDirMatch) {
    const n = numberWord(countDirMatch[1]);
    const dir = countDirMatch[2].replace(/\\s+/g, ' ').trim().toLowerCase();
    if (n !== undefined) {
      return {
        kind: 'relative_trading',
        count: n,
        direction: dir === 'from now' || dir === 'ahead' || dir === 'later' ? 'forward' : 'backward',
        from: anchor,
      };
    }
  }

  // Original explicit/calendar forms.
  const explicit = parseDate(text, baseDate);
  if (explicit) return { kind: 'explicit', date: explicit };

  return undefined;
}

function extractSymbolAndDate(
  text: string,
  availableTickers: string[],
  symbolAliases: Record<string, string> = ALIASES,
  base?: string
): { symbol?: string; date?: string } {
  const tickerSet = new Set(availableTickers.map((t) => t.toUpperCase()));
  const date = parseDate(text, base);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !SKIP.has(t));

  for (const t of tokens) {
    const aliased = symbolAliases[t];
    if (aliased && tickerSet.has(aliased)) return { symbol: aliased, date };
    const upper = t.toUpperCase();
    if (tickerSet.has(upper)) return { symbol: upper, date };
  }
  return { date };
}

function normalizeMeridian(meridian?: string): 'am' | 'pm' | undefined {
  if (!meridian) return undefined;
  const t = meridian.toLowerCase().replace(/[^a-z]/g, '');
  if (t === 'am' || t === 'pm') return t;
  if (/in\s+the\s+morning/i.test(meridian)) return 'am';
  if (/in\s+the\s+(afternoon|evening|night)/i.test(meridian)) return 'pm';
  return undefined;
}

function defaultMeridianForHour(hour: number, token: string): 'am' | 'pm' | undefined {
  if (token === 'noon' || token === 'midnight') return undefined;
  if (hour >= 1 && hour <= 6) return 'pm';
  if (hour >= 7 && hour <= 11) return 'am';
  return undefined;
}

function parse24hTime(hour: number, minute: number, meridian?: string): ParsedTime | null {
  let h = hour;
  const m = minute;
  const md = (meridian || '').toLowerCase();
  if (md === 'am' && h === 12) h = 0;
  if (md === 'pm' && h !== 12) h += 12;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { hour: h, minute: m };
}

function parseHourToken(token: string): number | undefined {
  const lowered = token.toLowerCase();
  if (lowered === 'noon') return 12;
  if (lowered === 'midnight') return 0;
  const digit = parseInt(token, 10);
  if (!Number.isNaN(digit)) return digit;
  return numberWord(token);
}

export interface TimeAttempt {
  index: number;
  raw: string;
  time?: ParsedTime;
  error?: 'invalid_hour' | 'invalid_minute' | 'out_of_range';
}

export function extractTimeAttempts(text: string): TimeAttempt[] {
  const attempts: TimeAttempt[] = [];
  const seen = new Set<string>();

  const recordValid = (time: ParsedTime, index: number, raw: string) => {
    const key = `${time.hour}:${time.minute}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ index, raw, time });
  };

  const recordInvalid = (index: number, raw: string, error: TimeAttempt['error']) => {
    attempts.push({ index, raw, error });
  };

  const try24h = (
    h: number,
    m: number,
    meridian: string | undefined,
    index: number,
    raw: string
  ): ParsedTime | undefined => {
    const t = parse24hTime(h, m, meridian);
    if (t) {
      recordValid(t, index, raw);
      return t;
    }
    // Callers always pass parseable hour/minute values; a failure here means
    // the resulting 24-hour time is out of range.
    recordInvalid(index, raw, 'out_of_range');
    return undefined;
  };

  function parseRangeToken(token: string, minuteStr?: string): ParsedTime | null {
    const t = token.toLowerCase().trim();
    if (t === 'noon') return parse24hTime(12, 0);
    if (t === 'midnight') return parse24hTime(0, 0);
    if (t === 'market open') return { ...US_EQUITY_MARKET_OPEN };
    if (t === 'market close') return { ...US_EQUITY_MARKET_CLOSE };
    const h = parseHourToken(token);
    if (h === undefined) return null;
    const m = minuteStr ? parseInt(minuteStr, 10) : 0;
    if (Number.isNaN(m)) return null;
    return parse24hTime(h, m);
  }

  // Compound time ranges with bare numeric hours and named boundaries.
  const connector = `(?:to|and|through|thru|till|\\'?til|until)`;
  const boundary = `noon|midnight|market\\s+(?:open|close)`;
  const rangeRe = new RegExp(
    `\\b(?:from|between)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*[-:\\s]*${connector}\\s*[-:\\s]*((\\d{1,2})(?::(\\d{2}))?|${boundary})\\b`,
    'gi'
  );
  for (const m of text.matchAll(rangeRe)) {
    const raw = m[0];
    const startTok = m[1];
    const startMin = m[2];
    const endTok = m[3];
    const endMin = m[5];
    const start = parseRangeToken(startTok, startMin);
    const end = parseRangeToken(endTok, endMin);
    if (start && end) {
      const startIndex = (m.index ?? 0) + (m[0].indexOf(startTok) ?? 0);
      const endIndex = (m.index ?? 0) + (m[0].lastIndexOf(endTok) ?? 0);
      recordValid(start, startIndex, startTok);
      recordValid(end, endIndex, endTok);
    } else {
      recordInvalid(m.index ?? 0, raw, 'out_of_range');
    }
  }

  // "2:30pm", "2:30 p.m.", "14:00", etc.
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\b/gi)) {
    try24h(parseInt(m[1], 10), parseInt(m[2], 10), normalizeMeridian(m[3]), m.index ?? 0, m[0]);
  }

  // "2pm", "2 p.m." — speed markers like "10x" are ignored because they lack am/pm.
  // (?<!:) prevents matching the minutes of a colon time (e.g. "20" in "10:20am").
  for (const m of text.matchAll(/\b(?<!:)(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/gi)) {
    try24h(parseInt(m[1], 10), 0, normalizeMeridian(m[2]), m.index ?? 0, m[0]);
  }

  // Spelled-out hours with a meridian or time-of-day phrase: "three p.m.", "two in the afternoon".
  // Negative lookbehind skips the hour word inside a colloquial phrase such as
  // "quarter past three p.m." — that is handled by the colloquial regex above.
  const hourWords = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
  const wordHourRe = new RegExp(
    `(?<!\\b(?:quarter|half)\\s+(?:past|to)\\s+)(?:^|\\b)(${hourWords})\\s*(a\\.?m\\.?|p\\.?m\\.?|in\\s+the\\s+(morning|afternoon|evening|night))\\b`,
    'gi'
  );
  for (const m of text.matchAll(wordHourRe)) {
    const hour = parseHourToken(m[1]);
    if (hour !== undefined) {
      try24h(hour, 0, normalizeMeridian(m[2]), m.index ?? 0, m[0]);
    }
  }

  // Spelled-out hour + minute: "eleven thirty", "eleven thirty-one", "eleven oh five",
  // "eleven fifteen in the afternoon". Must come after the whole-hour and colloquial
  // matchers so it does not steal the hour from "quarter past eleven".
  const minuteWords = "oclock|o'clock|oh|o|zero|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty[- ]?five|thirty|forty|forty[- ]?five|fifty|fifty[- ]?nine|sixty|sixty[- ]?five|seventy|eighty|ninety|hundred";
  const spokenMinuteRe = new RegExp(
    `\\b(${hourWords})\\s+(\\d{1,2}|${minuteWords})(?:\\s+(a\\.?m\\.?|p\\.?m\\.?|in\\s+the\\s+(morning|afternoon|evening|night)))?\\b`,
    'gi'
  );
  for (const m of text.matchAll(spokenMinuteRe)) {
    const hour = parseHourToken(m[1]);
    const minute = parseMinuteToken(m[2]);
    if (hour !== undefined && minute !== undefined) {
      const meridian = normalizeMeridian(m[3]) || defaultMeridianForHour(hour, m[1]);
      try24h(hour, minute, meridian, m.index ?? 0, m[0]);
    } else if (hour !== undefined) {
      recordInvalid(m.index ?? 0, m[0], 'invalid_minute');
    }
  }

  const marketOpen = /\bmarket\s+open\b/i.exec(text);
  if (marketOpen && marketOpen.index !== undefined) {
    recordValid(US_EQUITY_MARKET_OPEN, marketOpen.index, 'market open');
  }

  const marketClose = /\bmarket\s+close\b/i.exec(text);
  if (marketClose && marketClose.index !== undefined) {
    recordValid(US_EQUITY_MARKET_CLOSE, marketClose.index, 'market close');
  }

  const noon = /(?<!\b(?:quarter|half)\s+(?:past|to)\s+)\b(noon|midday)\b/i.exec(text);
  if (noon && noon.index !== undefined) recordValid({ hour: 12, minute: 0 }, noon.index, noon[0]);

  const midnight = /(?<!\b(?:quarter|half)\s+(?:past|to)\s+)\bmidnight\b/i.exec(text);
  if (midnight && midnight.index !== undefined) recordValid({ hour: 0, minute: 0 }, midnight.index, midnight[0]);

  // Colloquial times: "quarter to three p.m.", "half past eleven in the morning", etc.
  for (const m of text.matchAll(/(?:^|\b)(quarter|half)\s+(past|to)\s+(\d{1,2}|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight))(?:\s+(a\.?m\.?|p\.?m\.?|in\s+the\s+(morning|afternoon|evening|night)))?/gi)) {
    const offset = m[1].toLowerCase() === 'quarter' ? 15 : 30;
    const relation = m[2].toLowerCase();
    const token = m[3];
    const hour = parseHourToken(token);
    if (hour === undefined) {
      recordInvalid(m.index ?? 0, m[0], 'invalid_hour');
      continue;
    }

    let h: number;
    let min: number;
    if (relation === 'past') {
      h = hour;
      min = offset;
    } else {
      h = hour - 1;
      min = 60 - offset;
    }
    if (h < 0) h += 24;
    if (min >= 60) {
      h += 1;
      min -= 60;
    }

    const meridian = normalizeMeridian(m[4]) || defaultMeridianForHour(hour, token);
    try24h(h, min, meridian, m.index ?? 0, m[0]);
  }

  // Sort by the position the expression appeared in the original text so that
  // "from X to Y" yields X as startTime and Y as endTime.
  attempts.sort((a, b) => a.index - b.index);
  return attempts;
}

export function extractTimes(text: string): ParsedTime[] {
  return extractTimeAttempts(text)
    .filter((a) => a.time !== undefined)
    .map((a) => a.time!);
}

// ---------------------------------------------------------------------------
// Explicit unresolved-symbol detection
// ---------------------------------------------------------------------------

const SYMBOL_ATTEMPT_STOP_WORDS = new Set([
  // articles, common prepositions, determiners
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'on', 'at', 'to', 'in', 'of', 'with', 'from', 'by', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'has', 'have', 'had',
  // pronouns
  'it', 'this', 'that', 'these', 'those', 'they', 'them', 'their', 'there', 'here', 'me', 'my', 'your',
  'his', 'her', 'its', 'our', 'us', 'i', 'you', 'he', 'she', 'we',
  // generic chart/session words
  'market', 'today', 'yesterday', 'tomorrow', 'session', 'day', 'trading', 'open', 'opening', 'close',
  'closing', 'high', 'higher', 'highest', 'highs', 'low', 'lower', 'lowest', 'lows', 'volume', 'vol',
  'volumes', 'range', 'ranges', 'change', 'changes', 'move', 'moves', 'moved', 'moving', 'candle', 'candles',
  'bar', 'bars', 'price', 'prices', 'chart', 'charts', 'graph', 'graphs', 'data', 'info',
  'replay', 'history', 'playback',
  // time words
  'time', 'times', 'hour', 'hours', 'hr', 'hrs', 'minute', 'minutes', 'min', 'mins', 'second', 'seconds',
  'sec', 'now', 'noon', 'midnight', 'morning', 'afternoon', 'evening', 'night',
  // ordering/market-window words
  'first', 'last', 'final', 'next', 'prior', 'previous', 'following', 'all', 'whole', 'entire', 'full',
  // company-name suffix noise
  'stock', 'shares', 'ticker', 'symbol', 'company', 'corporation', 'corp', 'incorporated', 'inc', 'ltd',
  'limited', 'plc', 'holdings', 'group', 'co', 'nv', 'sa', 'ag',
  // verbs/nouns that are not symbols
  'switch', 'change', 'load', 'go', 'pull', 'show', 'describe', 'summarize', 'explain', 'tell', 'what', 'how',
  'why', 'when', 'where', 'which', 'who',
  // days/months and abbreviations
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const STRONG_CUE_RE =
  /(?:\b|^)(?:switch(?:\s+to)?|change(?:\s+to)?|load|open|go(?:\s+to)?|pull(?:\s+up)?|ticker|symbol)\s+([^\s,;:.?!]+(?:\s+[^\s,;:.?!]+){0,2})/gi;

const WEAK_CUE_RE =
  /(?:\b|^)(?:for|on|with|of)\s+([^\s,;:.?!]+(?:\s+[^\s,;:.?!]+){0,2})/gi;

function isAllCapsSymbolToken(s: string): boolean {
  return /^[A-Z0-9.-]+$/.test(s);
}

function isTitleCaseSymbolToken(s: string): boolean {
  return /^[A-Z][a-z0-9.-]+$/.test(s);
}

const NUMBER_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred',
]);

function tokenizeSymbolCandidate(captured: string): { raw: string; filtered: string[] } | undefined {
  const rawWords = captured.split(/[^a-zA-Z0-9-]+/).filter(Boolean);
  const lowered = captured.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  if (rawWords.length === 0 || lowered.length === 0) return undefined;

  const filtered: string[] = [];
  const includedRaw: string[] = [];

  for (let i = 0; i < lowered.length; i++) {
    const w = lowered[i];
    const rw = rawWords[i];
    if (SYMBOL_ATTEMPT_STOP_WORDS.has(w)) break;

    // Skip pure numbers and quantity/time-unit tokens like 15m, 1h, 5d, 30min.
    if (/^\d+$/.test(w)) continue;
    if (/^\d+\s*[mhd](?:in(?:utes?)?|our(?:s?)?|r|ay(?:s?)?)?$/i.test(w)) continue;

    // Skip single-letter unit (m/h/d) that immediately follows a number.
    if (
      i > 0 &&
      /^\d+$/.test(rawWords[i - 1]) &&
      /^[mhd]$/i.test(w) &&
      !isAllCapsSymbolToken(rw)
    ) {
      continue;
    }

    // Skip spoken number words unless they are all-caps (plausible tickers like ONE, TEN).
    if (NUMBER_WORDS.has(w) && !isAllCapsSymbolToken(rw)) continue;

    filtered.push(w);
    includedRaw.push(rw);
  }

  if (filtered.length === 0) return undefined;

  const raw = includedRaw.join(' ');
  return { raw, filtered };
}

function resolveSymbolAttempt(
  candidate: { raw: string; filtered: string[] },
  availableTickers: string[],
  symbolAliases: Record<string, string>
): CommandIssue | undefined {
  const res = resolveSymbol(candidate.filtered.join(' '), { availableTickers, extraAliases: symbolAliases });
  if (res.ok) return undefined;

  if (res.matchKind === 'unavailable_alias') {
    return { kind: 'unavailable_symbol', message: res.message, raw: candidate.raw };
  }
  if (res.matchKind === 'ambiguous') {
    return { kind: 'ambiguous_symbol', message: res.message, raw: candidate.raw };
  }

  const tickerSet = new Set(availableTickers.map((t) => t.toUpperCase()));
  const knownSet = new Set<string>([...tickerSet, ...Object.values(symbolAliases)]);
  const upper = candidate.raw.toUpperCase();
  if (knownSet.has(upper)) {
    return {
      kind: 'unavailable_symbol',
      message: `${upper} is not in the current session.`,
      raw: candidate.raw,
    };
  }

  return {
    kind: 'unknown_symbol',
    message: `I don't recognize "${candidate.raw}" as a valid ticker or company name.`,
    raw: candidate.raw,
  };
}

function extractSymbolIssue(
  text: string,
  availableTickers: string[],
  symbolAliases: Record<string, string>,
  baseDate?: string
): CommandIssue | undefined {
  // A validated, available symbol takes precedence and clears the issue path.
  const { symbol } = extractSymbolAndDate(text, availableTickers, symbolAliases, baseDate);
  if (symbol) return undefined;

  // Strong symbol cues: explicit switch, ticker/symbol declarations and direct-object "for".
  for (const m of text.matchAll(STRONG_CUE_RE)) {
    const candidate = tokenizeSymbolCandidate(m[1]);
    if (!candidate) continue;
    const issue = resolveSymbolAttempt(candidate, availableTickers, symbolAliases);
    if (issue) return issue;
  }

  // Weak location cues: only trigger when the candidate has credible symbol casing/syntax.
  for (const m of text.matchAll(WEAK_CUE_RE)) {
    const candidate = tokenizeSymbolCandidate(m[1]);
    if (!candidate) continue;
    const first = candidate.raw.split(/[^a-zA-Z0-9-]+/).filter(Boolean)[0] ?? '';
    if (!isAllCapsSymbolToken(first) && !isTitleCaseSymbolToken(first)) continue;
    const issue = resolveSymbolAttempt(candidate, availableTickers, symbolAliases);
    if (issue) return issue;
  }

  return undefined;
}

/**
 * Returns true when the user appears to be attempting to name a clock time
 * even if the expression is not parseable (e.g. "eleven seventy" or "25:00").
 * This is a safety guard so malformed times clarify instead of silently using
 * the current candle.
 */
export function looksLikeTimeAttempt(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b\d{1,2}:\d{2}\b/.test(t)) return true;
  if (/\b(?:quarter|half)\s+(?:past|to)\b/i.test(t)) return true;
  if (/\b(?:noon|midnight|market\s+open|market\s+close)\b/i.test(t)) return true;

  const hourWords = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
  const spokenRe = new RegExp(
    `\\b(?:${hourWords})\\s+(?!am\\b|pm\\b|a\\.?m\\.?|p\\.?m\\.?|in\\s+the\\s+(?:morning|afternoon|evening|night|noon|midday))\\S+`,
    'i'
  );
  return spokenRe.test(t);
}

// Skip number+unit matches that are part of a named market window such as
// "first 30 minutes", "last hour", "final 45 minutes" or "opening 60 minutes".
function isNamedWindowMinuteMatch(t: string, start: number): boolean {
  const before = t.slice(0, start);
  return /(?:^|\b)(?:the\s+)?(first|last|final|closing|opening)(?:\s+(?:the|a|an))?\s+$/i.test(before);
}

function extractSpeed(text: string): number | undefined {
  const m = text.match(/(\d{1,3})\s*(?:x|times?)\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return Math.max(1, Math.min(100, n));
  }
  const set = text.match(/set\s+speed.*?\D(\d{1,3})\b/i);
  if (set) {
    const n = parseInt(set[1], 10);
    return Math.max(1, Math.min(100, n));
  }
  // "on 10" or "at 10" when the user forgets the x, with a tolerated filler
  // like "on like 25" or "at about 10".
  const bare = text.match(
    /\b(?:on|at)(?:\s+(?:like|about|around|roughly|maybe|approx|approximately))?\s+(\d{1,3})(?![\d:]|\s*(?:a\.?m\.?|p\.?m\.?)\b)\b/i
  );
  if (bare) {
    const n = parseInt(bare[1], 10);
    return Math.max(1, Math.min(100, n));
  }
  return undefined;
}

const SPOKEN_FRACTIONS: Record<string, number> = {
  half: 0.5,
  quarter: 0.25,
};

function minutesFromUnit(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('hour') || u.startsWith('hr')) return Math.round(n * 60);
  if (u.startsWith('min')) return Math.max(1, Math.round(n));
  return Math.round(n);
}

function extractRelativeMinutes(text: string): number | undefined {
  const t = text.toLowerCase();

  // Spoken fractional durations: "half an hour", "quarter of an hour",
  // "a quarter hour", "half a minute".  Guard against clock expressions
  // such as "quarter past eleven" and "half past twelve".
  const fractionRe = /(?:^|\b)(half|quarter)(?:\s+(?:of\s+(?:an?\s+)?|an?\s+))?(hour|hr|minute|min)s?(?:\s+(?:ago|earlier|later|before|after))?\b/gi;
  for (const m of t.matchAll(fractionRe)) {
    const start = m.index ?? 0;
    if (isNamedWindowMinuteMatch(t, start)) continue;
    // Avoid "quarter/half past/to X" clock expressions.
    const before = t.slice(Math.max(0, start - 10), start);
    if (/\b(?:quarter|half)\s+(?:past|to)\s+$/i.test(before)) continue;
    const frac = SPOKEN_FRACTIONS[m[1].toLowerCase()];
    if (frac === undefined) continue;
    return Math.max(1, minutesFromUnit(frac, m[2]));
  }

  // Numeric forms and number words: "30 minutes", "1 hour", "half an hour",
  // "one hour earlier".
  const numberWords = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|thirty|sixty';
  const re = new RegExp(`(?:another\\s+)?(\\d+(?:\\.\\d+)?|${numberWords})\\s*(?:more\\s+|extra\\s+)?(min|minute|hour|hr)s?\\b`, 'gi');
  for (const m of t.matchAll(re)) {
    const start = m.index ?? 0;
    if (isNamedWindowMinuteMatch(t, start)) continue;
    const n = parseFloat(m[1]) || numberWord(m[1]) || 0;
    const unit = m[2]?.toLowerCase() || '';
    if (n <= 0) continue;
    // Spoken hour forms (e.g. "one hour") are durations, not clock times;
    // "one hour" without a direction is ambiguous, but "one hour earlier/later"
    // is clearly a relative seek.
    if (unit && /^(hour|hr)/.test(unit)) return Math.max(1, Math.round(n * 60));
    if (unit && /^min/.test(unit)) return Math.max(1, Math.round(n));
    return Math.round(n);
  }
  return undefined;
}

const TIME_LABELS: Record<number, string> = {
  1: '1m',
  5: '5m',
  15: '15m',
  60: '1h',
  240: '4h',
  1440: 'daily',
};

function formatTimeframe(minutes: number): string {
  return TIME_LABELS[minutes] ?? `${minutes}m`;
}

export function clampTimeframe(tf?: number): number | undefined {
  if (tf === undefined) return undefined;
  const n = Number.isFinite(tf) ? Math.round(tf) : NaN;
  if (n < 1) return undefined;
  return SUPPORTED_TIMEFRAMES.includes(n as any) ? n : undefined;
}

const TIMEFRAME_NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, thirty: 30, sixty: 60,
};

function parseTimeframeNumber(raw: string): number | undefined {
  const digits = parseInt(raw, 10);
  if (!Number.isNaN(digits)) return digits;
  return TIMEFRAME_NUMBER_WORDS[raw.toLowerCase()];
}

const UNIT_TO_MINUTES: Record<string, number> = {
  m: 1, min: 1, minute: 1, minutes: 1,
  h: 60, hr: 60, hour: 60, hours: 60,
  d: 1440, day: 1440, days: 1440,
};

export function extractTimeframe(text: string): number | undefined {
  const t = text.toLowerCase();

  // Compact token forms: 5m, 1h, 4h, 1d, 60m, 240m.
  const compact = /\b(1m|5m|15m|60m|240m|1h|4h|1d)\b/.exec(t);
  if (compact) {
    switch (compact[1]) {
      case '1m': return 1;
      case '5m': return 5;
      case '15m': return 15;
      case '60m':
      case '1h': return 60;
      case '240m':
      case '4h': return 240;
      case '1d': return 1440;
    }
  }

  // Named whole-word timeframes.
  if (/\bintraday\b/.test(t)) return 1;
  if (/\bhourly\b/.test(t)) return 60;
  if (/\bdaily\b/.test(t)) return 1440;

  // Phrases like "5 minute timeframe", "fifteen-minute bars", "1 hour chart",
  // "zero-minute candles".  We require an explicit unit (minute/hour/day/m/etc)
  // OR a recognized bar/timeframe suffix (bar/candle/timeframe/tf).  A bare
  // number followed by "chart" is not enough.
  const wordOrDigit = '(\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty|sixty)';
  const unit = '(m(?:in(?:utes?)?)?|h(?:our(?:s?)?)?|hr(?:s?)?|d(?:ay(?:s?)?)?)';
  const suffix = 'bar(?:s)?|candle(?:s)?|timeframe|tf';
  const re = new RegExp(`\\b${wordOrDigit}(?:\\s*[- ]\\s*|\\s+)(?:(${unit})(?:\\s+(?:${suffix}))?|(?:${suffix}))\\b`, 'gi');

  for (const m of t.matchAll(re)) {
    const rawN = m[1];
    const rawUnit = m[2];
    const full = m[0];

    // Skip if this is part of a relative-time phrase (e.g. "15 minutes ago",
    // "go back one minute").  It is only a timeframe request when it stands as
    // a candle/aggregation setting.
    const start = m.index ?? 0;
    const before = t.slice(0, start);
    if (/(?:back|backward|rewind|reverse|forward|ahead|go\s+(?:back|forward)|skip|earlier|later)\s+$/i.test(before)) continue;

    const end = start + full.length;
    const after = t.slice(end);
    if (/^\s*(ago|back|before|later|forward|ahead|from\s+now)\b/.test(after)) continue;
    if (isNamedWindowMinuteMatch(t, start)) continue;

    // Skip when the number is the minute part of a clock expression
    // (e.g. "11:30 candle" or "eleven thirty candle" should not be read
    // as a 30-minute timeframe).  A minute word immediately preceded by an
    // hour word/digit with no explicit unit is a spoken clock time, not a
    // candle aggregation setting.
    const beforeNumber = t.slice(Math.max(0, start - 15), start);
    const hourWords = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight';
    const isSpokenMinute =
      !rawUnit &&
      /\b(?:fifteen|twenty|twenty[- ]?five|thirty|forty|fourty|forty[- ]?five|fifty)\b/.test(rawN) &&
      new RegExp(`(?:^|\\s)(?:${hourWords}|\\d{1,2})\\s*$`, 'i').test(beforeNumber);
    if (/\d{1,2}:\s*$/.test(beforeNumber) || isSpokenMinute) continue;

    const n = parseTimeframeNumber(rawN);
    if (n === undefined) continue;

    if (rawUnit) {
      const factor = UNIT_TO_MINUTES[rawUnit.toLowerCase()];
      if (factor !== undefined) return n * factor;
      continue;
    }

    // Suffix-only (e.g. "fifteen candles" means fifteen-minute candles).
    return n;
  }

  return undefined;
}

function detectDirection(text: string, relative?: number): 'forward' | 'backward' | undefined {
  const t = text.toLowerCase();
  if (/(?:fast[- ]?forward|forward|ahead|skip ahead)/.test(t)) return 'forward';
  if (/(?:rewind|reverse|go back|back up|backward|back\b)/.test(t)) return 'backward';
  if (relative !== undefined) {
    if (/\b(?:back(?:ward)?|earlier)\b/.test(t)) return 'backward';
    if (/\b(?:forward|ahead|later)\b/.test(t)) return 'forward';
  }
  return undefined;
}

function detectIntent(text: string, e: {
  symbol?: string;
  date?: string;
  dateInput?: DateInputSpec;
  times: ParsedTime[];
  speed?: number;
  relative?: number;
  direction?: 'forward' | 'backward';
  timeframe?: number;
}): ChartIntent {
  const t = text.toLowerCase();

  if (/\b(pause|halt|stop playback|stop the playback|stop the chart)\b/i.test(t)) return 'pause';
  if (/\b(set speed|speed up|slow down)\b/i.test(t)) return 'set_speed';
  const dayNames = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';
  const stepForwardRe = new RegExp(`\\b(next(?!\\s+(?:week|${dayNames}\\b)))(?:\\s+(?:step|candle))?\\b|\\b(step forward|advance one|forward one)\\b`, 'i');
  const stepBackwardRe = new RegExp(`\\b(previous(?!\\s+(?:week|${dayNames}\\b)))(?:\\s+(?:step|candle))?\\b|\\b(step back|back one|rewind one)\\b`, 'i');
  // Avoid treating a compound "switch to X, go back N sessions, set Ym and seek to ..."
  // as a pure seek/step when the sentence actually names a symbol, date and execution details.
  const looksCompound =
    e.symbol !== undefined &&
    (e.dateInput !== undefined || e.timeframe !== undefined || e.times.length > 0 || e.speed !== undefined);

  if (stepForwardRe.test(t) && !looksCompound) return 'step_forward';
  if (stepBackwardRe.test(t) && !looksCompound) return 'step_backward';
  if (/\b(jump|seek)\b/i.test(t) && !looksCompound) return 'seek';

  // Any explicit or inferred timeframe request takes precedence only when
  // the user is not already naming a symbol/playback sequence or a relative
  // motion amount (e.g. "go back one minute" is a rewind, not a timeframe).
  const hasRelativeMotion = e.relative !== undefined && (
    e.direction !== undefined ||
    /(?:back|backward|rewind|reverse|forward|ahead|go\s+(?:back|forward)|skip|earlier|later)\b/i.test(t)
  );
  if (e.timeframe !== undefined && !e.symbol && !hasRelativeMotion) return 'set_timeframe';

  // Candle/price queries at a specific time.
  // Exclude switch/setup phrases so "set me up on X at 11:15 and tell me the candle" remains a switch.
  if (
    e.times.length > 0 &&
    /\b(price|candle|cost|worth|value|ohlcv)\b/i.test(text) &&
    !/\b(play|rewind|fast[- ]?forward|seek|switch|go to|show me|set\s+(?:me\s+)?(?:up|on)|put\s+(?:me\s+)?(?:up|on))\b/i.test(t)
  ) {
    return 'candle_query';
  }

  // Time-based motion without explicit verb can be inferred from direction.
  if (e.times.length > 0 || e.relative !== undefined) {
    if (/(?:fast[- ]?forward|fastforward|ff|skip ahead|fast forward)\b/i.test(t)) return 'fast_forward';

    // Compound "switch to X, go back N sessions, set Ym and seek to ..." routes as a switch
    // before the generic "go back" / "back" direction inference.
    if (
      e.symbol &&
      e.relative === undefined &&
      (e.dateInput !== undefined || e.timeframe !== undefined || e.times.length > 0)
    ) {
      return 'switch';
    }

    if (/(?:rewind|reverse|go back|back up|skip back)\b/i.test(t)) return 'rewind';
    if (e.direction === 'backward') return 'rewind';
    if (e.direction === 'forward') return 'fast_forward';
    if (/\b(?:play|run)\b/i.test(t)) return e.times.length > 0 || e.relative !== undefined ? 'fast_forward' : 'play';
    // A switch action requires a grounded symbol or an explicit switch/change
    // verb.  A bare date ("yesterday", "today") or non-switch verb like "show"
    // is not enough to create a symbol-resolution plan.
    if (e.symbol || /\b(switch|change to|load|open)\b/i.test(t)) {
      // "switch to AAPL and fast forward to 1:47" still carries times, so it
      // lands here only if no playback verb was found. Treat as switch and let
      // the executor notice the times and continue with a fast-forward.
      return 'switch';
    }
    // Bare time with no verb: "go to 1:47pm" or "1:47pm".
    if (/\bgo\s+to\b/i.test(t) || e.times.length === 1) return 'seek';
    return 'fast_forward';
  }

  if (/\b(fast[- ]?forward|fastforward|ff)\b/i.test(t)) return 'fast_forward';
  if (/\b(rewind|reverse|go back|back up)\b/i.test(t)) return 'rewind';
  if (/\bplay\b/i.test(t)) return 'play';
  // Switch only when a symbol is grounded or the user explicitly asks to
  // switch/change/load/open.  A bare date must not become a switch.
  if (e.symbol || /\b(switch|change to|load|open)\b/i.test(t)) return 'switch';

  return 'unknown';
}

export function parseChartCommand(
  text: string,
  availableTickers: string[],
  symbolAliases: Record<string, string> = ALIASES,
  baseDate?: string
): ChartCommand {
  const { symbol, date } = extractSymbolAndDate(text, availableTickers, symbolAliases, baseDate);
  const dateInput = extractDateInput(text, baseDate);
  const timeAttempts = extractTimeAttempts(text);
  const times = timeAttempts.filter((a) => a.time !== undefined).map((a) => a.time!);
  const speed = extractSpeed(text);
  const relative = extractRelativeMinutes(text);
  const direction = detectDirection(text, relative);
  const timeframe = extractTimeframe(text);
  const intent = detectIntent(text, { symbol, date: date || undefined, dateInput, times, speed, relative, direction, timeframe });

  const issues: CommandIssue[] = [];
  for (const a of timeAttempts) {
    if (a.error) {
      const what = a.raw ?? 'that time';
      let message: string;
      switch (a.error) {
        case 'invalid_hour':
          message = `"${what}" has an invalid hour.`;
          break;
        case 'invalid_minute':
          message = `"${what}" has an invalid minute.`;
          break;
        case 'out_of_range':
        default:
          message = `"${what}" is outside the valid 24-hour range.`;
          break;
      }
      issues.push({
        kind: 'invalid_time',
        raw: a.raw,
        message,
      });
    }
  }

  const symbolIssue = extractSymbolIssue(text, availableTickers, symbolAliases, baseDate);
  if (symbolIssue) issues.push(symbolIssue);

  return {
    intent,
    symbol,
    date,
    dateInput,
    startTime: times.length >= 2 ? times[0] : undefined,
    endTime: times.length >= 1 ? times[times.length - 1] : undefined,
    speed,
    direction,
    relativeMinutes: relative,
    timeframe,
    issues: issues.length > 0 ? issues : undefined,
  };
}

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

export function toEngineTs(date: string, hour: number, minute: number): number {
  const [y, mo, d] = date.split('-').map((n) => parseInt(n, 10));

  const firstSunday = (year: number, month0: number) => {
    const firstDayEpoch = Math.floor(Date.UTC(year, month0, 1) / 86400000);
    const dow = (firstDayEpoch + 4) % 7; // 0 = Sunday
    return 1 + (7 - dow) % 7;
  };
  const dstStart = (year: number) => firstSunday(year, 2) + 7; // second Sunday in March
  const dstEnd = (year: number) => firstSunday(year, 10);      // first Sunday in November

  const isDst =
    (mo > 3 && mo < 11) ||
    (mo === 3 && d >= dstStart(y)) ||
    (mo === 11 && d < dstEnd(y));
  const offsetHours = isDst ? 4 : 5;

  return Math.floor(Date.UTC(y, mo - 1, d, hour, minute, 0) / 1000) + offsetHours * 60 * 60;
}

export function toEtTime(ts: number, date: string): { hour: number; minute: number } {
  const [y, mo, d] = date.split('-').map((n) => parseInt(n, 10));

  const firstSunday = (year: number, month0: number) => {
    const firstDayEpoch = Math.floor(Date.UTC(year, month0, 1) / 86400000);
    const dow = (firstDayEpoch + 4) % 7; // 0 = Sunday
    return 1 + (7 - dow) % 7;
  };
  const dstStart = (year: number) => firstSunday(year, 2) + 7; // second Sunday in March
  const dstEnd = (year: number) => firstSunday(year, 10);      // first Sunday in November

  const isDst =
    (mo > 3 && mo < 11) ||
    (mo === 3 && d >= dstStart(y)) ||
    (mo === 11 && d < dstEnd(y));

  const offsetHours = isDst ? 4 : 5;
  const etDate = new Date((ts - offsetHours * 60 * 60) * 1000);
  return { hour: etDate.getUTCHours(), minute: etDate.getUTCMinutes() };
}

export function formatTime(t: { hour: number; minute: number }): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function waitForCandleAt(ctx: PlannerContext, targetTs: number, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = ctx.chartRef?.current?.getRecentCandles(1)?.[0];
    // The candle must be at or just after the target, not an old candle from
    // before the seek. 600 seconds gives a generous window around the target.
    if (c && c.timestamp >= targetTs && c.timestamp - targetTs <= 600) return true;
    await wait(100);
  }
  return false;
}

function currentCandleTs(world: WorldState): number | undefined {
  const c = world.recentCandles[world.recentCandles.length - 1];
  return c?.timestamp;
}

interface DataRange {
  first: number;
  last: number;
}

async function loadDataRange(ctx: PlannerContext, symbol: string, date: string): Promise<DataRange | null> {
  try {
    const res = await fetchCandles({ symbol, date, timeframe: 1, limit: 5000, dataDir: ctx.dataDir }, ctx.apiBase);
    if (res.missing || res.candles.length === 0) return null;
    return {
      first: res.candles[0].timestamp,
      last: res.candles[res.candles.length - 1].timestamp,
    };
  } catch {
    return null;
  }
}

async function waitForChartReady(ctx: PlannerContext, symbol: string, date: string, timeoutMs = 8000): Promise<boolean> {
  const expectedOpen = toEngineTs(date, 9, 30);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = ctx.getState();
    if (state.symbol === symbol && state.replayDate === date) {
      const all = ctx.chartRef?.current?.getRecentCandles(1);
      if (all && all.length > 0) {
        const first = all[0];
        if (first.timestamp >= expectedOpen && first.timestamp <= toEngineTs(date, 16, 0)) {
          return true;
        }
      }
    }
    await wait(150);
  }
  return false;
}

async function switchSession(ctx: PlannerContext, symbol: string, date: string): Promise<PlanResult> {
  console.log('[planner-trace] switchSession start:', { symbol, date, dataDir: ctx.dataDir });
  const world = buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog);
  if (world.session.symbol === symbol && world.session.date === date) {
    return { ok: true, message: `Already on ${symbol} ${date}.`, executed: true };
  }

  const probe = await fetchCandles({ symbol, date, timeframe: 1, limit: 1, dataDir: ctx.dataDir }, ctx.apiBase);
  console.log('[planner-trace] switchSession probe:', { symbol, date, missing: probe.missing, count: probe.candles.length, fallbackDate: probe.fallbackDate });
  if (probe.missing) {
    console.log('[planner-trace] switchSession failed: no market data');
    return { ok: false, message: `No market data for ${symbol} on ${date}.`, executed: false };
  }
  const sessionDate = probe.fallbackDate ?? date;

  ctx.chartRef?.current?.resetChart();
  console.log('[planner-trace] switchSession calling onSwitchSymbol:', { symbol, sessionDate });
  await ctx.onSwitchSymbol(symbol, sessionDate);

  const ready = await waitForChartReady(ctx, symbol, sessionDate);
  console.log('[planner-trace] switchSession chart ready:', ready, { symbol, sessionDate });
  if (!ready) {
    console.log('[planner-trace] switchSession failed: chart not ready');
    return { ok: false, message: `Switched to ${symbol}, but the chart didn't load in time for ${sessionDate}.`, executed: false };
  }

  const result = sessionDate !== date
    ? { ok: true, message: `${date} isn't a trading day for ${symbol}; used the nearest available date ${sessionDate} instead.`, executed: true }
    : { ok: true, message: `Switched to ${symbol} on ${sessionDate}.`, executed: true };
  console.log('[planner-trace] switchSession success:', result);
  return result;
}

async function ensureSessionForCommand(cmd: ChartCommand, ctx: PlannerContext): Promise<PlanResult | null> {
  const world = buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog);
  const symbol = cmd.symbol ?? world.session.symbol;
  const date = cmd.date ?? world.session.date;

  if (!symbol) {
    return { ok: false, message: 'Please tell me which stock to use, e.g. "switch to AAPL" or "fast forward AAPL to 1:47pm".', executed: false };
  }
  if (!date) {
    return { ok: false, message: 'Please select a date first, or include one in your message.', executed: false };
  }

  const isSwitch = cmd.intent === 'switch';
  const needsSession =
    isSwitch || (cmd.symbol && cmd.symbol !== world.session.symbol) || (cmd.date && cmd.date !== world.session.date);

  if (needsSession) {
    const res = await switchSession(ctx, symbol, date);
    if (!res.ok) return res;
    if (isSwitch) return res;
  } else if (isSwitch) {
    return { ok: true, message: `Already on ${symbol} on ${date}.`, executed: true };
  }
  return null;
}

function clampSpeed(s?: number): number {
  if (s === undefined) return 10;
  return Math.max(1, Math.min(100, s));
}

export async function executeChartCommand(cmd: ChartCommand, ctx: PlannerContext): Promise<PlanResult> {
  const { send, dispatch, onMessage, getState } = ctx;
  console.log('[planner-trace] executeChartCommand start:', JSON.parse(JSON.stringify(cmd)));

  const handlePause = (): PlanResult => {
    send({ cmd: 'pause' });
    dispatch({ type: 'SET_PLAYING', isPlaying: false });
    return { ok: true, message: 'Paused.', executed: true };
  };

  if (cmd.intent === 'pause') return handlePause();

  if (cmd.intent === 'step_forward') {
    send({ cmd: 'next_candle' });
    return { ok: true, message: 'Advanced one candle.', executed: true };
  }

  if (cmd.intent === 'step_backward') {
    send({ cmd: 'rewind' });
    return { ok: true, message: 'Rewound one candle.', executed: true };
  }

  if (cmd.intent === 'set_speed') {
    const speed = clampSpeed(cmd.speed);
    send({ cmd: 'set_speed', speed });
    dispatch({ type: 'SET_SPEED', speed });
    return { ok: true, message: `Speed set to ${speed}x.`, executed: true };
  }

  const worldBefore = buildWorldState(getState(), ctx.chartRef, ctx.performanceLog);
  console.log('[planner-trace] ensureSessionForCommand input:', { intent: cmd.intent, symbol: cmd.symbol, date: cmd.date, currentSymbol: worldBefore.session.symbol, currentDate: worldBefore.session.date });
  const switchResult = await ensureSessionForCommand(cmd, ctx);
  console.log('[planner-trace] ensureSessionForCommand result:', switchResult);
  if (switchResult) return switchResult;

  const world = buildWorldState(getState(), ctx.chartRef, ctx.performanceLog);
  const symbol = world.session.symbol;
  const date = world.session.date;
  const didSwitch = worldBefore.session.symbol !== symbol || worldBefore.session.date !== date;

  if (cmd.intent === 'set_timeframe') {
    const tf = clampTimeframe(cmd.timeframe);
    console.log('[planner-trace] set_timeframe step:', { tf, symbol, date, didSwitch });
    if (tf === undefined) {
      return { ok: false, message: 'Please tell me which timeframe to use (1m, 5m, 15m, 1h, 4h, daily).', executed: false };
    }
    send({ cmd: 'set_timeframe', minutes: tf });
    dispatch({ type: 'SET_TIMEFRAME', timeframe: tf });
    const message = didSwitch
      ? `Switched to ${symbol} on ${date} and set timeframe to ${formatTimeframe(tf)}.`
      : `Timeframe set to ${formatTimeframe(tf)}.`;
    console.log('[planner-trace] set_timeframe complete:', message);
    return { ok: true, message, executed: true };
  }

  const nowTs = currentCandleTs(world);
  let startTs: number | undefined;
  let endTs: number | undefined;

  if (cmd.startTime) startTs = toEngineTs(date, cmd.startTime.hour, cmd.startTime.minute);
  if (cmd.endTime) endTs = toEngineTs(date, cmd.endTime.hour, cmd.endTime.minute);

  if (cmd.relativeMinutes !== undefined && nowTs) {
    const delta = cmd.relativeMinutes * 60;
    if (cmd.direction === 'backward') {
      endTs = nowTs - delta;
      startTs = startTs ?? nowTs;
    } else {
      endTs = nowTs + delta;
      startTs = startTs ?? nowTs;
    }
  }

  // Resolve direction.
  const direction = cmd.direction ?? (cmd.intent === 'rewind' ? 'backward' : 'forward');

  // Don't seek or play toward a timestamp that doesn't exist in the loaded data.
  // If a switch was requested, still perform the switch before reporting the issue.
  const targetTimestamps = [startTs, endTs].filter((x): x is number => x !== undefined);
  const needsRangeCheck =
    targetTimestamps.length > 0 &&
    (cmd.intent === 'seek' ||
      cmd.intent === 'fast_forward' ||
      cmd.intent === 'rewind' ||
      (cmd.intent === 'play' && endTs !== undefined));

  let dataRange: DataRange | null = null;
  if (needsRangeCheck) {
    dataRange = await loadDataRange(ctx, symbol, date);
    if (dataRange) {
      for (const ts of targetTimestamps) {
        if (ts > dataRange.last) {
          // Common-sense: a PM time after market close is likely an AM typo.
          if (
            endTs !== undefined &&
            ts === endTs &&
            cmd.endTime &&
            cmd.endTime.hour > 16
          ) {
            const amHour = cmd.endTime.hour - 12;
            const amTs = toEngineTs(date, amHour, cmd.endTime.minute);
            if (amTs >= dataRange.first && amTs <= dataRange.last) {
              onMessage?.(
                `You said ${formatTime({ hour: cmd.endTime.hour, minute: cmd.endTime.minute })}pm, but the market closes at ${formatTime(toEtTime(dataRange.last, date))}. I'll use ${formatTime({ hour: amHour, minute: cmd.endTime.minute })}am instead.`
              );
              endTs = amTs;
              continue;
            }
          }

          // A 4:00 PM target lines up with the close of the last 1m bar (3:59 PM
          // open -> 4:00 PM close). Nudge it back instead of rejecting.
          if (ts - dataRange.last <= 60) {
            if (ts === startTs) startTs = dataRange.last;
            if (ts === endTs) endTs = dataRange.last;
            continue;
          }

          const targetStr = formatTime(toEtTime(ts, date));
          const boundaryStr = formatTime(toEtTime(dataRange.last, date));
          const label =
            cmd.intent === 'seek'
              ? `seek to ${targetStr}`
              : cmd.intent === 'rewind'
              ? `rewind to ${targetStr}`
              : cmd.intent === 'play'
              ? `play to ${targetStr}`
              : `fast-forward to ${targetStr}`;
          const reason = `the data for ${symbol} on ${date} only goes up to ${boundaryStr}, so I can't ${label}.`;
          const message = didSwitch ? `Switched to ${symbol} on ${date}, but ${reason}` : reason;
          return { ok: false, message, executed: false };
        }

        if (ts < dataRange.first) {
          const targetStr = formatTime(toEtTime(ts, date));
          const boundaryStr = formatTime(toEtTime(dataRange.first, date));
          const label =
            cmd.intent === 'seek'
              ? `seek to ${targetStr}`
              : cmd.intent === 'rewind'
              ? `rewind to ${targetStr}`
              : cmd.intent === 'play'
              ? `play to ${targetStr}`
              : `fast-forward to ${targetStr}`;
          const reason = `the market opens at ${boundaryStr} for ${symbol} on ${date}, so I can't ${label}.`;
          const message = didSwitch ? `Switched to ${symbol} on ${date}, but ${reason}` : reason;
          return { ok: false, message, executed: false };
        }
      }
    }
  }

  // Common-sense: if the user is already past a forward target, start the
  // playback from market open and run forward to it. This handles "run to 2pm"
  // when the chart is already at 4pm at the end of the day.
  if (
    dataRange &&
    nowTs !== undefined &&
    endTs !== undefined &&
    direction === 'forward' &&
    (cmd.intent === 'fast_forward' || (cmd.intent === 'play' && cmd.startTime === undefined && cmd.relativeMinutes === undefined)) &&
    endTs < nowTs &&
    cmd.startTime === undefined &&
    cmd.relativeMinutes === undefined &&
    nowTs >= dataRange.last
  ) {
    onMessage?.(
      `Already past ${formatTime(toEtTime(endTs, date))}, so I'll restart from market open and fast-forward there.`
    );
    startTs = dataRange.first;
  }

  if (cmd.intent === 'seek') {
    const target = startTs ?? endTs;
    console.log('[planner-trace] seek step:', { target, startTs, endTs, symbol, date });
    if (target === undefined) {
      return { ok: false, message: 'Tell me what time to seek to, e.g. "seek to 1:47pm".', executed: false };
    }
    send({ cmd: 'seek', timestamp: target });
    const arrived = await waitForCandleAt(ctx, target, 5000);
    if (!arrived) return { ok: false, message: 'Could not seek to the requested time.', executed: false };
    return { ok: true, message: `Seeking to ${formatTime(toEtTime(target, date))}.`, executed: true };
  }

  if (cmd.intent === 'fast_forward' || cmd.intent === 'rewind' || cmd.intent === 'play') {
    const speed = clampSpeed(cmd.speed ?? (cmd.intent === 'play' ? world.session.speed : undefined));

    if (cmd.intent === 'play' && endTs === undefined) {
      send({ cmd: 'play', direction, speed });
      dispatch({ type: 'SET_PLAYING', isPlaying: true });
      dispatch({ type: 'SET_SPEED', speed });
      return { ok: true, message: `Playing ${direction} at ${speed}x.`, executed: true };
    }

    if (endTs === undefined) {
      return { ok: false, message: 'Tell me what time to stop at, e.g. "fast forward to 1:47pm".', executed: false };
    }

    // Seek to explicit start if the user gave one or if we decided to restart.
    if (startTs !== undefined && startTs !== nowTs) {
      send({ cmd: 'seek', timestamp: startTs });
      const arrived = await waitForCandleAt(ctx, startTs, 5000);
      if (!arrived) return { ok: false, message: 'Could not seek to the start time.', executed: false };
    }

    console.log('[planner-trace] play step:', { direction, speed, startTs, endTs, symbol, date });
    send({ cmd: 'play', direction, speed, until: endTs });
    dispatch({ type: 'SET_PLAYING', isPlaying: true });
    dispatch({ type: 'SET_SPEED', speed });

    // Poll briefly for completion and then report the pause. The engine broadcasts
    // session_state when it auto-pauses at the stop timestamp.
    const startWait = Date.now();
    const waitForPause = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const st = getState();
        if (!st.isPlaying || Date.now() - startWait > 120000) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
    await waitForPause;

    return {
      ok: true,
      message: `Paused at ${formatTime(toEtTime(endTs, date))}.`,
      executed: true,
    };
  }

  return { ok: false, message: "I'm not sure how to do that. Try rephrasing with a symbol, date, and/or time.", executed: false };
}

function normalizeLLMIntent(raw: unknown): ChartIntent | undefined {
  if (typeof raw !== 'string') return undefined;
  const i = raw.toLowerCase().replace(/\s+/g, '_');
  const allowed: ChartIntent[] = [
    'switch',
    'fast_forward',
    'rewind',
    'play',
    'pause',
    'seek',
    'set_speed',
    'set_timeframe',
    'step_forward',
    'step_backward',
    'unknown',
  ];
  if (allowed.includes(i as ChartIntent)) return i as ChartIntent;
  if (i === 'fastforward' || i === 'fast_forward' || i === 'ff') return 'fast_forward';
  if (i === 'step_forward' || i === 'next') return 'step_forward';
  if (i === 'step_backward' || i === 'previous' || i === 'back_one') return 'step_backward';
  if (i === 'set_speed') return 'set_speed';
  return undefined;
}

function normalizeLLMTime(raw: unknown): ParsedTime | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as { hour?: unknown; minute?: unknown };
  const h = typeof t.hour === 'number' ? t.hour : parseInt(String(t.hour), 10);
  const m = typeof t.minute === 'number' ? t.minute : parseInt(String(t.minute), 10);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return undefined;
  return { hour: h, minute: m };
}

export async function parseChartCommandWithLLM(
  text: string,
  availableTickers: string[],
  world: WorldState,
  signal?: AbortSignal
): Promise<ChartCommand | null> {
  const example: ChartCommand = {
    intent: 'fast_forward',
    symbol: 'AAPL',
    date: '2026-07-28',
    startTime: undefined,
    endTime: { hour: 14, minute: 0 },
    speed: 10,
    direction: 'forward',
    relativeMinutes: undefined,
    timeframe: undefined,
  };

  const currentCandle = world.recentCandles[world.recentCandles.length - 1];
  const currentEt = currentCandle ? formatTime(toEtTime(currentCandle.timestamp, world.session.date)) : 'unknown';

  const system = [
    'You are the chart-control parser for OpenRewind. Convert the user message into a single JSON command object.',
    `Available tickers: ${availableTickers.join(', ')}.`,
    `Current session: ${world.session.symbol} on ${world.session.date}. Cursor: ${world.session.cursor}/${world.session.totalCandles}. Current candle time (ET): ${currentEt}.`,
    'Output ONLY a JSON object and nothing else. Use null for missing/unknown fields.',
    'JSON schema (null means optional/absent):',
    JSON.stringify(example, null, 2),
    'Valid intents: switch, fast_forward, rewind, play, pause, seek, set_speed, set_timeframe, step_forward, step_backward, unknown.\nThe "timeframe" field is minutes per bar: 1, 5, 15, 60, 240, or 1440 (daily).',
    'Times are 24-hour objects with "hour" and "minute". Use "unknown" intent if the message is not a chart command.',
    'Examples:',
    JSON.stringify({ intent: 'fast_forward', symbol: null, date: null, startTime: null, endTime: { hour: 14, minute: 0 }, speed: 10, direction: 'forward', relativeMinutes: null, timeframe: null }),
    JSON.stringify({ intent: 'switch', symbol: 'AAPL', date: '2026-07-28', startTime: null, endTime: null, speed: null, direction: null, relativeMinutes: null, timeframe: null }),
    JSON.stringify({ intent: 'set_timeframe', symbol: null, date: null, startTime: null, endTime: null, speed: null, direction: null, relativeMinutes: null, timeframe: 5 }),
    JSON.stringify({ intent: 'unknown' }),
  ].join('\n');

  try {
    const response = await orionChat({
      tier: 'chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      signal,
    });

    const content = response.content || '';
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;

    const raw = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    const intent = normalizeLLMIntent(raw.intent);
    if (!intent || intent === 'unknown') return null;

    let symbol: string | undefined =
      typeof raw.symbol === 'string' ? raw.symbol.toUpperCase() : undefined;
    if (symbol && !availableTickers.includes(symbol)) {
      // The LLM may return a lowercase name; try aliases.
      const aliased = (ALIASES as Record<string, string>)[symbol.toLowerCase()];
      if (aliased && availableTickers.includes(aliased)) {
        symbol = aliased;
      } else {
        symbol = undefined;
      }
    }

    const date = typeof raw.date === 'string' ? parseDate(raw.date, world.session.date) : undefined;
    const startTime = normalizeLLMTime(raw.startTime);
    const endTime = normalizeLLMTime(raw.endTime);
    const speed = typeof raw.speed === 'number' ? clampSpeed(raw.speed) : undefined;
    const direction =
      raw.direction === 'forward' || raw.direction === 'backward' ? raw.direction : undefined;
    const relativeMinutes =
      typeof raw.relativeMinutes === 'number' ? Math.max(1, Math.round(raw.relativeMinutes)) : undefined;
    const timeframe = clampTimeframe(typeof raw.timeframe === 'number' ? raw.timeframe : undefined);

    return {
      intent,
      symbol,
      date,
      startTime,
      endTime,
      speed,
      direction,
      relativeMinutes,
      timeframe,
    };
  } catch {
    return null;
  }
}

export function buildPlannerContext(
  deps: Omit<PlannerContext, 'getState'>,
  getState: () => AppState
): PlannerContext {
  return { ...deps, getState };
}
