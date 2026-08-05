import { describe, it, expect } from 'vitest';
import { normalizeAnalysisWindow } from '../intent';

describe('normalizeAnalysisWindow', () => {
  it('keeps explicit time ranges when fromTime/toTime are valid', () => {
    const out = normalizeAnalysisWindow({ kind: 'first_hour', fromTime: '10:00', toTime: '11:00' }) as any;
    expect(out).toEqual({ kind: 'time_range', fromTime: '10:00', toTime: '11:00' });
  });

  it('rejects an explicit range that leaves the trading session', () => {
    const original = { kind: 'time_range', fromTime: '08:00', toTime: '17:00' };
    const out = normalizeAnalysisWindow(original) as any;
    expect(out).toBe(original);
  });

  it('rejects an explicit range where from >= to', () => {
    const original = { kind: 'time_range', fromTime: '12:00', toTime: '10:00' };
    const out = normalizeAnalysisWindow(original) as any;
    expect(out).toBe(original);
  });

  it('converts first_N_minutes using a bounded parser', () => {
    const out = normalizeAnalysisWindow({ kind: 'first_30_minutes' }) as any;
    expect(out).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '10:00' });
  });

  it('converts first_45_minutes', () => {
    const out = normalizeAnalysisWindow({ kind: 'first_45_minutes' }) as any;
    expect(out).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '10:15' });
  });

  it('converts last_45_minutes', () => {
    const out = normalizeAnalysisWindow({ kind: 'last_45_minutes' }) as any;
    expect(out).toEqual({ kind: 'time_range', fromTime: '15:15', toTime: '16:00' });
  });

  it('respects the n/minutes property when present', () => {
    const out = normalizeAnalysisWindow({ kind: 'first_n_minutes', n: 60 }) as any;
    expect(out).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '10:30' });
  });

  it('converts first_2_hours to 120 minutes', () => {
    const out = normalizeAnalysisWindow({ kind: 'first_2_hours', n: 2 }) as any;
    expect(out).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '11:30' });
  });

  it('rejects first_N_minutes with N larger than the session', () => {
    const original = { kind: 'first_500_minutes' };
    const out = normalizeAnalysisWindow(original) as any;
    expect(out).toBe(original);
  });

  it('rejects first_0_minutes', () => {
    const original = { kind: 'first_0_minutes' };
    const out = normalizeAnalysisWindow(original) as any;
    expect(out).toBe(original);
  });

  it('rejects an unknown window kind', () => {
    const original = { kind: 'lunch_break' };
    const out = normalizeAnalysisWindow(original) as any;
    expect(out).toBe(original);
  });

  it('does not silently convert an unknown kind to whole_session', () => {
    const original = { kind: 'some_custom_window' };
    const out = normalizeAnalysisWindow(original) as any;
    expect(out.kind).not.toBe('whole_session');
    expect(out).toBe(original);
  });

  it('normalizes window_compare left/right independently', () => {
    const left = normalizeAnalysisWindow({ kind: 'first_30_minutes' }) as any;
    const right = normalizeAnalysisWindow({ kind: 'last_30_minutes' }) as any;
    expect(left).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '10:00' });
    expect(right).toEqual({ kind: 'time_range', fromTime: '15:30', toTime: '16:00' });
  });

  it('rejects a last_N_minutes window that starts before market open', () => {
    const original = { kind: 'last_500_minutes' };
    const out = normalizeAnalysisWindow(original) as any;
    expect(out).toBe(original);
  });

  it('preserves whole_session and up_to_cursor as-is', () => {
    expect(normalizeAnalysisWindow({ kind: 'whole_session' })).toEqual({ kind: 'whole_session' });
    expect(normalizeAnalysisWindow({ kind: 'up_to_cursor' })).toEqual({ kind: 'up_to_cursor' });
  });

  it('converts last-hour aliases to 15:00–16:00', () => {
    expect(normalizeAnalysisWindow({ kind: 'last_hour' })).toEqual({
      kind: 'time_range',
      fromTime: '15:00',
      toTime: '16:00',
    });
    expect(normalizeAnalysisWindow({ kind: 'lasthour' })).toEqual({
      kind: 'time_range',
      fromTime: '15:00',
      toTime: '16:00',
    });
    expect(normalizeAnalysisWindow({ kind: 'final_hour' })).toEqual({
      kind: 'time_range',
      fromTime: '15:00',
      toTime: '16:00',
    });
    expect(normalizeAnalysisWindow({ kind: 'closing_hour' })).toEqual({
      kind: 'time_range',
      fromTime: '15:00',
      toTime: '16:00',
    });
    expect(normalizeAnalysisWindow({ kind: 'last_60_minutes' })).toEqual({
      kind: 'time_range',
      fromTime: '15:00',
      toTime: '16:00',
    });
    expect(normalizeAnalysisWindow({ kind: 'last_60_min' })).toEqual({
      kind: 'time_range',
      fromTime: '15:00',
      toTime: '16:00',
    });
  });

  it('preserves explicit fromTime/toTime over named aliases', () => {
    const out = normalizeAnalysisWindow({ kind: 'last_hour', fromTime: '10:00', toTime: '11:00' }) as any;
    expect(out).toEqual({ kind: 'time_range', fromTime: '10:00', toTime: '11:00' });
  });

  it('leaves truly unknown window kinds invalid', () => {
    const original = { kind: 'lunch_break' };
    const out = normalizeAnalysisWindow(original) as any;
    expect(out).toBe(original);
    expect(out.kind).toBe('lunch_break');
  });
});
