// =============================================================================
// Trading-date resolver — pure, dependency-free.
//
// The resolver never issues network calls. All availability information is
// injected as a callback so tests can drive the logic deterministically and
// the capability layer can wire the callback to `/api/candles?symbol=…&date=…`
// (or a preloaded date list) without changing the resolver itself.
//
// Semantics:
//   - EXPLICIT date: the caller wants exactly that date. If it has data, we
//     return it; if not, we report unavailable and (best-effort) include
//     nearest available dates as metadata. We NEVER silently substitute.
//   - RELATIVE-CALENDAR date ("2 days ago"): compute the calendar target,
//     then choose the nearest prior date that has data. Callers get both the
//     requested calendar target and the resolved trading date.
//   - RELATIVE-TRADING-SESSION date ("2 trading days ago"): walk backward
//     through actually-available sessions exactly N times.
//
// Weekends are not hard-coded — the injected availability function is the
// ground truth for what constitutes a trading day.
// =============================================================================

export type DateInputKind = 'explicit' | 'relative_calendar' | 'relative_trading' | 'today';

export interface ExplicitDateInput {
  kind: 'explicit';
  /** YYYY-MM-DD */
  date: string;
}

export interface RelativeCalendarDateInput {
  kind: 'relative_calendar';
  /** Non-negative integer number of days to walk. */
  days: number;
  direction: 'backward' | 'forward';
  /** YYYY-MM-DD anchor date (e.g. today, or the current replay date). */
  from: string;
}

export interface RelativeTradingDateInput {
  kind: 'relative_trading';
  /** Non-negative integer number of trading sessions to walk. */
  sessions: number;
  direction: 'backward' | 'forward';
  from: string;
}

export interface TodayInput {
  kind: 'today';
  from: string;
}

export type TradingDateInput =
  | ExplicitDateInput
  | RelativeCalendarDateInput
  | RelativeTradingDateInput
  | TodayInput;

/**
 * Availability probe. Must be pure with respect to the resolver — the same
 * date should return the same result during a single call. Returns true when
 * the caller has data for `date` (YYYY-MM-DD).
 *
 * Implementations may be synchronous (test harness, preloaded list) or
 * asynchronous (engine probe). We accept both by returning a Promise from
 * every call site of the resolver.
 */
export type DateAvailabilityFn = (date: string) => boolean | Promise<boolean>;

export interface ResolveTradingDateOptions {
  /** Availability probe. */
  hasData: DateAvailabilityFn;
  /**
   * How many candidate dates the resolver may probe before giving up. This
   * prevents runaway loops when the dataset is completely empty.
   * Default: 40 (~2 calendar months of weekdays).
   */
  maxLookback?: number;
  /**
   * When resolving an explicit missing date, also probe nearby dates to
   * populate `nearestAvailable`. Set to 0 to skip. Default: 10.
   */
  nearestAvailableLookback?: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type TradingDateAdjustment =
  | 'none'                     // requested date is available exactly
  | 'walked_back_to_available' // relative_calendar was moved to nearest prior session
  | 'walked_trading_sessions'; // relative_trading walked through available sessions

export interface TradingDateSuccess {
  ok: true;
  /** The date the caller should use, YYYY-MM-DD. */
  date: string;
  /** The date the user originally requested, if different from `date`. */
  requestedDate: string;
  adjustment: TradingDateAdjustment;
  /** Explanation the composer may include verbatim. */
  message: string;
}

export interface TradingDateUnavailable {
  ok: false;
  requestedDate: string;
  message: string;
  /** Nearest prior dates with data, most-recent first. May be empty. */
  nearestAvailable: string[];
}

export type TradingDateResolution = TradingDateSuccess | TradingDateUnavailable;

// ---------------------------------------------------------------------------
// Date arithmetic — timezone-independent, using YYYY-MM-DD strings.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && s === d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

async function probe(hasData: DateAvailabilityFn, date: string): Promise<boolean> {
  return await Promise.resolve(hasData(date));
}

/**
 * Walk backward one calendar day at a time until an available date is found,
 * up to `maxLookback` attempts. Returns null if none found.
 */
async function walkToAvailable(
  hasData: DateAvailabilityFn,
  start: string,
  direction: 'backward' | 'forward',
  maxLookback: number
): Promise<string | null> {
  const step = direction === 'backward' ? -1 : 1;
  let cursor = start;
  for (let i = 0; i < maxLookback; i++) {
    cursor = addDays(cursor, step);
    if (await probe(hasData, cursor)) return cursor;
  }
  return null;
}

async function collectNearest(
  hasData: DateAvailabilityFn,
  start: string,
  n: number
): Promise<string[]> {
  const results: string[] = [];
  if (n <= 0) return results;
  let cursor = start;
  for (let i = 0; i < n * 3 && results.length < n; i++) {
    cursor = addDays(cursor, -1);
    if (await probe(hasData, cursor)) results.push(cursor);
  }
  return results;
}

export async function resolveTradingDate(
  input: TradingDateInput,
  options: ResolveTradingDateOptions
): Promise<TradingDateResolution> {
  const { hasData } = options;
  const maxLookback = options.maxLookback ?? 40;
  const nearestLookback = options.nearestAvailableLookback ?? 10;

  // Fast-fail on malformed input dates.
  if ('from' in input && !isValidDateString(input.from)) {
    return {
      ok: false,
      requestedDate: 'from' in input ? input.from : '',
      message: `Invalid anchor date "${input.from}".`,
      nearestAvailable: [],
    };
  }
  if (input.kind === 'explicit' && !isValidDateString(input.date)) {
    return {
      ok: false,
      requestedDate: input.date,
      message: `Invalid date "${input.date}".`,
      nearestAvailable: [],
    };
  }

  // --- Today: alias for explicit(from). ---
  if (input.kind === 'today') {
    return resolveTradingDate(
      { kind: 'explicit', date: input.from },
      options
    );
  }

  // --- Explicit: honor exactly. Never silently substitute. ---
  if (input.kind === 'explicit') {
    if (await probe(hasData, input.date)) {
      return {
        ok: true,
        date: input.date,
        requestedDate: input.date,
        adjustment: 'none',
        message: `Using ${input.date}.`,
      };
    }
    const nearest = await collectNearest(hasData, input.date, nearestLookback);
    return {
      ok: false,
      requestedDate: input.date,
      message: nearest.length > 0
        ? `No data is available for ${input.date}. Nearest available: ${nearest[0]}.`
        : `No data is available for ${input.date}.`,
      nearestAvailable: nearest,
    };
  }

  // --- Relative calendar: compute calendar target, then walk to nearest available. ---
  if (input.kind === 'relative_calendar') {
    const target = addDays(input.from, input.direction === 'backward' ? -input.days : input.days);
    if (await probe(hasData, target)) {
      return {
        ok: true,
        date: target,
        requestedDate: target,
        adjustment: 'none',
        message: `Using ${target}.`,
      };
    }
    const nearest = await walkToAvailable(hasData, target, input.direction, maxLookback);
    if (!nearest) {
      const nearestList = await collectNearest(hasData, target, nearestLookback);
      return {
        ok: false,
        requestedDate: target,
        message: `No trading session found within ${maxLookback} days ${input.direction === 'backward' ? 'before' : 'after'} ${target}.`,
        nearestAvailable: nearestList,
      };
    }
    return {
      ok: true,
      date: nearest,
      requestedDate: target,
      adjustment: 'walked_back_to_available',
      message: `${target} isn't a trading session; using the nearest available date ${nearest}.`,
    };
  }

  // --- Relative trading: walk through actually-available sessions. ---
  if (input.kind === 'relative_trading') {
    let cursor = input.from;
    let hopsDone = 0;
    const step = input.direction === 'backward' ? -1 : 1;
    // Iterate at most `maxLookback` calendar days total, but count only real hops.
    for (let i = 0; i < maxLookback && hopsDone < input.sessions; i++) {
      cursor = addDays(cursor, step);
      if (await probe(hasData, cursor)) hopsDone += 1;
    }
    if (hopsDone < input.sessions) {
      const nearest = await collectNearest(hasData, input.from, nearestLookback);
      return {
        ok: false,
        requestedDate: cursor,
        message: `Only found ${hopsDone} trading session${hopsDone === 1 ? '' : 's'} ${input.direction === 'backward' ? 'before' : 'after'} ${input.from}; need ${input.sessions}.`,
        nearestAvailable: nearest,
      };
    }
    return {
      ok: true,
      date: cursor,
      requestedDate: cursor,
      adjustment: 'walked_trading_sessions',
      message: `${input.sessions} trading session${input.sessions === 1 ? '' : 's'} ${input.direction === 'backward' ? 'before' : 'after'} ${input.from} is ${cursor}.`,
    };
  }

  // Should be unreachable.
  return {
    ok: false,
    requestedDate: '',
    message: 'Unsupported date input.',
    nearestAvailable: [],
  };
}
