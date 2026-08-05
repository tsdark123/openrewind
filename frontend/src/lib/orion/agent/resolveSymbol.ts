// =============================================================================
// Symbol resolver — pure, deterministic, dependency-free.
//
// Turns a fragment of user text ("apple", "adobe stock", "NVDA", "nvidia
// corporation") into a ticker present in the caller-provided availableTickers
// list, or explains why it could not.
//
// The alias source of truth is `SYMBOL_ALIASES` in `../symbolAliases.ts`.
// The offline planner and the agent resolver now share the same canonical map,
// with the agent resolver allowing callers to inject extra test / local aliases
// without changing the global table.
// =============================================================================

import { SYMBOL_ALIASES } from '../symbolAliases';

/** Company-name suffix noise words to strip before lookup. */
// This is a category-based filter (articles, prepositions, question words,
// analysis/summary verbs, state-of-being helpers, pronouns and generic
// session/time nouns).  It is not a one-word blacklist.
const NAME_STOP_WORDS = new Set([
  'the', 'a', 'an', 'stock', 'shares', 'ticker', 'symbol', 'company',
  'corporation', 'corp', 'incorporated', 'inc', 'ltd', 'limited', 'plc',
  'holdings', 'group', 'co', 'nv', 'sa', 'ag', 'and', 'to', 'switch',
  'change', 'go', 'load', 'open', 'show', 'please',
  'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whom', 'whose',
  'describe', 'describes', 'described', 'describing',
  'summarize', 'summarizes', 'summarized', 'summarizing',
  'explain', 'explains', 'explained', 'explaining',
  'tell', 'told', 'telling',
  'happen', 'happens', 'happened', 'happening',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'did', 'does', 'do', 'done', 'doing', 'has', 'have', 'had',
  'it', 'this', 'that', 'these', 'those', 'they', 'them', 'their', 'there', 'here', 'me',
  'market', 'today', 'yesterday', 'tomorrow', 'session', 'day',
]);

/** Return the canonical alias table plus any caller-supplied extras. */
export function getCombinedAliases(extra?: Record<string, string>): Record<string, string> {
  return { ...SYMBOL_ALIASES, ...(extra ?? {}) };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SymbolMatchKind =
  | 'exact_ticker'      // "AAPL" -> AAPL
  | 'alias'             // "apple" -> AAPL
  | 'alias_multi_word'  // "eli lilly" -> LLY
  | 'partial_alias'     // "adob"  -> ADBE (only when unique)
  | 'unavailable_alias' // alias resolved to a ticker not in availableTickers
  | 'none';

export interface SymbolResolutionSuccess {
  ok: true;
  symbol: string;             // uppercase ticker, present in availableTickers
  confidence: number;         // 0..1
  matchKind: SymbolMatchKind;
  matchedTerm: string;        // the token/phrase that matched
  alternates: string[];       // other plausible tickers (never includes symbol)
  needsClarification: false;
}

export interface SymbolResolutionAmbiguous {
  ok: false;
  symbol: undefined;
  confidence: number;
  matchKind: 'ambiguous';
  matchedTerm: string;
  candidates: string[];       // all plausible tickers, length >= 2
  needsClarification: true;
  message: string;
}

export interface SymbolResolutionUnavailable {
  ok: false;
  symbol: undefined;
  confidence: number;
  matchKind: 'unavailable_alias';
  matchedTerm: string;
  resolvedTicker: string;     // known ticker, but not in availableTickers
  needsClarification: false;
  message: string;
}

export interface SymbolResolutionNone {
  ok: false;
  symbol: undefined;
  confidence: 0;
  matchKind: 'none';
  matchedTerm: '';
  needsClarification: false;
  message: string;
}

export type SymbolResolution =
  | SymbolResolutionSuccess
  | SymbolResolutionAmbiguous
  | SymbolResolutionUnavailable
  | SymbolResolutionNone;

export interface ResolveSymbolOptions {
  availableTickers: string[];
  /** Optional additional aliases (lowercase key → uppercase ticker). */
  extraAliases?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
}

function meaningfulTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !NAME_STOP_WORDS.has(t));
}

function makeSuccess(
  symbol: string,
  matchKind: SymbolMatchKind,
  matchedTerm: string,
  confidence: number,
  alternates: string[] = []
): SymbolResolutionSuccess {
  return {
    ok: true,
    symbol,
    confidence,
    matchKind,
    matchedTerm,
    alternates,
    needsClarification: false,
  };
}

export function resolveSymbol(
  text: string,
  options: ResolveSymbolOptions
): SymbolResolution {
  const availableSet = new Set(options.availableTickers.map((t) => t.toUpperCase()));
  const aliases = getCombinedAliases(options.extraAliases);

  const raw = (text ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      symbol: undefined,
      confidence: 0,
      matchKind: 'none',
      matchedTerm: '',
      needsClarification: false,
      message: 'No symbol or company name was provided.',
    };
  }

  const tokens = tokenize(raw);
  const filtered = meaningfulTokens(tokens);

  // Step 1: exact uppercase ticker anywhere in the message.
  for (const t of tokens) {
    const up = t.toUpperCase();
    if (availableSet.has(up)) {
      return makeSuccess(up, 'exact_ticker', up, 1);
    }
  }

  // Step 2: known alias present as a token (e.g. "apple" -> AAPL).
  //   - collect ALL alias matches so we can detect ambiguity across the phrase.
  const aliasHits: Array<{ term: string; ticker: string }> = [];
  for (const t of filtered) {
    const hit = aliases[t];
    if (hit) aliasHits.push({ term: t, ticker: hit });
  }
  // De-duplicate by ticker.
  const uniqueAliasTickers = Array.from(new Set(aliasHits.map((h) => h.ticker)));

  if (uniqueAliasTickers.length === 1) {
    const ticker = uniqueAliasTickers[0];
    const term = aliasHits[0].term;
    if (availableSet.has(ticker)) {
      return makeSuccess(ticker, 'alias', term, 0.95);
    }
    return {
      ok: false,
      symbol: undefined,
      confidence: 0.9,
      matchKind: 'unavailable_alias',
      matchedTerm: term,
      resolvedTicker: ticker,
      needsClarification: false,
      message: `${term.charAt(0).toUpperCase() + term.slice(1)} resolves to ${ticker}, but no ${ticker} data is currently available.`,
    };
  }

  if (uniqueAliasTickers.length > 1) {
    const availableCandidates = uniqueAliasTickers.filter((t) => availableSet.has(t));
    const candidates = availableCandidates.length > 0 ? availableCandidates : uniqueAliasTickers;
    return {
      ok: false,
      symbol: undefined,
      confidence: 0.4,
      matchKind: 'ambiguous',
      matchedTerm: filtered.join(' '),
      candidates,
      needsClarification: true,
      message: `That could mean ${candidates.join(', ')}. Which one did you mean?`,
    };
  }

  // Step 3: multi-token phrase alias (e.g. "home depot" -> HD via 'homedepot').
  if (filtered.length >= 2) {
    const joined = filtered.join('');
    const joinedTicker = aliases[joined];
    if (joinedTicker) {
      if (availableSet.has(joinedTicker)) {
        return makeSuccess(joinedTicker, 'alias_multi_word', filtered.join(' '), 0.9);
      }
      return {
        ok: false,
        symbol: undefined,
        confidence: 0.85,
        matchKind: 'unavailable_alias',
        matchedTerm: filtered.join(' '),
        resolvedTicker: joinedTicker,
        needsClarification: false,
        message: `${filtered.join(' ')} resolves to ${joinedTicker}, but no ${joinedTicker} data is currently available.`,
      };
    }
  }

  // Step 4: prefix/partial alias match — only when unambiguous. Requires
  // a token of at least 3 chars to avoid one-letter false positives.
  const prefixHits: Array<{ term: string; ticker: string }> = [];
  for (const t of filtered) {
    if (t.length < 3) continue;
    for (const [alias, ticker] of Object.entries(aliases)) {
      if (alias === t) continue; // already handled above
      if (alias.startsWith(t)) {
        prefixHits.push({ term: t, ticker });
      }
    }
  }
  const uniquePrefixTickers = Array.from(new Set(prefixHits.map((h) => h.ticker)));
  if (uniquePrefixTickers.length === 1 && availableSet.has(uniquePrefixTickers[0])) {
    return makeSuccess(uniquePrefixTickers[0], 'partial_alias', prefixHits[0].term, 0.7);
  }
  if (uniquePrefixTickers.length > 1) {
    const availableCandidates = uniquePrefixTickers.filter((t) => availableSet.has(t));
    const candidates = availableCandidates.length > 0 ? availableCandidates : uniquePrefixTickers;
    return {
      ok: false,
      symbol: undefined,
      confidence: 0.3,
      matchKind: 'ambiguous',
      matchedTerm: filtered.join(' '),
      candidates,
      needsClarification: true,
      message: `That could mean ${candidates.join(', ')}. Which one did you mean?`,
    };
  }

  return {
    ok: false,
    symbol: undefined,
    confidence: 0,
    matchKind: 'none',
    matchedTerm: '',
    needsClarification: false,
    message: `No known ticker or company name matched "${raw}".`,
  };
}
