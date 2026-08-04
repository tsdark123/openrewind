import { describe, it, expect } from 'vitest';
import {
  formatMarketDate,
  getMarketDate,
  toMarketDate,
  addDays,
  isWeekend,
  getPreviousMarketDay,
  getCalendarBounds,
} from '../marketDate';

describe('marketDate', () => {
  describe('formatMarketDate', () => {
    it('renders Aug 4 without constructing a Date', () => {
      expect(formatMarketDate('2026-08-04')).toBe('Aug 4');
      expect(formatMarketDate('2026-01-01')).toBe('Jan 1');
      expect(formatMarketDate('2026-12-25')).toBe('Dec 25');
    });

    it('returns the input when malformed', () => {
      expect(formatMarketDate('not-a-date')).toBe('not-a-date');
    });
  });

  describe('toMarketDate', () => {
    it('maps UTC instants to the America/New_York calendar date', () => {
      // 2026-08-05 04:00 UTC == 2026-08-05 00:00 EDT
      expect(toMarketDate(new Date('2026-08-05T04:00:00Z'))).toBe('2026-08-05');
      // 2026-08-05 03:59 UTC == 2026-08-04 23:59 EDT
      expect(toMarketDate(new Date('2026-08-05T03:59:00Z'))).toBe('2026-08-04');
    });

    it('is stable across representative global timezones', () => {
      const cases = [
        // America/Los_Angeles: 2026-08-04 21:00 PDT (UTC-7) = 2026-08-05 04:00 UTC -> NY 00:00 08-05
        { input: new Date('2026-08-04T21:00:00-07:00'), want: '2026-08-05' },
        // America/New_York: 2026-08-05 00:30 EDT = 2026-08-05 04:30 UTC -> NY 00:30 08-05
        { input: new Date('2026-08-05T00:30:00-04:00'), want: '2026-08-05' },
        // Europe/London: 2026-08-05 06:00 BST (UTC+1) = 2026-08-05 05:00 UTC -> NY 01:00 08-05
        { input: new Date('2026-08-05T06:00:00+01:00'), want: '2026-08-05' },
        // Asia/Tokyo: 2026-08-05 14:00 JST (UTC+9) = 2026-08-05 05:00 UTC -> NY 01:00 08-05
        { input: new Date('2026-08-05T14:00:00+09:00'), want: '2026-08-05' },
      ];
      for (const c of cases) {
        expect(toMarketDate(c.input), `${c.input.toISOString()}`).toBe(c.want);
      }
    });
  });

  describe('addDays / isWeekend', () => {
    it('adds and subtracts calendar days', () => {
      expect(addDays('2026-08-04', 1)).toBe('2026-08-05');
      expect(addDays('2026-08-04', -1)).toBe('2026-08-03');
      expect(addDays('2026-08-04', 31)).toBe('2026-09-04');
    });

    it('detects weekends', () => {
      expect(isWeekend('2026-08-01')).toBe(true); // Saturday
      expect(isWeekend('2026-08-02')).toBe(true); // Sunday
      expect(isWeekend('2026-08-03')).toBe(false); // Monday
      expect(isWeekend('2026-08-04')).toBe(false); // Tuesday
    });
  });

  describe('getPreviousMarketDay', () => {
    it('steps back from a weekday to the prior weekday, skipping weekends', () => {
      expect(getPreviousMarketDay('2026-08-04')).toBe('2026-08-03');
      expect(getPreviousMarketDay('2026-08-03')).toBe('2026-07-31');
      expect(getPreviousMarketDay('2026-08-01')).toBe('2026-07-31');
    });
  });

  describe('getCalendarBounds', () => {
    it('returns a 30-day window ending on the previous market day', () => {
      const now = new Date('2026-08-04T15:00:00-04:00'); // Tuesday mid-day NY
      const { minDate, maxDate } = getCalendarBounds(now);
      expect(maxDate).toBe('2026-08-03');
      expect(minDate).toBe('2026-07-04');
    });
  });
});
