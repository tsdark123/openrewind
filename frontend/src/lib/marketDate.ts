// =============================================================================
// marketDate — timezone-anchored US market-date utilities.
//
// All market-date arithmetic uses the America/New_York calendar so the UI is
// stable regardless of the user's local system timezone.  Pure string parsing
// is used for most operations to avoid midnight / toISOString shifts.
// =============================================================================

const MARKET_TIMEZONE = 'America/New_York';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Format a YYYY-MM-DD string through pure string parsing.  This is independent
 * of the browser's local timezone and always reflects the date represented by
 * the string itself.
 */
export function formatMarketDate(dateStr: string): string {
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);
  if (Number.isNaN(m) || Number.isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) {
    return dateStr;
  }
  return `${MONTH_NAMES[m - 1]} ${d}`;
}

/** Parse year, month, day from a YYYY-MM-DD string as numbers. */
export function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10) - 1;
  const day = parseInt(dateStr.slice(8, 10), 10);
  return { year, month, day };
}

/** Convert a UTC date to the market-timezone YYYY-MM-DD string. */
export function toMarketDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Return the current market date (America/New_York).  Stable across all
 * browser timezones.
 */
export function getMarketDate(now: Date = new Date()): string {
  return toMarketDate(now);
}

/** Get the long-form English day name for a YYYY-MM-DD string. */
export function dayOfWeek(dateStr: string): number {
  const { year, month, day } = parseDateParts(dateStr);
  // Use a fixed UTC noon to avoid local-timezone flips.
  const d = new Date(Date.UTC(year, month, day, 12, 0, 0));
  return d.getUTCDay();
}

export function isWeekend(dateStr: string): boolean {
  const dow = dayOfWeek(dateStr);
  return dow === 0 || dow === 6;
}

/**
 * Add or subtract calendar days from a YYYY-MM-DD string.  Returns a new
 * YYYY-MM-DD string.
 */
export function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const d = new Date(Date.UTC(year, month, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day2 = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day2}`;
}

/**
 * Return the most recent previous market day (weekday) in America/New_York.
 * If `from` is not provided, the current market date is used.
 *
 * We step back from the given date, not the current time, so callers get a
 * stable YYYY-MM-DD that is safe to use for sessions.
 */
export function getPreviousMarketDay(from?: string): string {
  const start = from ?? getMarketDate();
  let d = start;
  d = addDays(d, -1);
  while (isWeekend(d)) {
    d = addDays(d, -1);
  }
  return d;
}

/**
 * Return the last 30-day lookback window for the calendar.  The max date is the
 * previous market day (because same-day data is not guaranteed complete), and
 * the min date is 30 calendar days before it.
 */
export function getCalendarBounds(now: Date = new Date()): { minDate: string; maxDate: string } {
  const maxDate = getPreviousMarketDay(getMarketDate(now));
  const minDate = addDays(maxDate, -30);
  return { minDate, maxDate };
}
