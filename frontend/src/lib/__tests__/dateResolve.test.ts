import { describe, it, expect } from 'vitest';
import { resolveSessionDate } from '../dateResolve';

describe('resolveSessionDate', () => {
  it('uses the requested date when it is in the available list', () => {
    const result = resolveSessionDate('2026-08-04', ['2026-08-03', '2026-08-04']);
    expect(result.date).toBe('2026-08-04');
    expect(result.fallback).toBe(false);
    expect(result.message).toBeNull();
  });

  it('falls back to the latest available date and returns a message', () => {
    const result = resolveSessionDate('2026-08-04', ['2026-07-06', '2026-07-24', '2026-07-31']);
    expect(result.date).toBe('2026-07-31');
    expect(result.fallback).toBe(true);
    expect(result.message).toContain('No data for Aug 4');
    expect(result.message).toContain('latest available session: Jul 31');
  });

  it('returns the requested date unchanged when no available dates exist', () => {
    const result = resolveSessionDate('2026-08-04', []);
    expect(result.date).toBe('2026-08-04');
    expect(result.fallback).toBe(false);
    expect(result.message).toBeNull();
  });

  it('falls back across a multi-week stale gap', () => {
    const result = resolveSessionDate('2026-08-03', ['2026-07-10']);
    expect(result.date).toBe('2026-07-10');
    expect(result.fallback).toBe(true);
    expect(result.message).toContain('No data for Aug 3');
  });
});
