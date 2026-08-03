import { describe, it, expect } from 'vitest';
import { resolveSymbol, getCombinedAliases } from '../resolveSymbol';

const TICKERS = ['AAPL', 'NVDA', 'ADBE', 'MSFT', 'GOOGL', 'META', 'AMZN', 'HD', 'LLY'];

describe('resolveSymbol', () => {
  it('resolves "Apple" to AAPL', () => {
    const r = resolveSymbol('Apple', { availableTickers: TICKERS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.symbol).toBe('AAPL');
      expect(r.matchKind).toBe('alias');
    }
  });

  it('resolves "apple stock" by stripping filler words', () => {
    const r = resolveSymbol('apple stock', { availableTickers: TICKERS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.symbol).toBe('AAPL');
      expect(r.matchKind).toBe('alias');
    }
  });

  it('resolves "Nvidia" to NVDA', () => {
    const r = resolveSymbol('Nvidia', { availableTickers: TICKERS });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.symbol).toBe('NVDA');
  });

  it('resolves "NVDA" as exact ticker with confidence 1', () => {
    const r = resolveSymbol('NVDA', { availableTickers: TICKERS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.symbol).toBe('NVDA');
      expect(r.matchKind).toBe('exact_ticker');
      expect(r.confidence).toBe(1);
    }
  });

  it('resolves "switch to Adobe stock" to ADBE', () => {
    const r = resolveSymbol('switch to Adobe stock', { availableTickers: TICKERS });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.symbol).toBe('ADBE');
  });

  it('returns none for an unknown company', () => {
    const r = resolveSymbol('go to Zorblatt', { availableTickers: TICKERS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.matchKind).toBe('none');
  });

  it('reports unavailable_alias for an alias whose ticker is unavailable', () => {
    const r = resolveSymbol('tesla', { availableTickers: ['AAPL', 'MSFT'] });
    expect(r.ok).toBe(false);
    if (!r.ok && r.matchKind === 'unavailable_alias') {
      expect(r.resolvedTicker).toBe('TSLA');
    } else {
      throw new Error(`expected unavailable_alias, got ${r.matchKind}`);
    }
  });

  it('requires clarification for an ambiguous prefix', () => {
    const r = resolveSymbol('mic', {
      availableTickers: ['MSFT', 'MU'],
      extraAliases: { microsoft: 'MSFT', micron: 'MU' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.matchKind === 'ambiguous') {
      expect(r.needsClarification).toBe(true);
      expect(r.candidates.length).toBeGreaterThanOrEqual(2);
    } else {
      throw new Error(`expected ambiguous, got ${r.matchKind}`);
    }
  });

  it('resolves multi-word "eli lilly" to LLY', () => {
    const r = resolveSymbol('go to eli lilly stock please', { availableTickers: TICKERS });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.symbol).toBe('LLY');
  });

  it('returns none for empty input', () => {
    const r = resolveSymbol('   ', { availableTickers: TICKERS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.matchKind).toBe('none');
  });
});

describe('getCombinedAliases', () => {
  it('includes planner aliases', () => {
    const aliases = getCombinedAliases();
    expect(aliases['apple']).toBe('AAPL');
    expect(aliases['nvidia']).toBe('NVDA');
  });

  it('includes agent extra aliases without overriding planner values', () => {
    const aliases = getCombinedAliases();
    expect(aliases['adobe']).toBe('ADBE');
    expect(aliases['eli']).toBe('LLY');
    // planner's NFLX must remain.
    expect(aliases['netflix']).toBe('NFLX');
  });
});
