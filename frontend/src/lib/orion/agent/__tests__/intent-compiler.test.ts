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

  it('compiles a date-only request using the active symbol', () => {
    const plan = compileChartActionIntent(
      {
        kind: 'chart_action',
        date: { kind: 'relative_trading', count: 1, direction: 'backward' },
      },
      { stateSymbol: 'AAPL', stateDate: '2026-07-31', stateTimeframe: 15 }
    );
    expect(plan.kind).toBe('mixed');
    expect(plan.steps.map((s) => s.capability)).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
    ]);
    expect(plan.steps[0].args.symbol).toBe('AAPL');
    expect(plan.steps[1].args.symbol).toBe('AAPL');
  });

  it('keeps an inherited timeframe across a session boundary only when chart state is needed', () => {
    // A cross-symbol analysis-only repeat does not need a redundant set_timeframe
    // when the value already matches the current state.
    const crossSymbol = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'AAPL',
        date: { kind: 'absolute', value: '2026-07-31' },
        timeframeMinutes: 15,
      },
      { stateSymbol: 'MSFT', stateDate: '2026-07-31', stateTimeframe: 15, availableTickers: ['AAPL'] }
    );
    expect(crossSymbol.steps.some((s) => s.capability === 'chart.set_timeframe')).toBe(false);

    // A cross-symbol repeat that reconstructs chart state (seek + candle query)
    // keeps the inherited timeframe so the target session is set up correctly.
    const crossSymbolNav = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'AAPL',
        date: { kind: 'absolute', value: '2026-07-31' },
        seekTime: '11:15',
        finalQuery: 'current_candle',
        timeframeMinutes: 15,
      },
      { stateSymbol: 'MSFT', stateDate: '2026-07-31', stateTimeframe: 15, availableTickers: ['AAPL'] }
    );
    expect(crossSymbolNav.steps.some((s) => s.capability === 'chart.set_timeframe')).toBe(true);

    // Changing date while carrying an inherited timeframe must also keep it.
    const dateOnly = compileChartActionIntent(
      {
        kind: 'chart_action',
        date: { kind: 'relative_trading', count: 1, direction: 'backward' },
        timeframeMinutes: 15,
      },
      { stateSymbol: 'AAPL', stateDate: '2026-07-31', stateTimeframe: 15, availableTickers: ['AAPL'] }
    );
    expect(dateOnly.steps.some((s) => s.capability === 'chart.set_timeframe')).toBe(true);
  });

  it('skips a redundant timeframe step when the session context is unchanged', () => {
    const replay = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'AAPL',
        date: { kind: 'absolute', value: '2026-07-31' },
        seekTime: '11:15',
        finalQuery: 'current_candle',
        timeframeMinutes: 15,
      },
      { stateSymbol: 'AAPL', stateDate: '2026-07-31', stateTimeframe: 15, availableTickers: ['AAPL'] }
    );
    expect(replay.steps.some((s) => s.capability === 'chart.set_timeframe')).toBe(false);
  });

  it('keeps a pure timeframe request even when the value matches the current state', () => {
    const pure = compileChartActionIntent(
      { kind: 'chart_action', timeframeMinutes: 15 },
      { stateSymbol: 'AAPL', stateDate: '2026-07-31', stateTimeframe: 15 }
    );
    expect(pure.steps.map((s) => s.capability)).toEqual(['chart.set_timeframe']);
  });

  it('throws for a date-only request with no active symbol', () => {
    expect(() =>
      compileChartActionIntent(
        { kind: 'chart_action', date: { kind: 'relative_trading', count: 1, direction: 'backward' } },
        { stateDate: '2026-07-31' }
      )
    ).toThrow('compileChartActionIntent: date requires a symbol.');
  });

  it('keeps resolve_trading_date and set_timeframe for a same-symbol date change with inherited timeframe', () => {
    const plan = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'NVDA',
        date: { kind: 'relative_trading', count: 1, direction: 'backward' },
        timeframeMinutes: 15,
      },
      { stateSymbol: 'NVDA', stateDate: '2026-07-31', stateTimeframe: 15, availableTickers: ['AAPL', 'MSFT', 'NVDA'] }
    );
    const caps = plan.steps.map((s) => s.capability);
    expect(caps).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
      'chart.set_timeframe',
    ]);
  });

  it('keeps resolve_trading_date, switch_symbol and set_timeframe for a cross-symbol context repeat', () => {
    const plan = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'AAPL',
        date: { kind: 'absolute', value: '2026-07-31' },
        seekTime: '11:15',
        finalQuery: 'current_candle',
        timeframeMinutes: 15,
      },
      { stateSymbol: 'NVDA', stateDate: '2026-07-31', stateTimeframe: 15, availableTickers: ['AAPL', 'MSFT', 'NVDA'] }
    );
    const caps = plan.steps.map((s) => s.capability);
    expect(caps).toEqual([
      'session.resolve_trading_date',
      'session.switch_symbol',
      'chart.set_timeframe',
      'playback.seek_to_time',
      'chart.get_current_candle',
    ]);
  });

  it('does not emit set_timeframe for a cross-symbol analysis-only transfer with the same timeframe', () => {
    const plan = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'NVDA',
        timeframeMinutes: 15,
        analysisRequests: [
          { kind: 'window_volume', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } },
        ],
      },
      { stateSymbol: 'AAPL', stateDate: '2026-07-31', stateTimeframe: 15, availableTickers: ['AAPL', 'NVDA'] }
    );
    const caps = plan.steps.map((s) => s.capability);
    expect(caps).toEqual([
      'session.switch_symbol',
      'analysis.window_volume',
    ]);
    expect(caps).not.toContain('chart.set_timeframe');
    expect(caps).not.toContain('playback.seek_to_time');
    expect(caps).not.toContain('chart.seek');
  });

  it('emits set_timeframe for a cross-symbol analysis-only transfer when the timeframe differs', () => {
    const plan = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'NVDA',
        timeframeMinutes: 5,
        analysisRequests: [
          { kind: 'window_volume', window: { kind: 'time_range', fromTime: '09:30', toTime: '10:30' } },
        ],
      },
      { stateSymbol: 'AAPL', stateDate: '2026-07-31', stateTimeframe: 15, availableTickers: ['AAPL', 'NVDA'] }
    );
    const caps = plan.steps.map((s) => s.capability);
    expect(caps).toEqual([
      'session.switch_symbol',
      'chart.set_timeframe',
      'analysis.window_volume',
    ]);
  });

  it('generalizes the analysis-only transfer behavior to any ticker and analysis request', () => {
    const plan = compileChartActionIntent(
      {
        kind: 'chart_action',
        symbol: 'MSFT',
        timeframeMinutes: 15,
        analysisRequests: [
          { kind: 'window_ohlc', window: { kind: 'whole_session' } },
        ],
      },
      { stateSymbol: 'AAPL', stateDate: '2026-07-31', stateTimeframe: 15, availableTickers: ['AAPL', 'MSFT', 'NVDA'] }
    );
    const caps = plan.steps.map((s) => s.capability);
    expect(caps).toEqual(['session.switch_symbol', 'analysis.window_ohlc']);
  });
});
