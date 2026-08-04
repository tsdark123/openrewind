// =============================================================================
// Action-dimension detection shared by the orchestrator, intent extractor,
// and grounding sanitizer. Centralizing these helpers keeps the pipeline
// consistent and lets the pre-validation sanitizer strip ungrounded optional
// fields before strict validation.
//
// This file implements one bounded, tokenized lexical detector for analysis
// language. It uses a closed vocabulary of analytical stems, conservative
// edit-distance (Damerau-Levenshtein / Optimal String Alignment) and prefix
// matching. It does not rely on exact full-sentence regexes.
// =============================================================================

import { extractDateInput, extractTimeframe, type ChartCommand } from '../planner';

export type ActionDimension =
  | 'symbol'
  | 'date'
  | 'timeframe'
  | 'absoluteTime'
  | 'relativeSeek'
  | 'playbackControl'
  | 'candleQuery'
  | 'previousSymbol'
  | 'analysisRequest';

export const ALL_ACTION_DIMENSIONS: ActionDimension[] = [
  'symbol',
  'date',
  'timeframe',
  'absoluteTime',
  'relativeSeek',
  'playbackControl',
  'candleQuery',
  'previousSymbol',
  'analysisRequest',
];

export const INHERIT_FIELD_TO_DIMENSION: Record<string, ActionDimension | undefined> = {
  date: 'date',
  timeframe: 'timeframe',
  seekTime: 'absoluteTime',
  relativeSeekMinutes: 'relativeSeek',
  playback: 'playbackControl',
  finalQuery: 'candleQuery',
  analysisRequests: 'analysisRequest',
};

export function looksLikeSwitch(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(switch|go to|load|open|change to|show|pull)\b/.test(t);
}

export function textRequestsTimeframe(t: string): boolean {
  // The planner's timeframe extractor enforces the same rule: a number is only
  // a timeframe when it is paired with a unit (minute/hour/day/m/h/d) or a
  // recognized bar/timeframe suffix (bar/candle/timeframe/tf).  A bare number
  // followed by "chart" is not enough.
  return extractTimeframe(t) !== undefined;
}

export function textRequestsDate(t: string): boolean {
  // Reuse the planner's actual date extractor so any relative trading-session
  // phrase it recognizes is also treated as a date request here.
  return extractDateInput(t) !== undefined;
}

export function textRequestsAbsoluteTime(t: string): boolean {
  return (
    /\b\d{1,2}:\d{2}\b/.test(t) ||
    /\b\d{1,2}\s*(?:am|pm)\b/i.test(t) ||
    /\b(?:noon|midnight|market\s+open|market\s+close)\b/i.test(t) ||
    /\b(?:quarter|half)\s+(?:past|to)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(t) ||
    /\bo\'clock\b/i.test(t)
  );
}

export function textRequestsRelativeSeek(t: string): boolean {
  if (/\b(?:take me back|previous symbol|previous stock|stock i was just on|was just on)\b/i.test(t)) return false;
  return (
    /\b(?:\d+|half)\s*(?:an?\s+)?(?:minute|minutes|hour|hours|hr|hrs|min|mins)\s+(?:ago|earlier|later|before|after)\b/i.test(t) ||
    /\b(?:earlier|later)\b/i.test(t) ||
    /\b(?:go|move|skip|jump)\s+back\b/i.test(t) ||
    /\brewind\s+(?:\d+|half|a few)?\s*(?:minute|minutes|hour|hours)?/i.test(t)
  );
}

export function textRequestsPlaybackControl(t: string): boolean {
  return /\b(?:play|pause|rewind|fast[-\s]?forward|fastforward|speed up|slow down|set\s+speed)\b/.test(t);
}

export function textRequestsPreviousSymbol(t: string): boolean {
  return /\b(?:take me back|previous symbol|previous stock|stock i was just on|was just on)\b/i.test(t);
}

// ---------------------------------------------------------------------------
// Bounded lexical analysis-language detector
// ---------------------------------------------------------------------------

interface ConceptDef {
  kind: 'window' | 'shape' | 'candle' | 'price' | 'summary' | 'time' | 'compare' | 'direction';
  /** canonical stems / inflections for this concept */
  terms: string[];
}

const ANALYSIS_CONCEPTS: Record<string, ConceptDef> = {
  volume: { kind: 'window', terms: ['volume', 'volumes', 'vol', 'volumetric'] },
  range: { kind: 'window', terms: ['range', 'ranges', 'rang'] },
  change: { kind: 'window', terms: ['change', 'changes', 'changed', 'changing'] },
  move: { kind: 'window', terms: ['move', 'moved', 'moves', 'moving', 'movement', 'mover'] },
  high: { kind: 'window', terms: ['high', 'higher', 'highest', 'highs'] },
  low: { kind: 'window', terms: ['low', 'lower', 'lowest', 'lows'] },
  open: { kind: 'window', terms: ['open', 'opening', 'opened', 'opens'] },
  close: { kind: 'window', terms: ['close', 'closing', 'closed', 'closes'] },
  body: { kind: 'shape', terms: ['body', 'bodies'] },
  wick: { kind: 'shape', terms: ['wick', 'wicks'] },
  shadow: { kind: 'shape', terms: ['shadow', 'shadows'] },
  anatomy: { kind: 'shape', terms: ['anatomy'] },
  shape: { kind: 'shape', terms: ['shape', 'shapes', 'shaped', 'kind', 'kinds', 'type', 'types', 'sort', 'sorts'] },
  compare: { kind: 'compare', terms: ['compare', 'compared', 'comparing', 'comparison', 'vs', 'versus', 'against'] },
  summary: { kind: 'summary', terms: ['summary', 'overview', 'recap', 'did', 'do', 'does', 'done', 'doing'] },
  session: { kind: 'time', terms: ['session', 'sessions', 'today', 'day', 'days'] },
  morning: { kind: 'window', terms: ['morning', 'mornings', 'mornin'] },
  afternoon: { kind: 'window', terms: ['afternoon', 'afternoons'] },
  hour: { kind: 'window', terms: ['hour', 'hours', 'hr', 'hrs'] },
  minute: { kind: 'window', terms: ['minute', 'minutes', 'min', 'mins'] },
  first: { kind: 'window', terms: ['first'] },
  last: { kind: 'window', terms: ['last'] },
  candle: { kind: 'candle', terms: ['candle', 'candles', 'bar', 'bars', 'ohlc'] },
  price: { kind: 'price', terms: ['price', 'prices', 'worth', 'value', 'cost'] },
  direction: { kind: 'direction', terms: ['up', 'down', 'higher', 'lower'] },
  now: { kind: 'time', terms: ['now', 'here', 'rn', 'currently', 'current', 'cursor', 'latest'] },
  analysis: { kind: 'summary', terms: ['analysis', 'analyses', 'analyze'] },
  total: { kind: 'window', terms: ['total', 'totals'] },
  average: { kind: 'window', terms: ['average', 'avg', 'averages'] },
};

// Tokens that are a one-edit typo of an analytical stem but are common words
// and must not fire the detector. They are unrelated in meaning.
const NON_ANALYSIS_TOKENS: ReadonlySet<string> = new Set([
  'more',
  'some',
  'make',
  'made',
  'come',
  'home',
  'done',
  'none',
  'love',
  'live',
  'have',
]);

// If the user is talking about playback/seek, a "move" token is not a price
// movement request.
const PLAYBACK_CONTEXT: ReadonlySet<string> = new Set([
  'replay',
  'play',
  'playhead',
  'earlier',
  'later',
  'back',
  'forward',
  'skip',
  'jump',
  'rewind',
  'fastforward',
  'cursor',
]);

// Query cues that turn a candle/price mention into a candle lookup.
const CANDLE_QUERY_CUES: ReadonlySet<string> = new Set([
  'what',
  'which',
  'tell',
  'show',
  'give',
  'where',
  'when',
  'this',
  'that',
]);

// Summary cues need a session/subject/window partner so bare "do it" is not
// treated as an analysis request.
const SUMMARY_SUBJECTS: ReadonlySet<string> = new Set([
  'it',
  'stock',
  'market',
  'symbol',
  'today',
  'session',
  'day',
  'now',
  'here',
  'rn',
  'current',
  'cursor',
  'up',
  'down',
  'higher',
  'lower',
  'morning',
  'afternoon',
  'hour',
  'minute',
  'first',
  'last',
  'total',
  'average',
  'analysis',
]);

function tokenizeForAnalysis(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9:\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0 && !/^\d+$/.test(t));
}

/**
 * Optimal String Alignment (Damerau-Levenshtein restricted to adjacent
 * transpositions). Sufficient for the bounded typo set in the prompt.
 */
function optimalStringAlignment(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,     // deletion
        d[i][j - 1] + 1,     // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost); // transposition
      }
    }
  }
  return d[m][n];
}

function maxPrefixDiff(tokenLength: number): number {
  if (tokenLength <= 3) return 0;
  if (tokenLength <= 5) return 1;
  return 2;
}

function isFuzzyConceptMatch(token: string, term: string): boolean {
  if (token === term) return true;

  const [short, long] = token.length < term.length ? [token, term] : [term, token];
  if (long.startsWith(short)) {
    if (long.length - short.length <= maxPrefixDiff(short.length)) return true;
  }

  if (token.length === term.length && token.length >= 3) {
    const dist = optimalStringAlignment(token, term);
    if (dist === 1) return true;
  }

  // A single internal insertion/deletion that keeps the first and last
  // characters intact is a typical typo (e.g. "mornig" vs "morning").
  // Deletions or insertions at the very start/end are handled by the
  // prefix/suffix rules above.
  if (token.length > 2 && term.length > 2 && token[0] === term[0] && token[token.length - 1] === term[term.length - 1]) {
    const dist = optimalStringAlignment(token, term);
    if (dist === 1) return true;
  }

  return false;
}

interface DetectedConcepts {
  tokens: string[];
  concepts: Set<string>;
  kinds: Record<ConceptDef['kind'], boolean>;
  hasPlaybackContext: boolean;
}

function detectAnalysisConcepts(text: string): DetectedConcepts {
  const tokens = tokenizeForAnalysis(text);
  const concepts = new Set<string>();
  const kinds: Record<ConceptDef['kind'], boolean> = {
    window: false,
    shape: false,
    candle: false,
    price: false,
    summary: false,
    time: false,
    compare: false,
    direction: false,
  };
  const hasPlaybackContext = tokens.some((t) => PLAYBACK_CONTEXT.has(t));

  for (const token of tokens) {
    if (NON_ANALYSIS_TOKENS.has(token)) continue;
    for (const [concept, def] of Object.entries(ANALYSIS_CONCEPTS)) {
      for (const term of def.terms) {
        if (isFuzzyConceptMatch(token, term)) {
          concepts.add(concept);
          kinds[def.kind] = true;
          break;
        }
      }
    }
  }

  // Suppress "move" when it appears in a playback/seek context.
  if (concepts.has('move') && hasPlaybackContext) {
    concepts.delete('move');
    if (!concepts.has('change')) kinds.window = false;
  }

  return { tokens, concepts, kinds, hasPlaybackContext };
}

export function textRequestsAnalysis(t: string): boolean {
  if (textRequestsCandleShape(t)) return true;
  if (textRequestsWindowAnalysis(t)) return true;
  if (textRequestsSummary(t)) return true;
  return false;
}

// Core window-metric concepts that can trigger a window analysis on their own.
const CORE_WINDOW_CONCEPTS: ReadonlySet<string> = new Set([
  'volume',
  'range',
  'change',
  'move',
  'high',
  'low',
  'open',
  'close',
  'compare',
  'morning',
  'afternoon',
  'total',
  'average',
]);

// Window-boundary concepts.  They need a duration partner so "half an hour"
// (a seek duration) is not mistaken for a window analysis.
const WINDOW_BOUNDARY_CONCEPTS: ReadonlySet<string> = new Set([
  'first',
  'last',
  'morning',
  'afternoon',
]);

// Tokens that turn an "open"/"close" mention into a UI action or market
// time-of-day instead of an OHLC analysis request.
const OHLC_ACTION_CONTEXT: ReadonlySet<string> = new Set(['market', 'chart', 'app', 'window', 'terminal']);

const QUESTION_WORDS: ReadonlySet<string> = new Set(['what', 'how', 'which', 'where', 'when', 'why']);

export function textRequestsWindowAnalysis(t: string): boolean {
  const d = detectAnalysisConcepts(t);
  const coreConcepts = Array.from(d.concepts).filter((c) => CORE_WINDOW_CONCEPTS.has(c));
  const coreHit = coreConcepts.length > 0;
  const hasDuration = d.concepts.has('hour') || d.concepts.has('minute');
  const hasBoundary = Array.from(d.concepts).some((c) => WINDOW_BOUNDARY_CONCEPTS.has(c));
  const hasQuestion = d.tokens.some((tok) => QUESTION_WORDS.has(tok));
  const hasMultipleCores = coreConcepts.length >= 2;
  // A single bare core word (or a one-token typo of a core word) is enough
  // on its own, but a core word next to an unrelated non-analytical word is not.
  const singleCoreWord = coreConcepts.length === 1 && d.tokens.length === 1;

  if ((d.concepts.has('open') || d.concepts.has('close')) && d.tokens.some((tok) => OHLC_ACTION_CONTEXT.has(tok))) {
    // "market open", "close the chart", etc. are not window analysis unless
    // there is another window metric present.
    const otherCore = Array.from(d.concepts).some(
      (c) => c !== 'open' && c !== 'close' && (CORE_WINDOW_CONCEPTS.has(c) || WINDOW_BOUNDARY_CONCEPTS.has(c))
    );
    if (!otherCore && !(hasDuration && hasBoundary)) return false;
  }

  if (!coreHit) return false;
  if ((hasDuration && hasBoundary) || hasQuestion || hasMultipleCores || singleCoreWord) return true;
  return false;
}

export function textRequestsCandleShape(t: string): boolean {
  const d = detectAnalysisConcepts(t);
  // Unambiguous shape parts need no explicit "candle" token.
  if (d.concepts.has('body') || d.concepts.has('wick') || d.concepts.has('shadow') || d.concepts.has('anatomy')) {
    return true;
  }
  // Generic shape words (kind/type/shape) need a candle context.
  if ((d.concepts.has('shape') || d.concepts.has('kind') || d.concepts.has('type')) &&
      (d.concepts.has('candle') || d.concepts.has('bar') || d.concepts.has('ohlc'))) {
    return true;
  }
  return false;
}

const CANDLE_CONTEXT_TERMS: ReadonlySet<string> = new Set([
  'candle', 'candles', 'bar', 'bars', 'ohlc',
  'price', 'prices', 'worth', 'value', 'cost',
]);
const NOW_TOKENS: ReadonlySet<string> = new Set(['now', 'here', 'rn', 'currently', 'current', 'cursor', 'latest']);

function isTimeToken(token: string): boolean {
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(token)) return true;
  return textRequestsAbsoluteTime(token);
}

function isCandleContextToken(token: string): boolean {
  for (const term of CANDLE_CONTEXT_TERMS) {
    if (isFuzzyConceptMatch(token, term)) return true;
  }
  return false;
}

function hasNearbyCandleSignal(d: DetectedConcepts): boolean {
  const contextIdx: number[] = [];
  d.tokens.forEach((tok, i) => {
    if (isCandleContextToken(tok)) contextIdx.push(i);
  });
  if (contextIdx.length === 0) return false;

  const compareTerms = ANALYSIS_CONCEPTS.compare.terms;
  for (let i = 0; i < d.tokens.length; i++) {
    const tok = d.tokens[i];
    const isSignal =
      CANDLE_QUERY_CUES.has(tok) ||
      isTimeToken(tok) ||
      NOW_TOKENS.has(tok) ||
      compareTerms.includes(tok);
    if (!isSignal) continue;
    for (const idx of contextIdx) {
      if (Math.abs(i - idx) <= 4) return true;
    }
  }
  return false;
}

export function textRequestsCandleQuery(t: string): boolean {
  if (textRequestsCandleShape(t) || textRequestsWindowAnalysis(t)) return false;
  const d = detectAnalysisConcepts(t);
  const hasCandleContext = d.concepts.has('candle') || d.concepts.has('bar') || d.concepts.has('ohlc') || d.concepts.has('price');
  if (!hasCandleContext) return false;
  return hasNearbyCandleSignal(d);
}

export function textRequestsSummary(t: string): boolean {
  const d = detectAnalysisConcepts(t);
  const summaryCues = new Set(['summary', 'overview', 'recap', 'did', 'do', 'does', 'done', 'doing', 'how', 'what']);
  const summaryCuesFound = Array.from(d.concepts).filter((c) => summaryCues.has(c));
  if (summaryCuesFound.length === 0) return false;

  const subjectTokens = d.tokens.filter(
    (tok) => SUMMARY_SUBJECTS.has(tok) && !(tok === 'session' && textRequestsDate(t))
  );
  const onlySubjectIsIt = subjectTokens.length === 1 && subjectTokens[0] === 'it';
  // "do it" has only the imperative "do" and the pronoun "it"; without a
  // question word or a second summary cue it is not a summary request.
  if (onlySubjectIsIt && summaryCuesFound.length < 2) return false;

  const hasSubject = subjectTokens.length > 0;
  const hasWindowOrShape = d.kinds.window || d.kinds.shape;
  const hasSession = d.concepts.has('today') || d.concepts.has('day') || d.concepts.has('now');

  // "Up" and "down" are only directional summaries when they are not part of
  // a common phrasal verb (set up, look up, give up, ...).
  const phrasalHeads = new Set(['set', 'get', 'make', 'look', 'turn', 'shut', 'pick', 'take', 'give', 'fill', 'wake', 'clean', 'put']);
  const directionTerms = ANALYSIS_CONCEPTS.direction.terms;
  let hasDirection = false;
  for (let i = 1; i < d.tokens.length; i++) {
    const tok = d.tokens[i];
    if (!directionTerms.includes(tok)) continue;
    if (phrasalHeads.has(d.tokens[i - 1])) continue;
    hasDirection = true;
    break;
  }

  return hasSubject || hasWindowOrShape || hasSession || hasDirection;
}

// ---------------------------------------------------------------------------
// Unsupported indicator detection
// ---------------------------------------------------------------------------

const INDICATOR_CONCEPTS: ReadonlySet<string> = new Set([
  'rsi',
  'macd',
  'bollinger',
  'bollingerband',
  'bollingerbands',
  'ema',
  'sma',
  'atr',
  'stochastic',
  'vwap',
  'cci',
  'adx',
  'obv',
  'momentum',
  'williams',
  'williamsr',
  'fibonacci',
  'support',
  'resistance',
  'breakout',
  'pattern',
  'patterns',
  'trend',
  'trends',
  'trendline',
  'trendlines',
  'volatility',
  'vwap',
  'backtest',
]);

function stripNumericSuffix(token: string): string {
  return token.replace(/\d+s?$/, '').replace(/s$/, '');
}

export function textRequestsUnsupportedIndicator(t: string): boolean {
  const tokens = tokenizeForAnalysis(t);
  for (let i = 0; i < tokens.length; i++) {
    const token = stripNumericSuffix(tokens[i]);
    if (INDICATOR_CONCEPTS.has(token)) return true;
    if (token === 'bollinger' && i + 1 < tokens.length) {
      const next = tokens[i + 1];
      if (next === 'band' || next === 'bands') return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dimension aggregation
// ---------------------------------------------------------------------------

export function getRequestedDimensions(
  text: string,
  cmd: ChartCommand,
  baseDate?: string
): Set<ActionDimension> {
  const t = text;
  const dims = new Set<ActionDimension>();

  const isAnalysis = textRequestsAnalysis(t);
  const isCandleQuery = textRequestsCandleQuery(t) || (cmd.intent === 'candle_query' && !isAnalysis);

  const switchHint = (cmd.intent === 'switch' || (cmd.intent === 'unknown' && looksLikeSwitch(text))) && !isAnalysis;
  if (cmd.symbol || switchHint) {
    dims.add('symbol');
  }
  if (cmd.date || cmd.dateInput || extractDateInput(text, baseDate)) {
    dims.add('date');
  } else if (textRequestsDate(t)) {
    dims.add('date');
  }
  if (cmd.timeframe !== undefined) {
    dims.add('timeframe');
  } else if (textRequestsTimeframe(t)) {
    dims.add('timeframe');
  }

  const wantsCandle = isCandleQuery;
  if ((cmd.startTime || cmd.endTime) && (!isAnalysis || wantsCandle)) {
    dims.add('absoluteTime');
  } else if (textRequestsAbsoluteTime(t) && !isAnalysis) {
    dims.add('absoluteTime');
  }
  if (!isAnalysis) {
    if (cmd.relativeMinutes !== undefined) {
      dims.add('relativeSeek');
    } else if (textRequestsRelativeSeek(t)) {
      dims.add('relativeSeek');
    }
  }
  if (
    (cmd.speed !== undefined || ['play', 'pause', 'rewind', 'fast_forward', 'set_speed', 'seek'].includes(cmd.intent)) &&
    !isAnalysis
  ) {
    dims.add('playbackControl');
  } else if (textRequestsPlaybackControl(t)) {
    dims.add('playbackControl');
  }
  if (wantsCandle) {
    dims.add('candleQuery');
  }
  if (textRequestsPreviousSymbol(t)) {
    dims.add('previousSymbol');
  }
  if (isAnalysis) {
    dims.add('analysisRequest');
  }
  return dims;
}
