/**
 * Calendar day helpers used by CalendarPicker.
 *
 * All date math is UTC-anchored to the year/month/day represented by the
 * Date object's *UTC* components, so the calendar is stable for users in any
 * timezone.  Callers should construct dates with Date.UTC or a fixed
 * UTC-noon offset (e.g. new Date(`${date}T12:00:00Z`)).
 */

/**
 * Format a Date as YYYY-MM-DD using UTC components.  This returns the calendar
 * date that the Date was constructed from, independent of the browser's local
 * timezone.
 */
export function formatCalendarDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Determine whether a calendar day should be disabled.
 *
 * - Weekends are always disabled.
 * - Dates outside [minDate, maxDate] are disabled.
 * - When `availableDates` is provided, any in-range weekday not in that set is
 *   disabled (e.g. market holidays with no cached candles).
 */
export function isCalendarDayDisabled(
  date: Date,
  minDate: string,
  maxDate: string,
  availableDates?: string[]
): boolean {
  const dateStr = formatCalendarDate(date);
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return true;
  if (dateStr < minDate || dateStr > maxDate) return true;
  if (availableDates && availableDates.length > 0 && !availableDates.includes(dateStr)) {
    return true;
  }
  return false;
}

/**
 * Returns true when a day is inside the allowed range and is a weekday, but has
 * no local candles.  Used to apply a distinct visual style (e.g. strikethrough).
 */
export function isCalendarDayUnavailable(
  date: Date,
  minDate: string,
  maxDate: string,
  availableDates?: string[]
): boolean {
  const dateStr = formatCalendarDate(date);
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  if (dateStr < minDate || dateStr > maxDate) return false;
  return !!availableDates && availableDates.length > 0 && !availableDates.includes(dateStr);
}
