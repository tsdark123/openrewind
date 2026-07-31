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

export type ChartIntent =
  | 'switch'
  | 'fast_forward'
  | 'rewind'
  | 'play'
  | 'pause'
  | 'seek'
  | 'set_speed'
  | 'step_forward'
  | 'step_backward'
  | 'unknown';

export interface ParsedTime { hour: number; minute: number; }

export interface ChartCommand {
  intent: ChartIntent;
  symbol?: string;
  date?: string;
  startTime?: ParsedTime;
  endTime?: ParsedTime;
  speed?: number;
  direction?: 'forward' | 'backward';
  relativeMinutes?: number;
}

export interface PlannerContext {
  /** Initial app-state snapshot. */
  appState: AppState;
  /** Live state accessor for waits and re-checks. */
  getState: () => AppState;
  chartRef: { current: ChartHandle | null } | null;
  performanceLog: PerformanceLog;
  apiBase: string;
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

const ALIASES: Record<string, string> = {
  apple: 'AAPL', tesla: 'TSLA', netflix: 'NFLX', amazon: 'AMZN',
  microsoft: 'MSFT', google: 'GOOGL', alphabet: 'GOOGL', meta: 'META',
  facebook: 'META', nvidia: 'NVDA', amd: 'AMD', intel: 'INTC',
  broadcom: 'AVGO', oracle: 'ORCL', salesforce: 'CRM', paypal: 'PYPL',
};

const SKIP = new Set([
  'switch', 'change', 'go', 'to', 'the', 'a', 'an', 'my', 'on', 'im', "i'm", 'current',
  'stock', 'symbol', 'chart', 'load', 'open', 'show', 'please', 'can', 'you', 'of', 'for',
  'in', 'is', 'it', 'this', 'that', 'your', 'our', 'me', 'i', 'be', 'am', 'are', 'and', 'or',
  'if', 'what', 'how', 'do', 'does', 'did', 'with', 'into', 'at', 'by', 'from', 'as',
  'run', 'execute', 'play', 'pause', 'fast', 'forward', 'rewind', 'back', 'seek', 'jump',
]);

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function todayEt(): { y: number; m: number; d: number } {
  // Use the local wall-clock date because the user is in the same timezone
  // as the market. If the clock is off, the fetch fallback will correct it.
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

function offsetDate(offsetDays: number): string {
  const { y, m, d } = todayEt();
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayOfWeekDate(target: number, direction: 'last' | 'next'): string {
  const { y, m, d } = todayEt();
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

function parseRelativeDate(input: string): string | undefined {
  const t = input.toLowerCase();

  if (/\byesterday\b/.test(t)) return offsetDate(-1);
  if (/\b(today|tonight)\b/.test(t)) return offsetDate(0);
  if (/\btomorrow\b/.test(t)) return offsetDate(1);

  if (/\b(?:last|previous)\s+week\b/.test(t)) return offsetDate(-7);
  if (/\bthis\s+week\b/.test(t)) return offsetDate(0);
  if (/\bnext\s+week\b/.test(t)) return offsetDate(7);

  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayMatch = /\b(?:last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (dayMatch) {
    const target = days.indexOf(dayMatch[1]);
    const direction = dayMatch[0].startsWith('last ') ? 'last' : 'last';
    return dayOfWeekDate(target, direction);
  }

  return undefined;
}

function parseDate(input: string): string | undefined {
  const iso = input.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  const slash = input.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;

  const monthRe = MONTHS.join('|');
  const m1 = new RegExp(`\\b(${monthRe})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{2,4}))?\\b`, 'i').exec(input);
  if (m1) {
    const month = String(MONTHS.indexOf(m1[1].toLowerCase()) + 1).padStart(2, '0');
    const day = m1[2].padStart(2, '0');
    const year = m1[3] ? (m1[3].length === 2 ? `20${m1[3]}` : m1[3]) : String(new Date().getFullYear());
    return `${year}-${month}-${day}`;
  }

  const m2 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthRe})[a-z]*(?:\\s+(\\d{2,4}))?\\b`, 'i').exec(input);
  if (m2) {
    const month = String(MONTHS.indexOf(m2[2].toLowerCase()) + 1).padStart(2, '0');
    const day = m2[1].padStart(2, '0');
    const year = m2[3] ? (m2[3].length === 2 ? `20${m2[3]}` : m2[3]) : String(new Date().getFullYear());
    return `${year}-${month}-${day}`;
  }

  return parseRelativeDate(input);
}

function extractSymbolAndDate(
  text: string,
  availableTickers: string[],
  symbolAliases: Record<string, string> = ALIASES
): { symbol?: string; date?: string } {
  const tickerSet = new Set(availableTickers.map((t) => t.toUpperCase()));
  const date = parseDate(text);
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
  const result: ParsedTime[] = [];
  const seen = new Set<string>();

  const add = (h: number, m: number, meridian?: string) => {
    const t = parse24hTime(h, m, meridian);
    if (!t) return;
    const key = `${t.hour}:${t.minute}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(t);
  };

  // "2:30pm", "14:00", etc.
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\b/gi)) {
    add(parseInt(m[1], 10), parseInt(m[2], 10), m[3]);
  }

  // "2pm", "2 pm" — speed markers like "10x" are ignored because they lack am/pm.
  for (const m of text.matchAll(/\b(\d{1,2})\s*(am|pm)\b/gi)) {
    add(parseInt(m[1], 10), 0, m[2]);
  }

  return result;
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
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:min|minute|hour|hr)s?\b/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2]?.toLowerCase() || '';
  if (Number.isNaN(n) || n <= 0) return undefined;
  if (unit.startsWith('hour') || unit.startsWith('hr')) return Math.round(n * 60);
  return Math.round(n);
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
  times: ParsedTime[];
  speed?: number;
  relative?: number;
  direction?: 'forward' | 'backward';
}): ChartIntent {
  const t = text.toLowerCase();

  if (/\b(pause|halt|stop playback|stop the playback|stop the chart)\b/i.test(t)) return 'pause';
  if (/\b(set speed|speed up|slow down)\b/i.test(t)) return 'set_speed';
  if (/\b(next|step forward|advance one|forward one)\b/i.test(t)) return 'step_forward';
  if (/\b(previous|step back|back one|rewind one)\b/i.test(t)) return 'step_backward';
  if (/\b(jump|seek)\b/i.test(t)) return 'seek';

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
  symbolAliases: Record<string, string> = ALIASES
): ChartCommand {
  const { symbol, date } = extractSymbolAndDate(text, availableTickers, symbolAliases);
  const times = extractTimes(text);
  const speed = extractSpeed(text);
  const relative = extractRelativeMinutes(text);
  const direction = detectDirection(text, relative);
  const intent = detectIntent(text, { symbol, date, times, speed, relative, direction });

  return {
    intent,
    symbol,
    date,
    startTime: times.length >= 2 ? times[0] : undefined,
    endTime: times.length >= 1 ? times[times.length - 1] : undefined,
    speed,
    direction,
    relativeMinutes: relative,
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

function toEtTime(ts: number, date: string): { hour: number; minute: number } {
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

function formatTime(t: { hour: number; minute: number }): string {
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
    const res = await fetchCandles({ symbol, date, timeframe: 1, limit: 5000 }, ctx.apiBase);
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
  const world = buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog);
  if (world.session.symbol === symbol && world.session.date === date) {
    return { ok: true, message: `Already on ${symbol} ${date}.`, executed: true };
  }

  ctx.onMessage?.(`Switching to ${symbol}${date ? ` on ${date}` : ''}…`);

  const probe = await fetchCandles({ symbol, date, timeframe: 1, limit: 1 }, ctx.apiBase);
  if (probe.missing) {
    return { ok: false, message: `No market data for ${symbol} on ${date}.`, executed: false };
  }
  const sessionDate = probe.fallbackDate ?? date;

  ctx.chartRef?.current?.resetChart();
  await ctx.onSwitchSymbol(symbol, sessionDate);

  const ready = await waitForChartReady(ctx, symbol, sessionDate);
  if (!ready) {
    return { ok: false, message: `Switched to ${symbol}, but the chart didn't load in time for ${sessionDate}.`, executed: false };
  }
  return { ok: true, message: `Switched to ${symbol} on ${sessionDate}.`, executed: true };
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
  const switchResult = await ensureSessionForCommand(cmd, ctx);
  if (switchResult) return switchResult;

  const world = buildWorldState(getState(), ctx.chartRef, ctx.performanceLog);
  const symbol = world.session.symbol;
  const date = world.session.date;
  const didSwitch = worldBefore.session.symbol !== symbol || worldBefore.session.date !== date;
  const nowTs = currentCandleTs(world);

  // Compute timestamps for time-based commands.
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

    const speedNotice = cmd.speed === undefined ? ' (10x assumed)' : '';

    // Seek to explicit start if the user gave one or if we decided to restart.
    if (startTs !== undefined && startTs !== nowTs) {
      onMessage?.(`Seeking to ${formatTime(toEtTime(startTs, date))}…`);
      send({ cmd: 'seek', timestamp: startTs });
      const arrived = await waitForCandleAt(ctx, startTs, 5000);
      if (!arrived) return { ok: false, message: 'Could not seek to the start time.', executed: false };
    }

    send({ cmd: 'play', direction, speed, until: endTs });
    dispatch({ type: 'SET_PLAYING', isPlaying: true });
    dispatch({ type: 'SET_SPEED', speed });

    const action = direction === 'backward' ? 'Rewinding' : 'Fast-forwarding';
    onMessage?.(`${action} ${symbol} to ${formatTime(toEtTime(endTs, date))}${cmd.speed === undefined ? speedNotice : ''}.`);

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
    'Valid intents: switch, fast_forward, rewind, play, pause, seek, set_speed, step_forward, step_backward, unknown.',
    'Times are 24-hour objects with "hour" and "minute". Use "unknown" intent if the message is not a chart command.',
    'Examples:',
    JSON.stringify({ intent: 'fast_forward', symbol: null, date: null, startTime: null, endTime: { hour: 14, minute: 0 }, speed: 10, direction: 'forward', relativeMinutes: null }),
    JSON.stringify({ intent: 'switch', symbol: 'AAPL', date: '2026-07-28', startTime: null, endTime: null, speed: null, direction: null, relativeMinutes: null }),
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

    const date = typeof raw.date === 'string' ? parseDate(raw.date) : undefined;
    const startTime = normalizeLLMTime(raw.startTime);
    const endTime = normalizeLLMTime(raw.endTime);
    const speed = typeof raw.speed === 'number' ? clampSpeed(raw.speed) : undefined;
    const direction =
      raw.direction === 'forward' || raw.direction === 'backward' ? raw.direction : undefined;
    const relativeMinutes =
      typeof raw.relativeMinutes === 'number' ? Math.max(1, Math.round(raw.relativeMinutes)) : undefined;

    return {
      intent,
      symbol,
      date,
      startTime,
      endTime,
      speed,
      direction,
      relativeMinutes,
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
