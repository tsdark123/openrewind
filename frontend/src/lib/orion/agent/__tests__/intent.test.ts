import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateSemanticIntent,
  extractSemanticIntent,
  buildIntentExtractionPrompt,
  preValidateSanitize,
  type SemanticIntent,
} from '../intent';

vi.mock('../../client', () => ({
  orionChat: vi.fn(),
  ORION_AGENT_MODEL: 'llama3.2:latest',
}));

import { orionChat } from '../../client';

const mockedOrionChat = vi.mocked(orionChat);

beforeEach(() => {
  mockedOrionChat.mockReset();
});

function isChartAction(intent: SemanticIntent): intent is Extract<SemanticIntent, { kind: 'chart_action' }> {
  return intent.kind === 'chart_action';
}

function isClarificationOrUnsupported(intent: SemanticIntent): intent is Extract<SemanticIntent, { kind: 'clarification' | 'unsupported' }> {
  return intent.kind === 'clarification' || intent.kind === 'unsupported';
}

describe('SemanticIntent validation', () => {
  it('accepts a valid Case-A style chart_action intent', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      symbol: 'NVDA',
      date: { kind: 'relative_trading', count: 1, direction: 'backward' },
      timeframeMinutes: 15,
      seekTime: '11:15',
      finalQuery: 'current_candle',
    });
    expect(r.ok).toBe(true);
    if (r.ok && isChartAction(r.intent)) {
      expect(r.intent.symbol).toBe('NVDA');
      expect(r.intent.date).toEqual({ kind: 'relative_trading', count: 1, direction: 'backward' });
      expect(r.intent.timeframeMinutes).toBe(15);
      expect(r.intent.seekTime).toBe('11:15');
      expect(r.intent.finalQuery).toBe('current_candle');
    }
  });

  it('rejects unknown top-level fields', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      symbol: 'AAPL',
      extraField: true,
    } as Record<string, unknown>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown field/);
  });

  it('rejects unknown fields inside date', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      date: { kind: 'absolute', value: '2026-07-31', extra: 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown field/);
  });

  it('rejects malformed time', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      seekTime: '25:00',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid HH:MM/);
  });

  it('rejects invalid absolute date', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      date: { kind: 'absolute', value: '2026-13-01' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid YYYY-MM-DD/);
  });

  it('rejects relative_trading with a value', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      date: { kind: 'relative_trading', value: '2026-07-31', count: 1, direction: 'backward' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must not include a value/);
  });

  it('converts candle_at_time without queryTime into current_candle', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      finalQuery: 'candle_at_time',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.intent.kind === 'chart_action') {
      expect(r.intent.finalQuery).toBe('current_candle');
      expect(r.intent.queryTime).toBeUndefined();
    }
  });

  it('converts candle_at_time with a non-clock queryTime into current_candle', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      finalQuery: 'candle_at_time',
      queryTime: 'the bar I land on',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.intent.kind === 'chart_action') {
      expect(r.intent.finalQuery).toBe('current_candle');
      expect(r.intent.queryTime).toBeUndefined();
    }
  });

  it('rejects previousSymbol combined with symbol', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      symbol: 'AAPL',
      previousSymbol: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/previousSymbol cannot be combined with symbol/);
  });

  it('rejects seekTime and relativeSeekMinutes together', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      seekTime: '11:15',
      relativeSeekMinutes: -30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mutually exclusive/);
  });

  it('rejects a chart_action with no actionable fields', () => {
    const r = validateSemanticIntent({ kind: 'chart_action' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one actionable field/);
  });

  it('rejects injection patterns in symbol', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      symbol: 'javascript:alert(1)',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/forbidden pattern/);
  });

  it('rejects today placeholder in strings', () => {
    const r = validateSemanticIntent({
      kind: 'chart_action',
      symbol: 'AAPL',
      seekTime: '<today>',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid HH:MM/);
  });

  it('accepts clarification and unsupported forms', () => {
    const c = validateSemanticIntent({ kind: 'clarification', message: 'Which symbol?' });
    expect(c.ok).toBe(true);
    if (c.ok && isClarificationOrUnsupported(c.intent)) {
      expect(c.intent.kind).toBe('clarification');
      expect(c.intent.message).toBe('Which symbol?');
    }
    const u = validateSemanticIntent({ kind: 'unsupported', message: 'No VWAP.' });
    expect(u.ok).toBe(true);
    if (u.ok && isClarificationOrUnsupported(u.intent)) {
      expect(u.intent.kind).toBe('unsupported');
      expect(u.intent.message).toBe('No VWAP.');
    }
  });

  it('rejects clarification with empty message', () => {
    const r = validateSemanticIntent({ kind: 'clarification', message: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-empty message/);
  });

  it('prompt contains the compact chart_action kind and rules', () => {
    const prompt = buildIntentExtractionPrompt();
    expect(prompt).toContain('Do not write prose');
    expect(prompt).toContain('"const":"chart_action"');
  });
});

describe('extractSemanticIntent', () => {
  it('builds the prompt and passes format/options to orionChat', async () => {
    mockedOrionChat.mockResolvedValueOnce({
      content: JSON.stringify({
        kind: 'chart_action',
        symbol: 'NVDA',
        date: { kind: 'relative_trading', count: 1, direction: 'backward' },
        timeframeMinutes: 15,
        seekTime: '11:15',
        finalQuery: 'current_candle',
      }),
      toolCalls: [],
      raw: {},
    });
    const r = await extractSemanticIntent('set me up on Nvidia prior session 15m 11:15 candle', {
      requestContext: {
        dimensions: ['symbol', 'date', 'timeframe', 'absoluteTime', 'candleQuery'],
        missing: [],
      },
    });
    expect(mockedOrionChat).toHaveBeenCalledTimes(1);
    const call = mockedOrionChat.mock.calls[0][0];
    expect(call.format).toBe('json');
    expect(call.options).toEqual({ temperature: 0, seed: 42, num_predict: 160 });
    const system = call.messages.find((m: { role: string; content: string }) => m.role === 'system')?.content ?? '';
    expect(system).toContain('"const":"chart_action"');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.symbol).toBe('NVDA');
      expect(r.intent.date).toEqual({ kind: 'relative_trading', count: 1, direction: 'backward' });
      expect(r.intent.timeframeMinutes).toBe(15);
    }
  });

  it('repairs once on invalid JSON and succeeds', async () => {
    mockedOrionChat
      .mockResolvedValueOnce({ content: 'not json', toolCalls: [], raw: {} })
      .mockResolvedValueOnce({
        content: JSON.stringify({ kind: 'chart_action', symbol: 'AAPL', finalQuery: 'current_candle' }),
        toolCalls: [],
        raw: {},
      });
    const r = await extractSemanticIntent('what is the current candle for AAPL', {
      requestContext: {
        dimensions: ['symbol', 'candleQuery'],
        missing: [],
      },
    });
    expect(mockedOrionChat).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
  });

  it('repairs once on invalid field and then fails', async () => {
    mockedOrionChat.mockResolvedValue({
      content: JSON.stringify({ kind: 'chart_action', symbol: 'AAPL', seekTime: '25:00' }),
      toolCalls: [],
      raw: {},
    });
    const r = await extractSemanticIntent('AAPL at 25:00', {
      requestContext: {
        dimensions: ['symbol', 'absoluteTime'],
        missing: [],
      },
    });
    expect(mockedOrionChat).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('invalid');
  });

  it('returns clarification for clarification intent', async () => {
    mockedOrionChat.mockResolvedValue({
      content: JSON.stringify({ kind: 'clarification', message: 'Which time?' }),
      toolCalls: [],
      raw: {},
    });
    const r = await extractSemanticIntent('Move it over there.');
    expect(mockedOrionChat).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('clarification');
  });

  it('returns unsupported for unsupported intent', async () => {
    mockedOrionChat.mockResolvedValue({
      content: JSON.stringify({ kind: 'unsupported', message: 'No VWAP available.' }),
      toolCalls: [],
      raw: {},
    });
    const r = await extractSemanticIntent('Add VWAP and backtest.');
    expect(mockedOrionChat).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('unsupported');
  });
});

describe('buildIntentExtractionPrompt adaptive prompt', () => {
  it('an analysis-only prompt omits playback/seek/symbol schema sections', () => {
    const prompt = buildIntentExtractionPrompt({
      text: 'what kind of candle am I on',
      requestContext: {
        dimensions: ['analysisRequest'],
        missing: ['analysisRequest'],
      },
    });
    expect(prompt).toContain('"analysisRequests"');
    expect(prompt).not.toContain('"playback"');
    expect(prompt).not.toContain('"seekTime"');
    expect(prompt).not.toContain('"symbol"');
  });

  it('an analysis prompt includes the analysisRequests section', () => {
    const prompt = buildIntentExtractionPrompt({
      text: 'what was the range in the first hour',
      requestContext: {
        dimensions: ['analysisRequest'],
        missing: ['analysisRequest'],
      },
    });
    expect(prompt).toContain('"analysisRequests"');
    expect(prompt).toContain('window_ohlc');
    expect(prompt).toContain('candle_shape');
  });

  it('an ambiguous/no-context prompt receives the full compact fallback', () => {
    const fallback = buildIntentExtractionPrompt();
    expect(fallback).toContain('"playback"');
    expect(fallback).toContain('"seekTime"');
    expect(fallback).toContain('"symbol"');
    expect(fallback).toContain('"analysisRequests"');
    expect(fallback).toContain('"const":"chart_action"');
  });

  it('a context follow-up includes contextReference', () => {
    const prompt = buildIntentExtractionPrompt({
      text: 'do that again',
      requestContext: {
        dimensions: [],
        missing: ['contextReference'],
      },
    });
    expect(prompt).toContain('"contextReference"');
  });

  it('a candle-only prompt is significantly smaller than the full fallback', () => {
    const fallback = buildIntentExtractionPrompt();
    const candle = buildIntentExtractionPrompt({
      text: 'what kind of candle am I on',
      requestContext: {
        dimensions: ['analysisRequest'],
        missing: ['analysisRequest'],
      },
    });
    expect(candle.length).toBeLessThan(fallback.length / 2);
  });
});

describe('preValidateSanitize nested window_compare normalization', () => {
  it('normalizes both left and right sides before validation', () => {
    const raw: Record<string, unknown> = {
      kind: 'chart_action',
      analysisRequests: [
        { kind: 'window_compare', left: { kind: 'first_hour' }, right: { kind: 'last_hour' } },
      ],
    };
    preValidateSanitize(raw, 'compare the first hour with the last hour');
    const requests = raw.analysisRequests as Record<string, unknown>[];
    expect(requests[0].left).toEqual({ kind: 'time_range', fromTime: '09:30', toTime: '10:30' });
    expect(requests[0].right).toEqual({ kind: 'time_range', fromTime: '15:00', toTime: '16:00' });
  });

  it('preserves explicit fromTime/toTime over named aliases on both sides', () => {
    const raw: Record<string, unknown> = {
      kind: 'chart_action',
      analysisRequests: [
        {
          kind: 'window_compare',
          left: { kind: 'first_hour', fromTime: '10:00', toTime: '10:30' },
          right: { kind: 'last_hour', fromTime: '14:30', toTime: '15:30' },
        },
      ],
    };
    preValidateSanitize(raw, 'compare 10:00-10:30 with 14:30-15:30');
    const requests = raw.analysisRequests as Record<string, unknown>[];
    expect(requests[0].left).toEqual({ kind: 'time_range', fromTime: '10:00', toTime: '10:30' });
    expect(requests[0].right).toEqual({ kind: 'time_range', fromTime: '14:30', toTime: '15:30' });
  });

  it('leaves unknown comparison-side kinds intact for strict validation to reject', () => {
    const raw: Record<string, unknown> = {
      kind: 'chart_action',
      analysisRequests: [{ kind: 'window_compare', left: { kind: 'lunch_break' }, right: { kind: 'last_hour' } }],
    };
    preValidateSanitize(raw, 'compare lunch break with the last hour');
    const requests = raw.analysisRequests as Record<string, unknown>[];
    expect(requests[0].left).toEqual({ kind: 'lunch_break' });
    expect(requests[0].right).toEqual({ kind: 'time_range', fromTime: '15:00', toTime: '16:00' });
  });
});
