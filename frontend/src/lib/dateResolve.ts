// =============================================================================
// dateResolve — pick a usable session date from a list of locally available
// trading days.  Used by App.tsx for symbol switching and manual date picking.
// =============================================================================

import { formatMarketDate } from './marketDate';

export interface DateResolution {
  date: string;
  fallback: boolean;
  message: string | null;
}

/**
 * Pick a usable session date for a symbol.
 *
 * - If `requested` exists in `available`, use it with no fallback.
 * - Otherwise use the latest available date and return a human-readable
 *   explanation such as "No data for Aug 3. Showing latest available session: Aug 4."
 * - If `available` is empty, return the requested date unchanged with no message
 *   so the caller can surface its own empty-state error.
 */
export function resolveSessionDate(
  requested: string,
  available: string[]
): DateResolution {
  if (available.length === 0) {
    return { date: requested, fallback: false, message: null };
  }
  if (available.includes(requested)) {
    return { date: requested, fallback: false, message: null };
  }
  const latest = available[available.length - 1];
  const requestedFmt = formatMarketDate(requested);
  const latestFmt = formatMarketDate(latest);
  return {
    date: latest,
    fallback: true,
    message: `No data for ${requestedFmt}. Showing latest available session: ${latestFmt}.`,
  };
}
