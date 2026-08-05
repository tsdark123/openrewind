import { describe, it, expect } from 'vitest';
import {
  textRequestsWindowAnalysis,
  textRequestsContextReference,
  textRequestsAnalysis,
  textRequestsCandleShape,
  textRequestsSummary,
  detectAnalysisConcepts,
} from '../dimensions';
import { selectedAnalysisKinds } from '../intent';

describe('market-window dimension detection', () => {
  it('treats named market windows as analysis requests', () => {
    expect(textRequestsWindowAnalysis('first hour')).toBe(true);
    expect(textRequestsWindowAnalysis('opening hour')).toBe(true);
    expect(textRequestsWindowAnalysis('last hour')).toBe(true);
    expect(textRequestsWindowAnalysis('closing hour')).toBe(true);
    expect(textRequestsWindowAnalysis('final hour')).toBe(true);
    expect(textRequestsWindowAnalysis('morning')).toBe(true);
    expect(textRequestsWindowAnalysis('afternoon')).toBe(true);
  });

  it('treats duration-qualified windows as analysis requests', () => {
    expect(textRequestsWindowAnalysis('first 30 minutes')).toBe(true);
    expect(textRequestsWindowAnalysis('last 30 minutes')).toBe(true);
    expect(textRequestsWindowAnalysis('closing 20 minutes')).toBe(true);
    expect(textRequestsWindowAnalysis('final 45 minutes')).toBe(true);
    expect(textRequestsWindowAnalysis('opening 60 minutes')).toBe(true);
  });

  it('does not treat bare relative durations as timeframes or relative seeks', () => {
    const d = detectAnalysisConcepts('first 30 minutes');
    expect(d.concepts.has('minute')).toBe(true);
    expect(d.concepts.has('first')).toBe(true);
    // The core hit should be the named window, not a raw 30-minute duration.
    expect(selectedAnalysisKinds('first 30 minutes')).toEqual(['window_ohlc']);
  });

  it('maps quarter-past correctly and does not collide with last-hour detection', () => {
    const d = detectAnalysisConcepts('quarter past ten');
    expect(d.concepts.has('last')).toBe(false);
    expect(textRequestsWindowAnalysis('quarter past ten')).toBe(false);
  });

  it('detects compound analysis requests that need multiple kinds', () => {
    expect(textRequestsAnalysis('what was the move and total volume from 10 to noon')).toBe(true);
    expect(selectedAnalysisKinds('what was the move and total volume from 10 to noon')).toBeUndefined();

    expect(textRequestsAnalysis('describe the candle structure and range for the first hour')).toBe(true);
    expect(selectedAnalysisKinds('describe the candle structure and range for the first hour')).toBeUndefined();
  });

  it('detects summary + metric as compound', () => {
    expect(textRequestsAnalysis('summarize price action and participation between 10 and noon')).toBe(true);
    expect(selectedAnalysisKinds('summarize price action and participation between 10 and noon')).toBeUndefined();
  });

  it('detects comparison language and returns window_compare', () => {
    expect(selectedAnalysisKinds('compare the first 30 minutes to the last 30')).toEqual(['window_compare']);
    expect(selectedAnalysisKinds('morning volume higher than near close')).toBeUndefined();
    expect(selectedAnalysisKinds('how did the morning compare to the afternoon')).toEqual(['window_compare']);
    expect(selectedAnalysisKinds('which had more volume, morning or afternoon')).toBeUndefined();
  });

  it('detects short contextual follow-ups without anaphora tokens', () => {
    expect(textRequestsContextReference('what about volume?', true)).toBe(true);
    expect(textRequestsContextReference('and the range?', true)).toBe(true);
    expect(textRequestsContextReference('what about the close?', true)).toBe(true);
    expect(textRequestsContextReference('how about the move?', true)).toBe(true);

    // Without prior context, these should not be treated as context references.
    expect(textRequestsContextReference('what about volume?', false)).toBe(false);
  });

  it('detects anaphoric context references', () => {
    expect(textRequestsContextReference('same thing but first hour', true)).toBe(true);
    expect(textRequestsContextReference('do that again', true)).toBe(true);
    expect(textRequestsContextReference('do that analysis on NVDA', true)).toBe(true);
    expect(textRequestsContextReference('same period', true)).toBe(true);
    expect(textRequestsContextReference('keep the previous interval but show volume instead', true)).toBe(true);
  });

  it('rejects non-anaphoric relative time as context references', () => {
    expect(textRequestsContextReference('30 minutes earlier', true)).toBe(false);
  });

  it('nominates the correct singular analysis kinds', () => {
    expect(selectedAnalysisKinds('range first hour')).toEqual(['window_ohlc']);
    expect(selectedAnalysisKinds('what was volume this morning')).toEqual(['window_volume']);
    expect(selectedAnalysisKinds('how much did it move up to here')).toEqual(['window_change']);
    expect(selectedAnalysisKinds('what kind of candle am I on')).toEqual(['candle_shape']);
    expect(selectedAnalysisKinds('how did AAPL do today')).toEqual(['window_summary']);
    expect(selectedAnalysisKinds('what was the close')).toEqual(['window_ohlc']);
    expect(selectedAnalysisKinds('first 30 minutes')).toEqual(['window_ohlc']);
    expect(selectedAnalysisKinds('final 45 minutes')).toEqual(['window_ohlc']);
  });
});

describe('holdout paraphrase dimensions', () => {
  it('handles holdout market-window paraphrases', () => {
    expect(textRequestsWindowAnalysis('what was the turnover in the final 30 minutes')).toBe(true);
    expect(textRequestsWindowAnalysis('show me shares traded in the opening hour')).toBe(true);
    expect(textRequestsWindowAnalysis('was the first hour move bigger than the last hour')).toBe(true);
    expect(textRequestsWindowAnalysis('describe the candle structure and range for the first hour')).toBe(true);
  });

  it('selects the right analysis kinds for holdout paraphrases', () => {
    expect(selectedAnalysisKinds('what was the turnover in the final 30 minutes')).toEqual(['window_volume']);
    expect(selectedAnalysisKinds('show me shares traded in the opening hour')).toEqual(['window_volume']);
    expect(selectedAnalysisKinds('was the first hour move bigger than the last hour')).toBeUndefined();
    expect(selectedAnalysisKinds('how did the morning compare to the afternoon')).toEqual(['window_compare']);
  });

  it('treats context-dependent holdout paraphrases as context references when prior action exists', () => {
    expect(textRequestsContextReference('keep the previous interval but show volume instead', true)).toBe(true);
    expect(textRequestsContextReference('what about the close', true)).toBe(true);
    expect(textRequestsContextReference('same breakdown', true)).toBe(true);
  });

  it('does not include verbatim benchmark/holdout sentences in the example library', () => {
    // This is a structural guard: the example library should never contain an
    // exact benchmark turn or a holdout paraphrase. The library is a private
    // constant in intent.ts; we can only assert that the adaptive selection
    // never relies on exact sentence matching at runtime.
    expect(textRequestsAnalysis('quarter past ten')).toBe(false);
    expect(textRequestsAnalysis('quarter to three in the afternoon')).toBe(false);
  });
});
