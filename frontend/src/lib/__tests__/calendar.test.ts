import { describe, it, expect } from 'vitest';
import { isCalendarDayDisabled, isCalendarDayUnavailable, formatCalendarDate } from '../calendar';

describe('calendar helpers', () => {
  describe('formatCalendarDate', () => {
    it('formats a local Date as YYYY-MM-DD', () => {
      expect(formatCalendarDate(new Date(2026, 7, 4))).toBe('2026-08-04');
      expect(formatCalendarDate(new Date(2026, 0, 1))).toBe('2026-01-01');
    });
  });

  describe('isCalendarDayDisabled', () => {
    it('disables weekends', () => {
      const saturday = new Date(2026, 7, 1); // Aug 1 2026 is Saturday
      const sunday = new Date(2026, 7, 2);   // Aug 2 2026 is Sunday
      const monday = new Date(2026, 7, 3);
      const range = { min: '2026-07-01', max: '2026-08-31' };
      expect(isCalendarDayDisabled(saturday, range.min, range.max)).toBe(true);
      expect(isCalendarDayDisabled(sunday, range.min, range.max)).toBe(true);
      expect(isCalendarDayDisabled(monday, range.min, range.max)).toBe(false);
    });

    it('disables out-of-range dates', () => {
      const july10 = new Date(2026, 6, 10);
      const aug4 = new Date(2026, 7, 4);
      const sep1 = new Date(2026, 8, 1);
      const range = { min: '2026-07-15', max: '2026-08-04' };
      expect(isCalendarDayDisabled(july10, range.min, range.max)).toBe(true);
      expect(isCalendarDayDisabled(aug4, range.min, range.max)).toBe(false);
      expect(isCalendarDayDisabled(sep1, range.min, range.max)).toBe(true);
    });

    it('disables in-range weekdays that have no local candles', () => {
      const aug3 = new Date(2026, 7, 3); // Monday
      const aug4 = new Date(2026, 7, 4); // Tuesday
      const range = { min: '2026-07-01', max: '2026-08-31' };
      const available = ['2026-08-04'];
      expect(isCalendarDayDisabled(aug3, range.min, range.max, available)).toBe(true);
      expect(isCalendarDayDisabled(aug4, range.min, range.max, available)).toBe(false);
    });

    it('keeps all in-range weekdays clickable when no availability is provided', () => {
      const aug3 = new Date(2026, 7, 3);
      const range = { min: '2026-07-01', max: '2026-08-31' };
      expect(isCalendarDayDisabled(aug3, range.min, range.max)).toBe(false);
    });
  });

  describe('isCalendarDayUnavailable', () => {
    it('marks in-range weekdays without data as unavailable', () => {
      const aug3 = new Date(2026, 7, 3);
      const aug4 = new Date(2026, 7, 4);
      const range = { min: '2026-07-01', max: '2026-08-31' };
      const available = ['2026-08-04'];
      expect(isCalendarDayUnavailable(aug3, range.min, range.max, available)).toBe(true);
      expect(isCalendarDayUnavailable(aug4, range.min, range.max, available)).toBe(false);
    });

    it('does not mark weekends or out-of-range days as unavailable', () => {
      const saturday = new Date(2026, 7, 1);
      const sep1 = new Date(2026, 8, 1);
      const range = { min: '2026-07-01', max: '2026-08-31' };
      const available: string[] = [];
      expect(isCalendarDayUnavailable(saturday, range.min, range.max, available)).toBe(false);
      expect(isCalendarDayUnavailable(sep1, range.min, range.max, available)).toBe(false);
    });
  });
});
