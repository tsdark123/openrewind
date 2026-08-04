import { describe, it, expect } from 'vitest';
import { getRequestedDimensions, textRequestsAnalysis, textRequestsCandleShape, textRequestsCandleQuery, textRequestsWindowAnalysis } from '../dimensions';
import { parseChartCommand } from '../../planner';

const tickers = ['AAPL', 'MSFT', 'NVDA'];
const aliases: Record<string, string> = {};
const baseDate = '2026-07-10';

function dims(text: string) {
  const cmd = parseChartCommand(text, tickers, aliases, baseDate);
  return getRequestedDimensions(text, cmd, baseDate);
}

describe('lexical analysis request detection', () => {
  const positive = [
    { text: 'how much did price move', expects: 'analysisRequest' },
    { text: 'what was the volume this morning', expects: 'analysisRequest' },
    { text: 'volum this mornig', expects: 'analysisRequest' },
    { text: 'volune', expects: 'analysisRequest' },
    { text: 'rang first hour', expects: 'analysisRequest' },
    { text: 'chagne from open', expects: 'analysisRequest' },
    { text: 'mornning volume', expects: 'analysisRequest' },
    { text: 'mornning range', expects: 'analysisRequest' },
    { text: 'what kind of candle am i on', expects: 'analysisRequest' },
    { text: 'candle anatomy at 11:30', expects: 'analysisRequest' },
  ];

  for (const { text, expects } of positive) {
    it(`detects "${text}" as an analysis request`, () => {
      const result = dims(text);
      expect(result.has(expects as any)).toBe(true);
    });
  }

  const negative = [
    'do it',
    'move the replay earlier',
    'set me up on AAPL',
    'go back 5 minutes',
    'play the chart',
    'orange volume',
    'candid range',
    'boring change',
    'elephant move',
    'hello world',
  ];

  for (const text of negative) {
    it(`does not treat "${text}" as an analysis request`, () => {
      const result = dims(text);
      expect(result.has('analysisRequest')).toBe(false);
    });
  }
});

describe('typo-tolerant concept matching', () => {
  it('routes volume, volum and volune consistently', () => {
    for (const text of ['volume this morning', 'volum this morning', 'volune this morning']) {
      expect(textRequestsAnalysis(text)).toBe(true);
    }
  });

  it('routes morning, mornig and mornning consistently', () => {
    for (const text of ['morning volume', 'mornig volume', 'mornning volume']) {
      expect(textRequestsAnalysis(text)).toBe(true);
    }
  });

  it('routes range and rang consistently', () => {
    for (const text of ['range first hour', 'rang first hour']) {
      expect(textRequestsAnalysis(text)).toBe(true);
    }
  });

  it('routes change and chagne consistently', () => {
    for (const text of ['change first hour', 'chagne first hour']) {
      expect(textRequestsAnalysis(text)).toBe(true);
    }
  });
});

describe('candle-shape versus candle-query routing', () => {
  it('treats "what candle am I on" as a candle query, not an analysis request', () => {
    const text = 'what candle am i on';
    expect(textRequestsCandleShape(text)).toBe(false);
    expect(textRequestsCandleQuery(text)).toBe(true);
    expect(dims(text).has('candleQuery')).toBe(true);
    expect(dims(text).has('analysisRequest')).toBe(false);
  });

  it('treats "what kind of candle am I on" as candle-shape analysis', () => {
    const text = 'what kind of candle am i on';
    expect(textRequestsCandleShape(text)).toBe(true);
    expect(textRequestsCandleQuery(text)).toBe(false);
    expect(dims(text).has('analysisRequest')).toBe(true);
  });

  it('treats "tell me the candle anatomy at 11:30" as candle-shape analysis', () => {
    const text = 'tell me the candle anatomy at 11:30';
    expect(textRequestsCandleShape(text)).toBe(true);
    expect(textRequestsCandleQuery(text)).toBe(false);
  });

  it('treats "what was the price at 11:30" as a candle query', () => {
    const text = 'what was the price at 11:30';
    expect(textRequestsCandleShape(text)).toBe(false);
    expect(textRequestsCandleQuery(text)).toBe(true);
    expect(dims(text).has('candleQuery')).toBe(true);
  });

  it('does not produce both candleQuery and analysisRequest for the same request', () => {
    const texts = [
      'what kind of candle am i on',
      'what candle am i on',
      'what was the price at 11:30',
      'candle anatomy at 11:30',
      'what was the price range in the first hour',
      'give me candle shape and the first hour range',
    ];
    for (const text of texts) {
      const result = dims(text);
      const hasAnalysis = result.has('analysisRequest');
      const hasQuery = result.has('candleQuery');
      expect(hasAnalysis && hasQuery, `both flags set for "${text}"`).toBe(false);
    }
  });
});
