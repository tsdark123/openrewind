/**
 * Calendar day helpers used by CalendarPicker.
 */

/**
 * Format a local Date as YYYY-MM-DD.  Uses local date components so timezone
 * conversion does not shift the displayed day and accidentally grey out valid
 * weekdays.
 */
export function formatCalendarDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
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
  const day = date.getDay();
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
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  if (dateStr < minDate || dateStr > maxDate) return false;
  return !!availableDates && availableDates.length > 0 && !availableDates.includes(dateStr);
}
