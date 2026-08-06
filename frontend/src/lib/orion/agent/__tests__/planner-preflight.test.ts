import { describe, it, expect } from 'vitest';
import { extractTimeAttempts, parseChartCommand } from '../../planner';

const AVAILABLE = ['AAPL', 'MSFT', 'NVDA'];

describe('planner preflight issues', () => {
  it('rejects colon times with invalid minutes', () => {
    const cmd = parseChartCommand('What happened at 11:70?', AVAILABLE);
    expect(cmd.issues).toBeDefined();
    expect(cmd.issues?.[0].kind).toBe('invalid_time');
    expect(cmd.issues?.[0].raw).toBe('11:70');
  });

  it('rejects 24-hour times with an out-of-range hour', () => {
    const cmd = parseChartCommand('Jump to 25:00.', AVAILABLE);
    expect(cmd.issues?.[0].kind).toBe('invalid_time');
  });

  it('rejects spoken hour + invalid minute like "eleven seventy"', () => {
    const cmd = parseChartCommand('Describe the candle at eleven seventy', AVAILABLE);
    expect(cmd.issues?.[0].kind).toBe('invalid_time');
    expect(cmd.issues?.[0].raw).toMatch(/eleven seventy/i);
  });

  it('records "eleven seventy" as an invalid minute attempt', () => {
    const attempts = extractTimeAttempts('eleven seventy');
    const bad = attempts.find((a) => a.error);
    expect(bad).toBeDefined();
    expect(bad?.error).toBe('invalid_minute');
  });

  it('does not flag valid spoken times', () => {
    const cmd = parseChartCommand('Describe the candle at eleven thirty', AVAILABLE);
    expect(cmd.issues).toBeUndefined();
    expect(cmd.endTime).toEqual({ hour: 11, minute: 30 });
  });

  it('rejects an unknown explicit symbol after "for"', () => {
    const cmd = parseChartCommand('What is the candle for UNKNOWN?', AVAILABLE);
    expect(cmd.issues?.[0].kind).toBe('unknown_symbol');
    expect(cmd.issues?.[0].raw).toBe('UNKNOWN');
  });

  it('rejects a ticker-like unknown symbol after "switch to"', () => {
    const cmd = parseChartCommand('Switch to ZZZZ.', AVAILABLE);
    expect(cmd.issues?.[0].kind).toBe('unknown_symbol');
    expect(cmd.issues?.[0].raw).toBe('ZZZZ');
  });

  it('rejects an unresolvable company name after "switch to"', () => {
    const cmd = parseChartCommand('Switch to Zorblatt.', AVAILABLE);
    expect(cmd.issues?.[0].kind).toBe('unknown_symbol');
  });

  it('rejects a weak-cue unresolved symbol ("on Mars")', () => {
    const cmd = parseChartCommand('Do that again on Mars.', AVAILABLE);
    expect(cmd.issues?.[0].kind).toBe('unknown_symbol');
    expect(cmd.issues?.[0].raw).toBe('Mars');
  });

  it('does not flag common analysis words after "for"', () => {
    const cmd = parseChartCommand('What is the volume for the first hour?', AVAILABLE);
    expect(cmd.issues).toBeUndefined();
  });

  it('does not flag days of the week after "on"', () => {
    const cmd = parseChartCommand('Do that again on Monday.', AVAILABLE);
    expect(cmd.issues).toBeUndefined();
  });

  it('resolves an available symbol after "for"', () => {
    const cmd = parseChartCommand('What is the candle for AAPL?', AVAILABLE);
    expect(cmd.issues).toBeUndefined();
    expect(cmd.symbol).toBe('AAPL');
  });

  it('resolves an alias after "switch to"', () => {
    const cmd = parseChartCommand('Switch to Apple.', AVAILABLE);
    expect(cmd.issues).toBeUndefined();
    expect(cmd.symbol).toBe('AAPL');
  });

  it('reports an unavailable alias for a known company not in session', () => {
    const cmd = parseChartCommand('Switch to Adobe.', AVAILABLE);
    expect(cmd.issues?.[0].kind).toBe('unavailable_symbol');
  });

  it('rejects "show me QQQQ" as an unknown symbol', () => {
    const cmd = parseChartCommand('show me QQQQ', AVAILABLE);
    expect(cmd.issues).toBeDefined();
    expect(cmd.issues?.[0].kind).toBe('unknown_symbol');
    expect(cmd.issues?.[0].raw).toBe('QQQQ');
  });

  it('rejects "go to QQQQ" as an unknown symbol', () => {
    const cmd = parseChartCommand('go to QQQQ', AVAILABLE);
    expect(cmd.issues).toBeDefined();
    expect(cmd.issues?.[0].kind).toBe('unknown_symbol');
    expect(cmd.issues?.[0].raw).toBe('QQQQ');
  });

  it('does not flag "Go back to the candle we were discussing" as a symbol issue', () => {
    const cmd = parseChartCommand('Go back to the candle we were discussing.', AVAILABLE);
    expect(cmd.issues).toBeUndefined();
  });
});
