import { describe, it, expect } from 'vitest';
import { resolveAnalysisInheritance } from '../intentCompiler';
import type { AnalysisRequest } from '../types';

const firstHour: AnalysisRequest = {
  kind: 'window_ohlc',
  window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' },
};

const firstHourVolume: AnalysisRequest = {
  kind: 'window_volume',
  window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' },
};

const lastHour: AnalysisRequest = {
  kind: 'window_ohlc',
  window: { kind: 'time_range', fromTime: '15:00', toTime: '16:00' },
};

describe('resolveAnalysisInheritance', () => {
  it('inherits the prior window for short metric follow-ups', () => {
    for (const text of ['what about volume?', 'how about volume?', 'and the volume?', 'show me volume too']) {
      const current: AnalysisRequest[] = [{ kind: 'window_volume', window: { kind: 'whole_session' } }];
      const result = resolveAnalysisInheritance(current, [firstHour], { text, hasPriorAction: true });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.requests[0]).toEqual({
        kind: 'window_volume',
        window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' },
      });
    }
  });

  it('clarifies when a short metric follow-up has no prior analysis', () => {
    for (const text of ['what about volume?', 'how about the range?', 'and volume?']) {
      const current: AnalysisRequest[] = [{ kind: 'window_volume', window: { kind: 'whole_session' } }];
      const result = resolveAnalysisInheritance(current, undefined, { text, hasPriorAction: true });
      expect(result.ok).toBe(false);
    }
  });

  it('allows whole_session for new non-contextual summaries', () => {
    const current: AnalysisRequest[] = [{ kind: 'window_summary', window: { kind: 'whole_session' } }];
    const result = resolveAnalysisInheritance(current, undefined, {
      text: 'How did AAPL do today?',
      hasPriorAction: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0]).toEqual({ kind: 'window_summary', window: { kind: 'whole_session' } });
  });

  it('keeps an explicitly requested whole_session even without prior analysis', () => {
    const current: AnalysisRequest[] = [{ kind: 'window_volume', window: { kind: 'whole_session' } }];
    const result = resolveAnalysisInheritance(current, undefined, {
      text: 'what about volume for the whole session?',
      hasPriorAction: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0]).toEqual({ kind: 'window_volume', window: { kind: 'whole_session' } });
  });

  it('normalizes a comparison and inherits the left side from the prior window', () => {
    const current: AnalysisRequest[] = [
      {
        kind: 'window_compare',
        left: { kind: 'last_hour' },
        right: { kind: 'last_hour' },
      },
    ];
    const result = resolveAnalysisInheritance(current, [firstHourVolume], {
      text: 'compare that with the last hour',
      hasPriorAction: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0]).toEqual({
      kind: 'window_compare',
      left: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' },
      right: { kind: 'time_range', fromTime: '15:00', toTime: '16:00' },
    });
  });

  it('inherits both sides from a prior comparison when only one side is given', () => {
    const base: AnalysisRequest[] = [
      {
        kind: 'window_compare',
        left: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' },
        right: { kind: 'time_range', fromTime: '15:00', toTime: '16:00' },
      },
    ];
    const current: AnalysisRequest[] = [
      {
        kind: 'window_compare',
        right: { kind: 'last_hour' },
      },
    ];
    const result = resolveAnalysisInheritance(current, base, {
      text: 'compare that with the last hour',
      hasPriorAction: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0]).toEqual({
      kind: 'window_compare',
      left: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' },
      right: { kind: 'time_range', fromTime: '15:00', toTime: '16:00' },
    });
  });

  it('rejects an unknown window alias in a comparison side', () => {
    const current: AnalysisRequest[] = [
      {
        kind: 'window_compare',
        left: { kind: 'lunch_break' },
        right: { kind: 'last_hour' },
      },
    ];
    const result = resolveAnalysisInheritance(current, [firstHourVolume], {
      text: 'compare that with the last hour',
      hasPriorAction: true,
    });
    // normalizeAnalysisWindow leaves unknown kinds intact; strict validation will reject them.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compare = result.requests[0] as Extract<AnalysisRequest, { kind: 'window_compare' }>;
    expect(compare.left).toEqual({ kind: 'lunch_break' });
    expect(compare.right).toEqual({ kind: 'time_range', fromTime: '15:00', toTime: '16:00' });
  });

  it('preserves an explicit fromTime/toTime over any alias', () => {
    const current: AnalysisRequest[] = [
      {
        kind: 'window_compare',
        left: { kind: 'last_hour', fromTime: '10:00', toTime: '11:00' },
        right: { kind: 'first_hour', fromTime: '14:00', toTime: '15:00' },
      },
    ];
    const result = resolveAnalysisInheritance(current, [lastHour], {
      text: 'compare the 10 to 11 window with the 2 to 3 window',
      hasPriorAction: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0]).toEqual({
      kind: 'window_compare',
      left: { kind: 'time_range', fromTime: '10:00', toTime: '11:00' },
      right: { kind: 'time_range', fromTime: '14:00', toTime: '15:00' },
    });
  });

  it('repeats the same analysis on a new symbol while keeping inherited windows', () => {
    const base: AnalysisRequest[] = [
      {
        kind: 'window_compare',
        left: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' },
        right: { kind: 'time_range', fromTime: '15:00', toTime: '16:00' },
      },
    ];
    const current: AnalysisRequest[] = [
      {
        kind: 'window_compare',
      },
    ];
    const result = resolveAnalysisInheritance(current, base, {
      text: 'do that analysis on NVDA',
      hasPriorAction: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0]).toEqual({
      kind: 'window_compare',
      left: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' },
      right: { kind: 'time_range', fromTime: '15:00', toTime: '16:00' },
    });
  });
});
