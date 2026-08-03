import { describe, it, expect } from 'vitest';
import { compileChartActionIntent } from '../intentCompiler';

describe('compileChartActionIntent', () => {
  it('compiles Case A into the correct ordered plan', () => {
    const plan = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'NVDA',
        date: { kind: 'relative_trading', count: 1, direction: 'backward' },
        timeframeMinutes: 15,
        seekTime: '11:15',
        finalQuery: 'current_candle',
      },
      { anchorDate: '2026-08-03' }
    );
    expect(plan.kind).toBe('mixed');
    expect(plan.steps.map((s) => s.capability)).toEqual([
      'session.resolve_symbol',
      'session.resolve_trading_date',
      'session.switch_symbol',
      'chart.set_timeframe',
      'playback.seek_to_time',
      'chart.get_current_candle',
    ]);

    const resolveDate = plan.steps[1];
    expect(resolveDate.args.input).toEqual({
      kind: 'relative_trading',
      sessions: 1,
      direction: 'backward',
      from: '2026-08-03',
    });
    expect(resolveDate.dependsOn).toEqual(['step-resolve-symbol']);

    const switchStep = plan.steps[2];
    expect(switchStep.dependsOn).toEqual(['step-resolve-date']);
    expect(switchStep.args.symbol).toEqual({ $ref: 'step-resolve-symbol', path: 'symbol' });
    expect(switchStep.args.date).toEqual({ $ref: 'step-resolve-date', path: 'date' });

    expect(plan.steps[3].args).toEqual({ timeframe: 15 });
    expect(plan.steps[4].args).toEqual({ time: '11:15' });
    expect(plan.steps[5].capability).toBe('chart.get_current_candle');
  });

  it('compiles a previous-symbol request', () => {
    const plan = compileChartActionIntent({ kind: 'chart_action', previousSymbol: true });
    expect(plan.steps.map((s) => s.capability)).toEqual(['session.switch_to_previous_symbol']);
    expect(plan.steps[0].args).toEqual({});
  });

  it('compiles a playback.play_until with untilTime', () => {
    const plan = compileChartActionIntent(
      {
        kind: 'chart_action',
        playback: { action: 'play_until', speed: 2, untilTime: '12:00' },
      },
      { anchorDate: '2026-08-03' }
    );
    expect(plan.steps[0].capability).toBe('playback.play_until');
    expect(plan.steps[0].args).toEqual({ speed: 2, untilTime: '12:00' });
  });

  it('compiles a relative seek plus current candle query', () => {
    const plan = compileChartActionIntent({
      kind: 'chart_action',
      relativeSeekMinutes: -30,
      finalQuery: 'current_candle',
    });
    expect(plan.steps.map((s) => s.capability)).toEqual([
      'playback.seek_relative',
      'chart.get_current_candle',
    ]);
    expect(plan.steps[0].args).toEqual({ minutes: -30 });
  });

  it('compiles candle_at_time query', () => {
    const plan = compileChartActionIntent({
      kind: 'chart_action',
      finalQuery: 'candle_at_time',
      queryTime: '10:30',
    });
    expect(plan.steps[0].capability).toBe('chart.get_candle_at_time');
    expect(plan.steps[0].args).toEqual({ time: '10:30' });
  });

  it('throws for previousSymbol combined with date', () => {
    expect(() =>
      compileChartActionIntent({
        kind: 'chart_action',
        previousSymbol: true,
        date: { kind: 'absolute', value: '2026-07-31' },
      })
    ).toThrow();
  });
});
