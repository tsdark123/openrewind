import { describe, it, expect } from 'vitest';
import { extractDateInput, parseChartCommand } from '../../planner';
import { getRequestedDimensions } from '../dimensions';

describe('extractDateInput for relative trading-session phrases', () => {
  it('parses "go back two sessions"', () => {
    const d = extractDateInput('Switch to AAPL, go back two sessions, set 15m');
    expect(d).toEqual(expect.objectContaining({ kind: 'relative_trading', count: 2, direction: 'backward' }));
  });

  it('parses "go back two trading sessions"', () => {
    const d = extractDateInput('Switch to AAPL, go back two trading sessions, set 15m');
    expect(d).toEqual(expect.objectContaining({ kind: 'relative_trading', count: 2, direction: 'backward' }));
  });

  it('parses "one session before"', () => {
    const d = extractDateInput('Switch to AAPL, one session before');
    expect(d).toEqual(expect.objectContaining({ kind: 'relative_trading', count: 1, direction: 'backward' }));
  });

  it('parses "two sessions ago"', () => {
    const d = extractDateInput('Switch to AAPL, two sessions ago');
    expect(d).toEqual(expect.objectContaining({ kind: 'relative_trading', count: 2, direction: 'backward' }));
  });

  it('parses "prior trading session"', () => {
    const d = extractDateInput('Switch to AAPL, prior trading session');
    expect(d).toEqual(expect.objectContaining({ kind: 'relative_trading', count: 1, direction: 'backward' }));
  });

  it('parses "next trading session" as forward', () => {
    const d = extractDateInput('Switch to AAPL, next trading session');
    expect(d).toEqual(expect.objectContaining({ kind: 'relative_trading', count: 1, direction: 'forward' }));
  });
});

describe('parseChartCommand keeps reordered compound clauses', () => {
  const tickers = ['AAPL', 'MSFT', 'NVDA'];

  it('compound switch with go back + timeframe + time', () => {
    const cmd = parseChartCommand(
      'Switch to AAPL, go back two sessions, set 15m and seek to quarter to three p.m.',
      tickers,
      undefined,
      '2026-07-10'
    );
    expect(cmd.intent).toBe('switch');
    expect(cmd.symbol).toBe('AAPL');
    expect(cmd.dateInput).toEqual(expect.objectContaining({ kind: 'relative_trading', count: 2, direction: 'backward' }));
    expect(cmd.timeframe).toBe(15);
    expect(cmd.endTime).toEqual({ hour: 14, minute: 45 });
  });
});

describe('getRequestedDimensions preserves symbol, relative date, timeframe and absolute time', () => {
  const tickers = ['AAPL', 'MSFT', 'NVDA'];

  it('request all four dimensions in reordered compound clause', () => {
    const cmd = parseChartCommand(
      'Switch to AAPL, go back two trading sessions, set 15m and seek to quarter to three p.m.',
      tickers,
      undefined,
      '2026-07-10'
    );
    const dims = getRequestedDimensions(
      'Switch to AAPL, go back two trading sessions, set 15m and seek to quarter to three p.m.',
      cmd,
      '2026-07-10'
    );
    expect(dims.has('symbol')).toBe(true);
    expect(dims.has('date')).toBe(true);
    expect(dims.has('timeframe')).toBe(true);
    expect(dims.has('absoluteTime')).toBe(true);
  });
});
