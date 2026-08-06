import { describe, it, expect } from 'vitest';
import { evaluateTurn, matchesGlob, matchesAnyGlob } from '../runner/oracles.ts';
import { loadScenario } from '../runner/scenario-validator.ts';
import { FixtureEngineAdapter } from '../runner/adapters/engine-adapter.ts';
import { computeCapability } from '../reference/calculator.ts';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('capability glob matching', () => {
  it('matches exact capabilities', () => {
    expect(matchesGlob('analysis.window_ohlc', 'analysis.window_ohlc')).toBe(true);
    expect(matchesGlob('analysis.window_change', 'analysis.window_ohlc')).toBe(false);
  });

  it('matches wildcard segments', () => {
    expect(matchesGlob('analysis.window_ohlc', 'analysis.*')).toBe(true);
    expect(matchesGlob('session.switch_symbol', 'session.*')).toBe(true);
    expect(matchesGlob('playback.seek_absolute', 'playback.*')).toBe(true);
    expect(matchesGlob('analysis.window_ohlc', 'session.*')).toBe(false);
  });

  it('matchesAnyGlob checks all globs', () => {
    expect(matchesAnyGlob('analysis.window_ohlc', ['session.*', 'analysis.*'])).toBe(true);
    expect(matchesAnyGlob('session.switch_symbol', ['analysis.*'])).toBe(false);
  });
});

describe('semantic oracle evaluation', () => {
  const engine = new FixtureEngineAdapter();

  it('passes a well-formed smoke summary turn', async () => {
    const scenario = loadScenario(path.resolve(__dirname, '..', 'scenarios', 'smoke', 'whole-session-summary.json'));
    const turn = scenario.turns[0];
    const candles = await engine.fetchCandles(scenario.dataSet);
    const summary = computeCapability(candles, {
      capability: 'analysis.window_summary',
      window: { kind: 'whole_session' },
    });

    const response = {
      ok: true,
      route: 'deterministic' as const,
      message: `SYNTH session summary: open ${(summary as any).open.toFixed(2)} close ${(summary as any).close.toFixed(2)}.`,
      capabilities: ['analysis.window_summary'],
      receipts: [
        {
          capability: 'analysis.window_summary',
          success: true,
          data: summary,
        },
      ],
      template: JSON.parse(JSON.stringify(turn.expectedContextAfter)),
      finalWorldState: { symbol: 'SYNTH', date: '2026-08-05', timeframe: 1 },
    };

    const result = evaluateTurn({
      scenario,
      turn,
      turnResult: response,
      previousResults: [],
      referenceCandles: candles,
    });

    expect(result.status).toBe('pass');
  });

  it('fails when a forbidden capability is used', async () => {
    const scenario = loadScenario(path.resolve(__dirname, '..', 'scenarios', 'smoke', 'whole-session-summary.json'));
    const turn = scenario.turns[0];
    const candles = await engine.fetchCandles(scenario.dataSet);

    const response = {
      ok: true,
      route: 'deterministic' as const,
      message: 'Session summary fixture.',
      capabilities: ['analysis.window_summary', 'session.switch_symbol'],
      receipts: [],
      template: JSON.parse(JSON.stringify(turn.expectedContextAfter)),
      finalWorldState: { symbol: 'SYNTH', date: '2026-08-05', timeframe: 1 },
    };

    const result = evaluateTurn({
      scenario,
      turn,
      turnResult: response,
      previousResults: [],
      referenceCandles: candles,
    });

    expect(result.status).toBe('fail');
    expect(result.violations.some((v) => v.stage === 'forbidden')).toBe(true);
  });

  it('fails when the numerical truth is wrong', async () => {
    const scenario = loadScenario(path.resolve(__dirname, '..', 'scenarios', 'smoke', 'whole-session-summary.json'));
    const turn = scenario.turns[0];
    const candles = await engine.fetchCandles(scenario.dataSet);

    const response = {
      ok: true,
      route: 'deterministic' as const,
      message: 'Session summary fixture.',
      capabilities: ['analysis.window_summary'],
      receipts: [
        {
          capability: 'analysis.window_summary',
          success: true,
          data: { open: 999.0, close: 999.0, totalVolume: 1 },
        },
      ],
      template: JSON.parse(JSON.stringify(turn.expectedContextAfter)),
      finalWorldState: { symbol: 'SYNTH', date: '2026-08-05', timeframe: 1 },
    };

    const result = evaluateTurn({
      scenario,
      turn,
      turnResult: response,
      previousResults: [],
      referenceCandles: candles,
    });

    expect(result.status).toBe('fail');
    expect(result.violations.some((v) => v.stage === 'numeric')).toBe(true);
  });
});
