import { describe, it, expect } from 'vitest';
import { extractTimes, parseChartCommand } from '../../planner';

const format = (t: { hour: number; minute: number }) =>
  `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;

describe('extractTimes colloquial parsing', () => {
  it('parses dotted a.m. and p.m. with colon time', () => {
    expect(extractTimes('Park the replay at 2:45 p.m.').map(format)).toEqual(['14:45']);
    expect(extractTimes('Park the replay at 2:45 p.m').map(format)).toEqual(['14:45']);
  });

  it('parses quarter-to with p.m.', () => {
    expect(extractTimes('quarter to three p.m.').map(format)).toEqual(['14:45']);
  });

  it('parses quarter-to with "in the afternoon"', () => {
    expect(extractTimes('quarter to three in the afternoon').map(format)).toEqual(['14:45']);
  });

  it('parses quarter-past and half-past with default meridian', () => {
    expect(extractTimes('quarter past eleven').map(format)).toEqual(['11:15']);
    expect(extractTimes('half past nine').map(format)).toEqual(['09:30']);
    expect(extractTimes('quarter to three').map(format)).toEqual(['14:45']);
  });

  it('parses quarter-past with p.m.', () => {
    expect(extractTimes('quarter past three p.m.').map(format)).toEqual(['15:15']);
  });

  it('parses half-past with p.m.', () => {
    expect(extractTimes('half past three p.m.').map(format)).toEqual(['15:30']);
  });

  it('parses noon and midnight', () => {
    expect(extractTimes('noon').map(format)).toEqual(['12:00']);
    expect(extractTimes('midnight').map(format)).toEqual(['00:00']);
    expect(extractTimes('quarter to noon').map(format)).toEqual(['11:45']);
    expect(extractTimes('quarter to midnight').map(format)).toEqual(['23:45']);
  });

  it('rejects invalid 24-hour times', () => {
    expect(extractTimes('Jump to 25:00.')).toEqual([]);
    expect(extractTimes('Jump to 24:30.')).toEqual([]);
    expect(extractTimes('Jump to 13:75.')).toEqual([]);
  });

  it('keeps bare 24-hour and am/pm independent', () => {
    expect(extractTimes('at 10:20').map(format)).toEqual(['10:20']);
    expect(extractTimes('at 10:20am').map(format)).toEqual(['10:20']);
    expect(extractTimes('at 10:20pm').map(format)).toEqual(['22:20']);
  });

  it('parses spelled-out hours with meridian or time-of-day phrase', () => {
    expect(extractTimes('seek to three p.m.').map(format)).toEqual(['15:00']);
    expect(extractTimes('seek to one in the morning').map(format)).toEqual(['01:00']);
    expect(extractTimes('seek to two in the afternoon').map(format)).toEqual(['14:00']);
  });

  it('does not double-extract the hour word inside a colloquial phrase', () => {
    expect(extractTimes('quarter past three p.m.').map(format)).toEqual(['15:15']);
    expect(extractTimes('half past three p.m.').map(format)).toEqual(['15:30']);
    expect(extractTimes('quarter to three p.m.').map(format)).toEqual(['14:45']);
    expect(extractTimes('quarter to three in the afternoon').map(format)).toEqual(['14:45']);
  });
});

describe('parseChartCommand colloquial compound commands', () => {
  const tickers = ['AAPL', 'MSFT', 'NVDA'];

  it('parses prompt #5: switch + date + timeframe + quarter-to p.m.', () => {
    const cmd = parseChartCommand(
      'Switch to AAPL, go back two sessions, set 15m and seek to quarter to three p.m.',
      tickers,
      undefined,
      '2026-07-10'
    );
    expect(cmd.intent).toBe('switch');
    expect(cmd.symbol).toBe('AAPL');
    expect(cmd.timeframe).toBe(15);
    expect(cmd.endTime).toEqual({ hour: 14, minute: 45 });
  });

  it('parses prompt #11: switch + date + timeframe + quarter-to in the afternoon', () => {
    const cmd = parseChartCommand(
      'Switch to MSFT, jump back one session, set 15m and tell me what candle we are on at quarter to three in the afternoon.',
      tickers,
      undefined,
      '2026-07-10'
    );
    expect(cmd.intent).toBe('switch');
    expect(cmd.symbol).toBe('MSFT');
    expect(cmd.timeframe).toBe(15);
    expect(cmd.endTime).toEqual({ hour: 14, minute: 45 });
  });

  it('parses prompt #21: invalid time produces no endTime', () => {
    const cmd = parseChartCommand('Jump to 25:00.', tickers);
    expect(cmd.intent).toBe('seek');
    expect(cmd.endTime).toBeUndefined();
  });
});
