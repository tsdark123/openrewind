import { describe, it, expect } from 'vitest';
import { parseChartCommand } from '../../planner';

/**
 * Regression tests for the shared alias table. The deterministic planner must
 * continue to resolve the same names it did before the alias consolidation, and
 * must now also resolve the agent-layer names (Adobe, Eli Lilly) via the
 * canonical `SYMBOL_ALIASES` map.
 */

describe('planner alias integration', () => {
  const TICKERS = ['AAPL', 'NVDA', 'ADBE', 'MSFT', 'GOOGL', 'META', 'AMZN', 'HD', 'LLY'];

  it('resolves "Apple" to AAPL', () => {
    const cmd = parseChartCommand('switch to Apple', TICKERS);
    expect(cmd.symbol).toBe('AAPL');
  });

  it('resolves "Nvidia" to NVDA', () => {
    const cmd = parseChartCommand('switch to Nvidia', TICKERS);
    expect(cmd.symbol).toBe('NVDA');
  });

  it('resolves "Adobe" to ADBE', () => {
    const cmd = parseChartCommand('switch to Adobe stock', TICKERS);
    expect(cmd.symbol).toBe('ADBE');
  });

  it('resolves multi-word "Eli Lilly" to LLY', () => {
    const cmd = parseChartCommand('switch to Eli Lilly', TICKERS);
    expect(cmd.symbol).toBe('LLY');
  });

  it('preserves original planner aliases (Netflix -> NFLX)', () => {
    const cmd = parseChartCommand('switch to Netflix', ['NFLX', 'AAPL']);
    expect(cmd.symbol).toBe('NFLX');
  });

  it('leaves unknown company names unresolved', () => {
    const cmd = parseChartCommand('switch to Zorblatt', TICKERS);
    expect(cmd.symbol).toBeUndefined();
  });

  it('still accepts raw uppercase tickers', () => {
    const cmd = parseChartCommand('switch to NVDA', TICKERS);
    expect(cmd.symbol).toBe('NVDA');
  });
});
