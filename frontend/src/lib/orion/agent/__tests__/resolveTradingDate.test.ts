import { describe, it, expect } from 'vitest';
import { resolveTradingDate, isValidDateString } from '../resolveTradingDate';

const AVAILABLE_DATES = new Set([
  '2026-07-06',
  '2026-07-07',
  '2026-07-08',
  '2026-07-09',
  '2026-07-10',
  // 2026-07-11 Sat, 2026-07-12 Sun missing
  '2026-07-13',
  '2026-07-14',
  '2026-07-15',
  '2026-07-16',
  '2026-07-17',
  '2026-07-20',
  '2026-07-21',
  '2026-07-22',
  '2026-07-23',
  '2026-07-24',
  '2026-07-27',
  '2026-07-28',
  '2026-07-29',
  '2026-07-30',
  '2026-07-31',
]);
const hasData = (d: string) => AVAILABLE_DATES.has(d);

describe('isValidDateString', () => {
  it('accepts real calendar dates', () => {
    expect(isValidDateString('2026-07-06')).toBe(true);
  });

  it('rejects invalid and malformed dates', () => {
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('not-a-date')).toBe(false);
    expect(isValidDateString('2026-02-30')).toBe(false);
  });
});

describe('explicit dates', () => {
  it('honors an available explicit date with no adjustment', async () => {
    const r = await resolveTradingDate(
      { kind: 'explicit', date: '2026-07-06' },
      { hasData }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.date).toBe('2026-07-06');
      expect(r.adjustment).toBe('none');
    }
  });

  it('does not silently substitute an unavailable explicit date', async () => {
    const r = await resolveTradingDate(
      { kind: 'explicit', date: '2026-07-03' },
      { hasData }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.requestedDate).toBe('2026-07-03');
      expect(r.nearestAvailable).toEqual([]);
    }
  });

  it('reports weekend as unavailable with nearest prior sessions', async () => {
    const r = await resolveTradingDate(
      { kind: 'explicit', date: '2026-07-12' },
      { hasData }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.nearestAvailable).toContain('2026-07-10');
    }
  });
});

describe('relative trading-session dates', () => {
  it('moves exactly two available sessions backward', async () => {
    const r = await resolveTradingDate(
      { kind: 'relative_trading', sessions: 2, direction: 'backward', from: '2026-07-10' },
      { hasData }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.date).toBe('2026-07-08');
      expect(r.adjustment).toBe('walked_trading_sessions');
    }
  });

  it('reports insufficient history accurately', async () => {
    const sparse = new Set(['2026-07-06', '2026-07-07']);
    const r = await resolveTradingDate(
      { kind: 'relative_trading', sessions: 5, direction: 'backward', from: '2026-07-10' },
      { hasData: (d) => sparse.has(d) }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/Only found/i);
    }
  });
});

describe('relative calendar dates', () => {
  it('walks to nearest prior session when target is a weekend', async () => {
    // 2026-07-13 Monday. Two calendar days ago is 2026-07-11 (Saturday, no data).
    // Nearest prior session is 2026-07-10.
    const r = await resolveTradingDate(
      { kind: 'relative_calendar', days: 2, direction: 'backward', from: '2026-07-13' },
      { hasData }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.requestedDate).toBe('2026-07-11');
      expect(r.date).toBe('2026-07-10');
      expect(r.adjustment).toBe('walked_back_to_available');
    }
  });

  it('fails cleanly when no sessions are ever available', async () => {
    const r = await resolveTradingDate(
      { kind: 'relative_calendar', days: 2, direction: 'backward', from: '2026-07-10' },
      { hasData: () => false, maxLookback: 5 }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/No trading session found/i);
    }
  });
});

describe('edge cases', () => {
  it('handles empty datasets with empty nearest list', async () => {
    const r = await resolveTradingDate(
      { kind: 'explicit', date: '2026-07-15' },
      { hasData: () => false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.nearestAvailable).toEqual([]);
  });

  it('resolves today via explicit path', async () => {
    const r = await resolveTradingDate(
      { kind: 'today', from: '2026-07-06' },
      { hasData }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.date).toBe('2026-07-06');
  });
});
