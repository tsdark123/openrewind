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
  const dayMatch = /\b(?:last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (dayMatch) {
    const target = days.indexOf(dayMatch[1]);
    const direction = dayMatch[0].startsWith('last ') ? 'last' : 'last';
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
  };
  const digit = parseInt(n, 10);
  if (!Number.isNaN(digit)) return digit;
  return map[n.toLowerCase()];
}

export function extractDateInput(text: string, baseDate?: string): DateInputSpec | undefined {
  const t = text.toLowerCase();
  const anchor = baseDate || new Date().toISOString().slice(0, 10);

  const tradingMatch = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+trading\s+(?:session|day)s?\s+(ago|back|before)\b/.exec(t);
  if (tradingMatch) {
    const n = numberWord(tradingMatch[1]);
    if (n !== undefined) {
      return { kind: 'relative_trading', count: n, direction: 'backward', from: anchor };
    }
  }

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

function parse24hTime(hour: number, minute: number, meridian?: string): ParsedTime | null {
  let h = hour;
  const m = minute;
  const md = (meridian || '').toLowerCase();
  if (md === 'am' && h === 12) h = 0;
  if (md === 'pm' && h !== 12) h += 12;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { hour: h, minute: m };
}

function extractTimes(text: string): ParsedTime[] {
  const matches: { time: ParsedTime; index: number }[] = [];
  const seen = new Set<string>();

  const add = (h: number, m: number, index: number, meridian?: string) => {
    const t = parse24hTime(h, m, meridian);
    if (!t) return;
    const key = `${t.hour}:${t.minute}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ time: t, index });
  };

  // "2:30pm", "14:00", etc.
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\b/gi)) {
    add(parseInt(m[1], 10), parseInt(m[2], 10), m.index ?? 0, m[3]);
  }

  // "2pm", "2 pm" — speed markers like "10x" are ignored because they lack am/pm.
  for (const m of text.matchAll(/\b(\d{1,2})\s*(am|pm)\b/gi)) {
    add(parseInt(m[1], 10), 0, m.index ?? 0, m[2]);
  }

  const marketOpen = /\bmarket\s+open\b/i.exec(text);
  if (marketOpen && marketOpen.index !== undefined) add(9, 30, marketOpen.index, undefined);

  const marketClose = /\bmarket\s+close\b/i.exec(text);
  if (marketClose && marketClose.index !== undefined) add(16, 0, marketClose.index, undefined);

  const noon = /\b(noon|midday)\b/i.exec(text);
  if (noon && noon.index !== undefined) add(12, 0, noon.index, undefined);

  const midnight = /\bmidnight\b/i.exec(text);
  if (midnight && midnight.index !== undefined) add(0, 0, midnight.index, undefined);

  // Sort by the position the expression appeared in the original text so that
  // "from X to Y" yields X as startTime and Y as endTime.
  matches.sort((a, b) => a.index - b.index);
  return matches.map((m) => m.time);
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
    /\b(?:on|at)(?:\s+(?:like|about|around|roughly|maybe|approx|approximately))?\s+(\d{1,3})(?![\d:]|\s*(?:am|pm)\b)\b/i
  );
  if (bare) {
    const n = parseInt(bare[1], 10);
    return Math.max(1, Math.min(100, n));
  }
  return undefined;
}

function extractRelativeMinutes(text: string): number | undefined {
  const m = text.match(/(?:another\s+)?(\d+(?:\.\d+)?)\s*(?:more\s+|extra\s+)?(?:min|minute|hour|hr)s?\b/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2]?.toLowerCase() || '';
  if (Number.isNaN(n) || n <= 0) return undefined;
  if (unit.startsWith('hour') || unit.startsWith('hr')) return Math.round(n * 60);
  return Math.round(n);
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
  const n = Number.isFinite(tf) ? Math.max(1, Math.round(tf)) : 1;
  return SUPPORTED_TIMEFRAMES.includes(n as any) ? n : undefined;
}

function extractTimeframe(text: string): number | undefined {
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

  // Phrases like "5 minute timeframe", "1 hour chart", "1 day bars".
  const hasTimeframeContext = /\b(timeframe|tf|chart|bars)\b/.test(t);
  if (hasTimeframeContext) {
    const m = /\b(\d+(?:\.\d+)?)\s*(?:minute|hour|day)s?\b/.exec(t);
    if (m) {
      const n = parseFloat(m[1]);
      if (!Number.isNaN(n) && n > 0) {
        const unit = t.charAt(m.index + m[0].length - 1);
        if (/m/.test(unit)) {
          const rounded = Math.round(n);
          if (SUPPORTED_TIMEFRAMES.includes(rounded as any)) return rounded;
        } else if (/h/.test(unit)) {
          const minutes = Math.round(n * 60);
          if (SUPPORTED_TIMEFRAMES.includes(minutes as any)) return minutes;
        } else if (/d/.test(unit)) {
          return 1440;
        }
      }
    }
  }

  return undefined;
}

function detectDirection(text: string, relative?: number): 'forward' | 'backward' | undefined {
  const t = text.toLowerCase();
  if (/(?:fast[- ]?forward|forward|ahead|skip ahead)/.test(t)) return 'forward';
  if (/(?:rewind|reverse|go back|back up|backward|back\b)/.test(t)) return 'backward';
  if (relative !== undefined) {
    if (/\bback(?:ward)?\b/.test(t)) return 'backward';
    if (/\b(?:forward|ahead)\b/.test(t)) return 'forward';
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
  if (/\b(next|step forward|advance one|forward one)\b/i.test(t)) return 'step_forward';
  if (/\b(previous|step back|back one|rewind one)\b/i.test(t)) return 'step_backward';
  if (/\b(jump|seek)\b/i.test(t)) return 'seek';

  // Any explicit or inferred timeframe request takes precedence only when
  // the user is not already naming a symbol/playback sequence.
  if (e.timeframe !== undefined && !e.symbol) return 'set_timeframe';

  // Candle/price queries at a specific time.
  if (e.times.length > 0 && /\b(price|candle|cost|worth|value|ohlcv)\b/i.test(text) && !/\b(play|rewind|fast[- ]?forward|seek|switch|go to|show me)\b/i.test(t)) {
    return 'candle_query';
  }

  // Time-based motion without explicit verb can be inferred from direction.
  if (e.times.length > 0 || e.relative !== undefined) {
    if (/(?:fast[- ]?forward|fastforward|ff|skip ahead|fast forward)\b/i.test(t)) return 'fast_forward';
    if (/(?:rewind|reverse|go back|back up|skip back)\b/i.test(t)) return 'rewind';
    if (/\b(?:play|run)\b/i.test(t)) return e.times.length > 0 || e.relative !== undefined ? 'fast_forward' : 'play';
    if (e.direction === 'backward' || /\bback(?:ward)?\b/i.test(t)) return 'rewind';
    if (e.symbol || e.date || /\b(switch|change to|load|open|show)\b/i.test(t)) {
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
  if (e.symbol || e.date || /\b(switch|change to|load|open|show|go to)\b/i.test(t)) return 'switch';

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
  const times = extractTimes(text);
  const speed = extractSpeed(text);
  const relative = extractRelativeMinutes(text);
  const direction = detectDirection(text, relative);
  const timeframe = extractTimeframe(text);
  const intent = detectIntent(text, { symbol, date: date || undefined, dateInput, times, speed, relative, direction, timeframe });

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
  world: WorldState
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
