// =============================================================================
// Intent-to-AgentPlan compiler.
//
// Takes a validated ChartActionIntent and produces a deterministic AgentPlan using
// only the existing V1 capability registry. Runtime anchors (today's date for
// relative trading-date requests) are supplied from TypeScript, never from the
// model.
//
// Phase 5 adds:
//   - context-reference resolution ("do that again", "same timeframe",
//     "go back to the candle").
//   - finalQuery "compare_candles" mapped to the narrow analysis.compare_candles
//     capability.
// =============================================================================

import type {
  AgentPlan, AgentStep, ChartActionIntent, CandleSnapshot, SemanticPlayback,
  ExecutionContextEntry, InheritableField, CompareSide, CompareSides, ResolvedCompare,
  ResolvedCompareSide, AnalysisRequest, AnalysisWindow,
} from './types';
import type { AgentContext } from './types';
import { getCapability } from './capabilities';
import { normalizeAnalysisWindow } from './intent';
import { textRequestsContextReference, textRequestsWholeSession, textRequestsSummary } from './dimensions';
import { extractTimes, formatTime, looksLikeTimeAttempt, US_EQUITY_MARKET_OPEN, US_EQUITY_MARKET_CLOSE, MORNING_END, AFTERNOON_START } from '../planner';

export interface CompileOptions {
  /** Anchor for relative_trading dates (YYYY-MM-DD). Defaults to today. */
  anchorDate?: string;
  /** Resolved candle for "go back to the candle" or fallback. */
  resolvedCandle?: CandleSnapshot;
  /** Resolved comparison sides for "compare_candles". */
  resolvedCompare?: ResolvedCompare;
  /** Current session symbol, used as a fallback when a date is supplied with no symbol. */
  stateSymbol?: string;
  /** Current session date, used to skip redundant resolve_trading_date. */
  stateDate?: string;
  /** Current session timeframe, used to skip redundant chart.set_timeframe. */
  stateTimeframe?: number;
  /** Tickers that do not need session.resolve_symbol. */
  availableTickers?: string[];
}

export interface ContextResolutionSuccess {
  ok: true;
  intent: ChartActionIntent;
  anchorDate?: string;
  resolvedCandle?: CandleSnapshot;
  resolvedCompare?: ResolvedCompare;
  planSummary?: string;
}

export interface ContextResolutionFailure {
  ok: false;
  error: string;
}

export type ContextResolutionResult = ContextResolutionSuccess | ContextResolutionFailure;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function analysisRequestWindow(req: AnalysisRequest): AnalysisWindow | undefined {
  if (req.kind === 'window_compare') return req.left;
  return (req as { window?: AnalysisWindow }).window;
}

function defaultAnalysisWindow(): AnalysisWindow {
  return { kind: 'whole_session' };
}

function windowsEqual(a: AnalysisWindow | undefined, b: AnalysisWindow | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'whole_session' || a.kind === 'up_to_cursor') return true;
  if (a.kind === 'time_range' && b.kind === 'time_range') {
    return a.fromTime === b.fromTime && a.toTime === b.toTime;
  }
  return false;
}

function isSessionComplement(
  candidate: AnalysisWindow,
  other: AnalysisWindow,
  sessionOpen: string,
  sessionClose: string
): boolean {
  if (candidate.kind !== 'time_range' || other.kind !== 'time_range') return false;
  return (
    (candidate.fromTime === sessionOpen && candidate.toTime === other.fromTime) ||
    (candidate.toTime === sessionClose && candidate.fromTime === other.toTime)
  );
}

function isTimeWithin(time: string, fromTime: string, toTime: string): boolean {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const t = toMin(time);
  const f = toMin(fromTime);
  const z = toMin(toTime);
  return f <= t && t <= z;
}

function timeRangeFromWindow(win: AnalysisWindow | undefined): { fromTime: string; toTime: string } | undefined {
  if (win?.kind === 'time_range') return { fromTime: win.fromTime, toTime: win.toTime };
  return undefined;
}

function explicitCandidateMarketTime(text: string): string | undefined {
  const times = extractTimes(text);
  if (times.length > 0) {
    const last = times[times.length - 1];
    return formatTime(last);
  }
  const lower = text.toLowerCase();
  if (/\b(?:market\s+open|opening\s+bell)\b/.test(lower)) return formatTime(US_EQUITY_MARKET_OPEN);
  if (/\b(?:market\s+close|closing\s+bell)\b/.test(lower)) return formatTime(US_EQUITY_MARKET_CLOSE);
  return undefined;
}

function siblingTimeRange(
  resolvedSoFar: AnalysisRequest[],
  pending: AnalysisRequest[]
): { fromTime: string; toTime: string } | undefined {
  for (const r of resolvedSoFar) {
    const win = timeRangeFromWindow(analysisRequestWindow(r));
    if (win) return win;
    if (r.kind === 'window_compare') {
      const l = timeRangeFromWindow(r.left);
      if (l) return l;
      const right = timeRangeFromWindow(r.right);
      if (right) return right;
    }
  }
  for (const r of pending) {
    if (r.kind === 'window_compare') {
      const left = timeRangeFromWindow(normalizeAnalysisWindow(r.left) as AnalysisWindow | undefined);
      if (left) return left;
      const right = timeRangeFromWindow(normalizeAnalysisWindow(r.right) as AnalysisWindow | undefined);
      if (right) return right;
    } else if ((r as { window?: AnalysisWindow }).window) {
      const w = timeRangeFromWindow(normalizeAnalysisWindow((r as { window?: AnalysisWindow }).window) as AnalysisWindow | undefined);
      if (w) return w;
    }
  }
  return undefined;
}

type CandleShapeResolution = { source: 'current_chart_candle' | 'market_time'; marketTime?: string };

function resolveCandleShape(
  cur: { source: 'current_chart_candle' | 'market_time'; marketTime?: string },
  resolvedSoFar: AnalysisRequest[],
  pending: AnalysisRequest[],
  text: string
): CandleShapeResolution | { error: string } {
  const sibling = siblingTimeRange(resolvedSoFar, pending);
  const explicit = explicitCandidateMarketTime(text);

  const boundaryTimes = sibling ? new Set([sibling.fromTime, sibling.toTime]) : new Set<string>();
  // If the user names a single non-boundary time inside a compound window
  // (e.g. "candle at 11:30 and the move from 10 to 12"), prefer that time.
  let candidate: string | undefined;
  if (sibling && explicit && !boundaryTimes.has(explicit)) {
    if (isTimeWithin(explicit, sibling.fromTime, sibling.toTime)) {
      candidate = explicit;
    }
  }
  if (candidate === undefined) {
    if (sibling) {
      candidate = sibling.toTime;
    } else if (explicit) {
      candidate = explicit;
    }
  }

  if (!candidate && !sibling && looksLikeTimeAttempt(text) && extractTimes(text).length === 0) {
    return { error: "I couldn't parse that clock time. Please use a valid HH:MM or spoken time like 'quarter past eleven'." };
  }

  if (candidate) {
    // Explicit/sibling time always beats current chart, seek position,
    // and ungrounded model alternatives.
    if (cur.source === 'market_time' && cur.marketTime && cur.marketTime === candidate) {
      return { source: 'market_time', marketTime: cur.marketTime };
    }
    return { source: 'market_time', marketTime: candidate };
  }

  // No explicit/sibling candidate. Trust a model market_time only if it has a
  // marketTime; otherwise keep or revert to current_chart_candle so deictic
  // requests ("what kind of candle am I on") stay on the current candle.
  if (cur.source === 'market_time' && cur.marketTime) {
    return { source: 'market_time', marketTime: cur.marketTime };
  }
  return { source: 'current_chart_candle' };
}

export function newWindowFromText(text: string): AnalysisWindow | undefined {
  const t = text.toLowerCase();

  const lastHour = /\b(?:last|final|closing)(?:\s+|-)(?:hour|hr)\b/;
  const firstHour = /\b(?:first|opening)(?:\s+|-)(?:hour|hr)\b/;
  const morning = /\bmorning\b/;
  const afternoon = /\bafternoon\b/;

  if (lastHour.test(t)) return normalizeAnalysisWindow({ kind: 'last_hour' }) as AnalysisWindow;
  if (firstHour.test(t)) return normalizeAnalysisWindow({ kind: 'first_hour' }) as AnalysisWindow;

  const nMinutesMatch = t.match(/\b(?:first|opening|last|final|closing)(?:\s+|-)?(\d+)(?:\s+|-)?(?:minute|minutes|min|mins)\b/);
  if (nMinutesMatch) {
    const n = parseInt(nMinutesMatch[1], 10);
    const isLast = /\b(?:last|final|closing)\b/.test(nMinutesMatch[0]);
    const win = { kind: isLast ? 'last_n_minutes' : 'first_n_minutes', n };
    return normalizeAnalysisWindow(win) as AnalysisWindow;
  }

  if (morning.test(t)) {
    return { kind: 'time_range', fromTime: formatTime(US_EQUITY_MARKET_OPEN), toTime: formatTime(MORNING_END) } as AnalysisWindow;
  }
  if (afternoon.test(t)) {
    return { kind: 'time_range', fromTime: formatTime(AFTERNOON_START), toTime: formatTime(US_EQUITY_MARKET_CLOSE) } as AnalysisWindow;
  }

  const times = extractTimes(text);
  if (times.length === 2) {
    return { kind: 'time_range', fromTime: formatTime(times[0]), toTime: formatTime(times[1]) };
  }

  return undefined;
}

function resolveComparisonWindows(
  left: AnalysisWindow | undefined,
  right: AnalysisWindow | undefined,
  inherited: AnalysisWindow | undefined,
  sessionOpen: string,
  sessionClose: string,
  text: string = ''
): { left: AnalysisWindow; right: AnalysisWindow } | null {
  if (!left && !right) {
    if (inherited) return { left: inherited, right: inherited };
    return null;
  }

  if (!left) left = right ?? inherited ?? defaultAnalysisWindow();
  if (!right) right = left ?? inherited ?? defaultAnalysisWindow();

  if (!inherited) {
    return { left, right };
  }

  // 1. Inherited side is already correctly placed.
  if (windowsEqual(left, inherited)) return { left, right };
  if (windowsEqual(right, inherited)) return { left, right };

  // 2. The model copied the new window to both sides; keep the new side and use
  // the inherited window for the other.
  if (windowsEqual(left, right)) {
    return { left: inherited, right };
  }

  // 3. One side is the complement of the other across the session. The side that
  // is NOT the complement is the new window the user asked for.
  const leftIsComplement = isSessionComplement(left, right, sessionOpen, sessionClose);
  const rightIsComplement = isSessionComplement(right, left, sessionOpen, sessionClose);

  if (leftIsComplement && !rightIsComplement) {
    return { left: inherited, right };
  }
  if (rightIsComplement && !leftIsComplement) {
    return { left, right: inherited };
  }

  if (leftIsComplement && rightIsComplement) {
    // Both sides partition the session (e.g. morning vs afternoon, or first hour
    // vs the rest of the day). Try to identify the user's intended new window
    // from the text; the other side is the complement to be replaced with the
    // inherited prior window.
    const requested = newWindowFromText(text);
    if (requested) {
      if (windowsEqual(left, requested)) {
        return { left, right: inherited };
      }
      if (windowsEqual(right, requested)) {
        return { left: inherited, right };
      }
    }
    // Fall through and keep the original windows if we cannot disambiguate.
  }

  return { left, right };
}

function mergeAnalysisRequests(
  base: AnalysisRequest[] | undefined,
  current: AnalysisRequest[] | undefined,
  text: string = '',
  isContextual: boolean = false
): { ok: true; requests: AnalysisRequest[] } | { ok: false; error: string } {
  if (!current) return { ok: true, requests: base ?? [] };
  if (!base) {
    // No previous analysis to inherit from; current must be complete.
    for (let i = 0; i < current.length; i++) {
      const r = current[i];
      if (r.kind === 'candle_shape') {
        // Candle shape with no prior analysis is still resolvable from explicit
        // time text and/or sibling windows in the same request.
        continue;
      }
      if (r.kind === 'window_compare') {
        if (!r.left || !r.right) {
          return { ok: false, error: `analysisRequests[${i}] is missing left/right windows and no prior analysis exists to inherit from.` };
        }
      } else if (!r.window) {
        return { ok: false, error: `analysisRequests[${i}] is missing a window and no prior analysis exists to inherit from.` };
      }
    }
    return { ok: true, requests: current };
  }

  const lastBase = base[base.length - 1];
  const baseWindow = lastBase ? analysisRequestWindow(lastBase) : undefined;
  const sessionOpen = formatTime(US_EQUITY_MARKET_OPEN);
  const sessionClose = formatTime(US_EQUITY_MARKET_CLOSE);

  const resolved: AnalysisRequest[] = [];
  for (let i = 0; i < current.length; i++) {
    const cur = current[i];
    const baseReq = i < base.length ? base[i] : lastBase;
    const inheritedWindow = baseReq ? analysisRequestWindow(baseReq) : baseWindow;

    if (cur.kind === 'candle_shape') {
      const other = resolved.concat(current.slice(i + 1));
      const shape = resolveCandleShape(cur, resolved, other, text);
      if ('error' in shape) return { ok: false, error: shape.error };
      resolved.push({
        kind: 'candle_shape',
        ...shape,
      } as AnalysisRequest);
      continue;
    }

    if (cur.kind === 'window_compare') {
      let left = (cur.left ? normalizeAnalysisWindow(cur.left) : undefined) as AnalysisWindow | undefined;
      let right = (cur.right ? normalizeAnalysisWindow(cur.right) : undefined) as AnalysisWindow | undefined;

      if (isUngroundedWholeSession(left, text, isContextual)) left = undefined;
      if (isUngroundedWholeSession(right, text, isContextual)) right = undefined;

      if (baseReq || inheritedWindow) {
        const baseCompareLeft = baseReq?.kind === 'window_compare' ? baseReq.left : inheritedWindow;
        const baseCompareRight = baseReq?.kind === 'window_compare' ? baseReq.right : inheritedWindow;
        const textWindow = newWindowFromText(text);

        if (!left && !right) {
          if (baseReq?.kind === 'window_compare' && baseReq.left && baseReq.right) {
            left = baseReq.left;
            right = baseReq.right;
          } else if (textWindow) {
            left = inheritedWindow ?? textWindow;
            right = textWindow;
          } else {
            left = inheritedWindow ?? defaultAnalysisWindow();
            right = inheritedWindow ?? defaultAnalysisWindow();
          }
        } else {
          if (!left) left = baseCompareLeft ?? right ?? textWindow ?? defaultAnalysisWindow();
          if (!right) right = baseCompareRight ?? left ?? textWindow ?? defaultAnalysisWindow();
        }

        const compare = resolveComparisonWindows(left, right, inheritedWindow, sessionOpen, sessionClose, text);
        if (compare) {
          left = compare.left;
          right = compare.right;
        }
      } else {
        if (!left || !right) {
          return { ok: false, error: 'Please specify both windows to compare.' };
        }
      }

      if (!left || !right) {
        return { ok: false, error: 'Could not resolve the comparison windows.' };
      }

      resolved.push({ kind: 'window_compare', left, right });
      continue;
    }

    const kind = cur.kind;
    if (!kind) return { ok: false, error: `analysisRequests[${i}] has no kind and cannot be resolved.` };

    let win = (cur.window ? normalizeAnalysisWindow(cur.window) : undefined) as AnalysisWindow | undefined;
    if (isUngroundedWholeSession(win, text, isContextual)) win = undefined;

    const textWindow = newWindowFromText(text);
    if (win) {
      resolved.push({ kind, window: win } as AnalysisRequest);
    } else if (textWindow) {
      resolved.push({ kind, window: textWindow } as AnalysisRequest);
    } else if (inheritedWindow) {
      resolved.push({ kind, window: inheritedWindow } as AnalysisRequest);
    } else if (isContextual) {
      return { ok: false, error: "I need to know which time window you'd like." };
    } else {
      resolved.push({ kind, window: defaultAnalysisWindow() } as AnalysisRequest);
    }
  }
  return { ok: true, requests: resolved };
}

export interface ResolveAnalysisInheritanceOptions {
  text: string;
  /** True when any prior successful action exists in the execution log. */
  hasPriorAction: boolean;
}

function isUngroundedWholeSession(win: AnalysisWindow | undefined, text: string, isContextual: boolean): boolean {
  if (win?.kind !== 'whole_session') return false;
  // whole_session is grounded when the user explicitly asks for it.
  if (textRequestsWholeSession(text)) return false;
  // In a contextual short follow-up, an unrequested whole_session is a
  // model-invented default and must not bypass missing-context clarification.
  if (isContextual) return true;
  // For a non-contextual new analysis (e.g. "How did AAPL do today?"),
  // whole_session is the legitimate default.
  return false;
}

function isWindowExplicitlyGrounded(win: AnalysisWindow | undefined, text: string): boolean {
  if (!win) return false;
  if (win.kind === 'time_range' || win.kind === 'up_to_cursor') return true;
  // whole_session is only explicit when the user asked for the whole session.
  if (win.kind === 'whole_session' && textRequestsWholeSession(text)) return true;
  return false;
}

/**
 * Resolve inherited analysis windows for short metric/comparison follow-ups.
 *
 * - Contextual short follow-ups ("what about volume?", "compare that with the
 *   last hour") without an explicit window inherit from the prior action's
 *   analysisRequests.
 * - A model-invented whole_session cannot bypass missing-context clarification
 *   when there is no prior analysis and the user did not ask for it.
 * - Explicit time ranges always win, and the inherited window is only used to
 *   fill genuinely missing dimensions.
 */
export function resolveAnalysisInheritance(
  current: AnalysisRequest[] | undefined,
  base: AnalysisRequest[] | undefined,
  opts: ResolveAnalysisInheritanceOptions
): { ok: true; requests: AnalysisRequest[] } | { ok: false; error: string } {
  if (!current || current.length === 0) return { ok: true, requests: base ?? [] };

  const isContextual = textRequestsContextReference(opts.text, opts.hasPriorAction) && !textRequestsSummary(opts.text);

  const lastBase = base && base.length > 0 ? base[base.length - 1] : undefined;
  const baseWindow = lastBase ? analysisRequestWindow(lastBase) : undefined;

  const sessionOpen = formatTime(US_EQUITY_MARKET_OPEN);
  const sessionClose = formatTime(US_EQUITY_MARKET_CLOSE);

  const resolved: AnalysisRequest[] = [];
  for (let i = 0; i < current.length; i++) {
    const cur = current[i];
    const baseReq = base && i < base.length ? base[i] : lastBase;
    const inheritedWindow = baseReq ? analysisRequestWindow(baseReq) : baseWindow;

    if (cur.kind === 'candle_shape') {
      const other = resolved.concat(current.slice(i + 1));
      const shape = resolveCandleShape(cur, resolved, other, opts.text);
      if ('error' in shape) return { ok: false, error: shape.error };
      resolved.push({
        kind: 'candle_shape',
        ...shape,
      } as AnalysisRequest);
      continue;
    }

    if (cur.kind === 'window_compare') {
      let left = (cur.left ? normalizeAnalysisWindow(cur.left) : undefined) as AnalysisWindow | undefined;
      let right = (cur.right ? normalizeAnalysisWindow(cur.right) : undefined) as AnalysisWindow | undefined;

      if (isUngroundedWholeSession(left, opts.text, isContextual)) left = undefined;
      if (isUngroundedWholeSession(right, opts.text, isContextual)) right = undefined;

      if (baseReq || inheritedWindow) {
        const baseCompareLeft = baseReq?.kind === 'window_compare' ? baseReq.left : inheritedWindow;
        const baseCompareRight = baseReq?.kind === 'window_compare' ? baseReq.right : inheritedWindow;
        const textWindow = newWindowFromText(opts.text);

        if (!left && !right) {
          // Copy the entire comparison when both sides are missing.
          if (baseReq?.kind === 'window_compare' && baseReq.left && baseReq.right) {
            left = baseReq.left;
            right = baseReq.right;
          } else if (textWindow) {
            // A text-derived window pairs with the inherited window for "compare that with the last hour".
            left = inheritedWindow ?? textWindow;
            right = textWindow;
          } else {
            left = inheritedWindow ?? defaultAnalysisWindow();
            right = inheritedWindow ?? defaultAnalysisWindow();
          }
        } else {
          if (!left) left = baseCompareLeft ?? right ?? textWindow ?? defaultAnalysisWindow();
          if (!right) right = baseCompareRight ?? left ?? textWindow ?? defaultAnalysisWindow();
        }

        const compare = resolveComparisonWindows(left, right, inheritedWindow, sessionOpen, sessionClose, opts.text);
        if (compare) {
          left = compare.left;
          right = compare.right;
        }
      } else {
        if (!left || !right) {
          return { ok: false, error: 'Please specify both windows to compare.' };
        }
      }

      if (!left || !right) {
        return { ok: false, error: 'Could not resolve the comparison windows.' };
      }

      resolved.push({ kind: 'window_compare', left, right });
      continue;
    }

    // Non-compare windowed analysis.
    const win = (cur.window ? normalizeAnalysisWindow(cur.window) : undefined) as AnalysisWindow | undefined;

    if (isWindowExplicitlyGrounded(win, opts.text)) {
      resolved.push({ kind: cur.kind, window: win } as AnalysisRequest);
      continue;
    }

    // An explicit text-derived window (e.g. "from 10 to noon" or "first hour")
    // overrides an ungrounded or missing model window and any inherited default.
    const textWindow = newWindowFromText(opts.text);
    if (textWindow) {
      resolved.push({ kind: cur.kind, window: textWindow } as AnalysisRequest);
      continue;
    }

    const inherited = inheritedWindow;
    if (inherited) {
      resolved.push({ kind: cur.kind, window: inherited } as AnalysisRequest);
      continue;
    }

    if (isContextual) {
      return { ok: false, error: "I need to know which time window you'd like." };
    }

    resolved.push({ kind: cur.kind, window: defaultAnalysisWindow() } as AnalysisRequest);
  }

  // A compound request that explicitly asks for a move/change but the model
  // emitted a summary or OHLC analysis should be treated as the change the
  // user asked for, so the response includes the requested change/metric.
  const t = opts.text.toLowerCase();
  const asksForMove = /\b(move|change|movement)\b/.test(t) && !/\bsummary\b/.test(t);
  if (asksForMove && !resolved.some((r) => r.kind === 'window_change')) {
    const idx = resolved.findIndex((r) => r.kind === 'window_summary' || r.kind === 'window_ohlc');
    if (idx >= 0) {
      resolved[idx] = { ...resolved[idx], kind: 'window_change' } as AnalysisRequest;
    }
  }

  return { ok: true, requests: resolved };
}

function isMutating(capability: string): boolean {
  return getCapability(capability)?.kind === 'mutate';
}

function serialiseCompareSide(side: ResolvedCompareSide): Record<string, unknown> {
  if (side.source === 'chart') {
    return { source: 'chart' };
  }
  return {
    source: 'snapshot',
    snapshotId: side.snapshotId,
    symbol: side.symbol,
    date: side.date,
    timeframe: side.timeframe,
    timestamp: side.timestamp,
    marketTime: side.marketTime,
  };
}

function planKind(steps: AgentStep[]): AgentPlan['kind'] {
  const anyMutate = steps.some((s) => isMutating(s.capability));
  const anyRead = steps.some((s) => !isMutating(s.capability));
  if (anyMutate && anyRead) return 'mixed';
  if (anyMutate) return 'action';
  return 'query';
}

function argRef(stepId: string, path?: string): Record<string, unknown> {
  return { $ref: stepId, ...(path ? { path } : {}) };
}

function resolveOneSide(
  side: CompareSide,
  log: AgentContext['executionLog'],
  state: ReturnType<AgentContext['getState']>
): { ok: true; side: ResolvedCompareSide } | { ok: false; error: string } {
  if (side.source === 'current_chart_candle') {
    return { ok: true, side: { source: 'chart' } };
  }

  if (side.source === 'latest_returned_candle') {
    const c = log.latestReturnedCandle();
    if (!c) return { ok: false, error: 'No latest returned candle found.' };
    return { ok: true, side: c };
  }

  if (side.source === 'previous_returned_candle') {
    const c = log.previousReturnedCandle();
    if (!c) return { ok: false, error: 'No previous returned candle found.' };
    return { ok: true, side: c };
  }

  if (side.source === 'market_time') {
    if (!side.marketTime) return { ok: false, error: 'market_time side requires a marketTime value.' };
    const c =
      log.findCandleByMarketTime({
        symbol: state.symbol,
        date: state.replayDate,
        timeframe: state.timeframe,
        marketTime: side.marketTime,
      }) ?? log.findCandleByMarketTime({ marketTime: side.marketTime });
    if (!c) return { ok: false, error: `No reported candle found at ${side.marketTime}.` };
    return { ok: true, side: c };
  }

  return { ok: false, error: `Unknown compare side source "${(side as any).source}".` };
}

export function resolveCompareOperands(
  intent: ChartActionIntent,
  ctx: AgentContext
): { ok: true; resolved: ResolvedCompare } | { ok: false; error: string } {
  const log = ctx.executionLog;
  const state = ctx.getState();

  let sides = intent.compare;

  // Fallback for older model outputs that still use contextReference for A/B compare phrasing.
  if (!sides && intent.finalQuery === 'compare_candles' && intent.contextReference?.source === 'latest_returned_candle' && intent.contextReference.mode === 'use_as_target') {
    sides = {
      left: { source: 'latest_returned_candle' },
      right: { source: 'previous_returned_candle' },
    };
  }

  if (!sides) {
    return { ok: false, error: 'compare_candles requires a compare object with left and right sides.' };
  }

  const left = resolveOneSide(sides.left, log, state);
  if (!left.ok) return { ok: false, error: left.error };

  const right = resolveOneSide(sides.right, log, state);
  if (!right.ok) return { ok: false, error: right.error };

  return { ok: true, resolved: { left: left.side, right: right.side } };
}

function textAuthorizesReturnedCandleComparison(text: string): boolean {
  const t = text.toLowerCase();
  const hasPreviousReference = /\b(previous|prior|earlier|last|reported|said|told|gave|mentioned|discussed)\b/.test(t);
  const hasExplicitCurrentChart = /\b(current\s+chart|live\s+chart|chart\s+candle|live\s+candle|now)\b/.test(t);
  return hasPreviousReference && !hasExplicitCurrentChart;
}

function repairCompareCandleSources(
  intent: ChartActionIntent,
  ctx: AgentContext,
  text: string
): ChartActionIntent {
  if (intent.finalQuery !== 'compare_candles' || !intent.compare) return intent;

  const log = ctx.executionLog;
  const latest = log.latestReturnedCandle();
  const previous = log.previousReturnedCandle();
  if (!latest || !previous) return intent;

  if (!textAuthorizesReturnedCandleComparison(text)) return intent;

  const sides = intent.compare;
  const left = sides.left;
  const right = sides.right;
  const t = text.toLowerCase();
  const hasPreviousRef = /\b(previous|prior|earlier|last|reported|said|told|gave|mentioned|discussed)\b/.test(t);
  const rightShouldBePrevious = right.source === 'current_chart_candle' && hasPreviousRef;
  const leftShouldBeLatest =
    left.source === 'current_chart_candle' &&
    (right.source === 'previous_returned_candle' || rightShouldBePrevious || /\b(this|that|the)\s+(candle|bar|one)\b/.test(t));

  const newSides: CompareSides = { ...sides };

  if (leftShouldBeLatest) {
    newSides.left = { source: 'latest_returned_candle' };
  }
  if (rightShouldBePrevious) {
    newSides.right = { source: 'previous_returned_candle' };
  }
  // If the model duplicated the same side, normalize distinct snapshot references.
  if (newSides.left.source === 'latest_returned_candle' && newSides.right.source === 'latest_returned_candle' && hasPreviousRef) {
    newSides.right = { source: 'previous_returned_candle' };
  }
  if (newSides.left.source === 'current_chart_candle' && newSides.right.source === 'previous_returned_candle') {
    newSides.left = { source: 'latest_returned_candle' };
  }

  return { ...intent, compare: newSides };
}

export function resolveContextReference(
  intent: ChartActionIntent,
  ctx: AgentContext,
  requestText: string = ''
): ContextResolutionResult {
  // Candle comparisons resolve both explicit sides before compilation.
  if (intent.finalQuery === 'compare_candles') {
    const repaired = repairCompareCandleSources(intent, ctx, requestText);
    const resolved = resolveCompareOperands(repaired, ctx);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return { ok: true, intent: repaired, resolvedCompare: resolved.resolved };
  }

  const ref = intent.contextReference;
  if (!ref) {
    return { ok: true, intent };
  }

  const log = ctx.executionLog;
  const state = ctx.getState();

  // -- locate source
  let sourceEntry: ExecutionContextEntry | undefined;
  if (ref.source === 'latest_successful_action') {
    sourceEntry = log.latestSuccessfulAction();
  } else if (ref.source === 'latest_failed_action') {
    return { ok: false, error: 'Failed actions cannot be repeated.' };
  } else if (ref.source === 'latest_returned_candle') {
    // no specific action entry needed; candle lookup follows
    sourceEntry = undefined;
  } else {
    return { ok: false, error: `Unknown contextReference source "${ref.source}".` };
  }

  if (ref.source === 'latest_returned_candle') {
    const latest = log.latestReturnedCandle();
    if (!latest) {
      return { ok: false, error: 'No previous candle was reported.' };
    }

    const current = log.latestMatchingCandle({
      symbol: state.symbol,
      date: state.replayDate,
      timeframe: state.timeframe,
    }) ?? latest;

    const merged: ChartActionIntent = { ...intent };

    if (ref.mode === 'use_as_target') {
      // "Go back to the candle": if the candle is in the current session,
      // only seek; otherwise switch to its symbol/date/timeframe first.
      const sameSession =
        current.symbol === state.symbol &&
        current.date === state.replayDate &&
        current.timeframe === state.timeframe;

      if (sameSession) {
        merged.seekTime = merged.seekTime ?? current.marketTime;
        if (merged.timeframeMinutes === undefined && current.timeframe !== state.timeframe) {
          merged.timeframeMinutes = current.timeframe;
        }
      } else {
        merged.symbol = merged.symbol ?? current.symbol;
        merged.date = merged.date ?? { kind: 'absolute', value: current.date };
        merged.timeframeMinutes = merged.timeframeMinutes ?? current.timeframe;
        merged.seekTime = merged.seekTime ?? current.marketTime;
      }
    } else if (ref.mode === 'anchor_relative_date') {
      return { ok: true, intent: merged, anchorDate: current.date };
    } else if (ref.mode === 'inherit' && ref.inherit?.includes('date')) {
      merged.date = merged.date ?? { kind: 'absolute', value: current.date };
    } else {
      return { ok: false, error: `Mode "${ref.mode}" is not valid with latest_returned_candle.` };
    }

    // Resolved reference: remove contextReference from the concrete template.
    delete merged.contextReference;
    return { ok: true, intent: merged, resolvedCandle: current };
  }

  // -- latest_successful_action sources
  if (!sourceEntry || !sourceEntry.template) {
    return { ok: false, error: 'No prior successful action to reference.' };
  }
  if (sourceEntry.ok !== true) {
    return { ok: false, error: 'The referenced action failed and cannot be reused.' };
  }

  const source = sourceEntry.template;
  const after = sourceEntry.after;
  const merged: ChartActionIntent = { ...intent };

  // User-facing "timeframe" maps to the ChartActionIntent key "timeframeMinutes".
  const INHERIT_FIELD_MAP: Record<InheritableField, keyof ChartActionIntent> = {
    date: 'date',
    timeframe: 'timeframeMinutes',
    seekTime: 'seekTime',
    relativeSeekMinutes: 'relativeSeekMinutes',
    playback: 'playback',
    finalQuery: 'finalQuery',
    analysisRequests: 'analysisRequests',
  };

  function mergeField<K extends keyof ChartActionIntent>(key: K): void {
    if (merged[key] === undefined && source[key] !== undefined) {
      // copy by value for simple fields; objects are small and safe to copy
      merged[key] = JSON.parse(JSON.stringify(source[key]));
    }
  }

  if (ref.mode === 'repeat') {
    // Copy every reusable field except contextReference itself.
    for (const key of Object.keys(source) as (keyof ChartActionIntent)[]) {
      if (key === 'contextReference') continue;
      mergeField(key);
    }

    // Playback is a multi-field object; a repeat like "Do that again on NVDA" may
    // have only the action in the new utterance, but it must still inherit speed,
    // untilTime and direction from the prior action when those are not re-specified.
    const targetPb = merged.playback;
    const sourcePb = source.playback;
    if (targetPb && sourcePb) {
      if (targetPb.action === undefined) targetPb.action = sourcePb.action;
      if (targetPb.speed === undefined) targetPb.speed = sourcePb.speed;
      if (targetPb.untilTime === undefined) targetPb.untilTime = sourcePb.untilTime;
      if (targetPb.direction === undefined) targetPb.direction = sourcePb.direction;
    }

    // The source template may have had dimensions stripped by the sanitizer (e.g.
    // the date on a bare "Play from here..." command). Fall back to the verified
    // after-state for any fields the new request did not re-specify.
    if (merged.date === undefined && after?.date) {
      merged.date = { kind: 'absolute', value: after.date };
    }
    if (merged.timeframeMinutes === undefined && after?.timeframe !== undefined) {
      merged.timeframeMinutes = after.timeframe;
    }
  } else if (ref.mode === 'inherit') {
    if (!ref.inherit || ref.inherit.length === 0) {
      return { ok: false, error: 'inherit mode requires an inherit list.' };
    }
    for (const field of ref.inherit) {
      const targetKey = INHERIT_FIELD_MAP[field];
      if (field === 'date') {
        if (merged.date === undefined) {
          // "same date as before" means the resolved date of the source action.
          if (after?.date) {
            merged.date = { kind: 'absolute', value: after.date };
          } else if (source.date) {
            merged.date = JSON.parse(JSON.stringify(source.date));
          }
        }
      } else {
        mergeField(targetKey);
      }
    }
  } else if (ref.mode === 'anchor_relative_date') {
    // The caller must provide a relative date; the anchor is the source
    // action's resolved date, otherwise its template date, otherwise current.
    const anchorDate = after?.date ??
      (source.date?.kind === 'absolute' ? source.date.value : undefined) ??
      state.replayDate ??
      today();
    return { ok: true, intent: merged, anchorDate };
  } else if (ref.mode === 'use_as_target') {
    return { ok: false, error: 'use_as_target requires a latest_returned_candle source.' };
  } else {
    return { ok: false, error: `Unknown contextReference mode "${ref.mode}".` };
  }

  // Merge any inherited analysis requests, allowing partial follow-ups
  // ("same thing but first hour", "what about volume?") to resolve against
  // the prior action's analysisRequests.
  const shouldInheritAnalysis =
    ref.mode === 'repeat' ||
    (ref.mode === 'inherit' && ref.inherit?.includes('analysisRequests'));
  if (shouldInheritAnalysis && merged.analysisRequests) {
    const isContextual = textRequestsContextReference(requestText, ctx.executionLog.latestSuccessfulAction() !== undefined);
    const mergedAnalysis = mergeAnalysisRequests(source.analysisRequests, merged.analysisRequests, requestText, isContextual);
    if (!mergedAnalysis.ok) {
      return { ok: false, error: mergedAnalysis.error };
    }
    if (mergedAnalysis.requests.length > 0) {
      merged.analysisRequests = mergedAnalysis.requests;
    } else if (merged.analysisRequests && merged.analysisRequests.length === 0) {
      delete merged.analysisRequests;
    }
  }

  // After resolution the contextReference is consumed and must not be stored.
  delete merged.contextReference;

  return { ok: true, intent: merged };
}

export function compileChartActionIntent(
  intent: ChartActionIntent,
  options: CompileOptions = {}
): AgentPlan {
  const anchorDate = options.anchorDate ?? today();
  const steps: AgentStep[] = [];
  let lastStepId: string | undefined;
  let lastMutatingStepId: string | undefined;

  // Helper to push a step and chain it onto the previous one.
  function pushStep(step: AgentStep): void {
    if (lastStepId && !step.dependsOn) {
      step.dependsOn = [lastStepId];
    }
    steps.push(step);
    lastStepId = step.id;
    if (isMutating(step.capability)) {
      lastMutatingStepId = step.id;
    }
  }

  // 1. Previous symbol (no args, relies on session history).
  if (intent.previousSymbol) {
    pushStep({
      id: 'step-previous',
      capability: 'session.switch_to_previous_symbol',
      args: {},
      required: true,
    });
  }

  // 2. Resolve symbol when present (and not previous).  An exact ticker that is
  // already in the available list can switch directly.
  let resolveSymbolId: string | undefined;
  let switchSymbolValue: string | Record<string, unknown> | undefined;
  if (intent.symbol) {
    const available = (options.availableTickers ?? []).map((t) => t.toUpperCase());
    if (available.includes(intent.symbol.toUpperCase())) {
      switchSymbolValue = intent.symbol;
    } else {
      resolveSymbolId = 'step-resolve-symbol';
      pushStep({
        id: resolveSymbolId,
        capability: 'session.resolve_symbol',
        args: { name: intent.symbol },
        required: true,
      });
      switchSymbolValue = argRef(resolveSymbolId, 'symbol');
    }
  }

  const willChangeSymbol =
    switchSymbolValue !== undefined &&
    (typeof switchSymbolValue !== 'string' || switchSymbolValue !== options.stateSymbol);

  // 3. Resolve trading date when present, unless the date is an explicit
  // absolute date that matches the active session *and* the target symbol.
  let resolveDateId: string | undefined;
  if (intent.date) {
    if (intent.previousSymbol) {
      throw new Error('compileChartActionIntent: date cannot be combined with previousSymbol.');
    }
    if (!switchSymbolValue && !options.stateSymbol) {
      throw new Error('compileChartActionIntent: date requires a symbol.');
    }
    let symbolForDate = switchSymbolValue ?? options.stateSymbol;
    const isKnownDate =
      intent.date.kind === 'absolute' &&
      intent.date.value === options.stateDate &&
      !willChangeSymbol;

    // A date-only request with no new symbol should switch the active symbol
    // to the resolved date, so long as an active symbol exists.
    if (!switchSymbolValue && options.stateSymbol) {
      switchSymbolValue = options.stateSymbol;
      symbolForDate = switchSymbolValue;
    }

    if (!isKnownDate) {
      resolveDateId = 'step-resolve-date';
      const dateStep: AgentStep = {
        id: resolveDateId,
        capability: 'session.resolve_trading_date',
        args: {
          symbol: symbolForDate,
          input:
            intent.date.kind === 'absolute'
              ? { kind: 'explicit', date: intent.date.value }
              : intent.date.kind === 'relative_calendar'
                ? {
                    kind: 'relative_calendar',
                    days: intent.date.count ?? 1,
                    direction: intent.date.direction ?? 'backward',
                    from: anchorDate,
                  }
                : {
                    kind: 'relative_trading',
                    sessions: intent.date.count ?? 1,
                    direction: intent.date.direction ?? 'backward',
                    from: anchorDate,
                  },
        },
        required: true,
        ...(resolveSymbolId ? { dependsOn: [resolveSymbolId] } : {}),
      };
      steps.push(dateStep);
      lastStepId = resolveDateId;
    }

    // 4. Switch symbol using the symbol and the explicit date (when known, the
    // value is passed directly to avoid a redundant resolve step).
    // Skip only a fully redundant switch to the same symbol and same date.
    const isRedundantDateSwitch =
      isKnownDate &&
      typeof switchSymbolValue === 'string' &&
      switchSymbolValue === options.stateSymbol;

    if (switchSymbolValue && !isRedundantDateSwitch) {
      const switchArgs: Record<string, unknown> = { symbol: switchSymbolValue };
      if (intent.date.kind === 'absolute' && intent.date.value) {
        switchArgs.date = intent.date.value;
      } else if (resolveDateId) {
        switchArgs.date = argRef(resolveDateId, 'date');
      }
      pushStep({
        id: 'step-switch',
        capability: 'session.switch_symbol',
        args: switchArgs,
        required: true,
        dependsOn: resolveDateId ? [resolveDateId] : resolveSymbolId ? [resolveSymbolId] : undefined,
      });
    } else if (resolveSymbolId) {
      // A resolved symbol but no date still needs a switch.
      pushStep({
        id: 'step-switch',
        capability: 'session.switch_symbol',
        args: { symbol: argRef(resolveSymbolId, 'symbol') },
        required: true,
        dependsOn: [resolveSymbolId],
      });
    }
  } else if (switchSymbolValue) {
    // 4a. Switch to an already-known symbol with no date.
    pushStep({
      id: 'step-switch',
      capability: 'session.switch_symbol',
      args: { symbol: switchSymbolValue },
      required: true,
    });
  } else if (resolveSymbolId) {
    // 4b. Switch to the resolved symbol with no date.
    pushStep({
      id: 'step-switch',
      capability: 'session.switch_symbol',
      args: { symbol: argRef(resolveSymbolId, 'symbol') },
      required: true,
      dependsOn: [resolveSymbolId],
    });
  }

  // 5. Set timeframe when it changes, when this is a pure timeframe request
  // (e.g. "Use the same timeframe."), when the session date actually changes
  // (a new session needs its timeframe represented), or when the plan will
  // reconstruct chart state for a candle query, seek or playback. A symbol
  // change alone (e.g. an analysis-only "do that analysis on NVDA") does not
  // emit a redundant same-value set_timeframe.
  const hasNonTimeframeWork =
    intent.previousSymbol ||
    intent.symbol ||
    intent.date ||
    (intent.analysisRequests && intent.analysisRequests.length > 0) ||
    intent.finalQuery ||
    intent.seekTime !== undefined ||
    intent.relativeSeekMinutes !== undefined ||
    intent.playback;

  const dateChanges =
    intent.date !== undefined &&
    (intent.date.kind !== 'absolute' || intent.date.value !== options.stateDate);

  const sessionTransition =
    willChangeSymbol || intent.previousSymbol || dateChanges;

  const requiresChartState =
    intent.finalQuery !== undefined ||
    intent.seekTime !== undefined ||
    intent.relativeSeekMinutes !== undefined ||
    intent.playback !== undefined;

  const shouldSetTimeframe =
    intent.timeframeMinutes !== undefined &&
    (intent.timeframeMinutes !== options.stateTimeframe ||
      !hasNonTimeframeWork ||
      dateChanges ||
      (sessionTransition && requiresChartState));
  if (shouldSetTimeframe) {
    pushStep({
      id: 'step-timeframe',
      capability: 'chart.set_timeframe',
      args: { timeframe: intent.timeframeMinutes },
      required: true,
    });
  }

  // 6a. Relative seek.
  if (intent.relativeSeekMinutes !== undefined) {
    pushStep({
      id: 'step-seek-relative',
      capability: 'playback.seek_relative',
      args: { minutes: intent.relativeSeekMinutes },
      required: true,
    });
  }

  // 6b. Seek to an absolute time.
  if (intent.seekTime !== undefined) {
    pushStep({
      id: 'step-seek-time',
      capability: 'playback.seek_to_time',
      args: { time: intent.seekTime },
      required: true,
    });
  }

  // 7. Playback control.
  if (intent.playback) {
    pushStep(compilePlaybackStep(intent.playback));
  }

  // 8. Final query.
  if (intent.finalQuery === 'current_candle') {
    pushStep({
      id: 'step-current-candle',
      capability: 'chart.get_current_candle',
      args: {},
      required: false,
    });
  } else if (intent.finalQuery === 'candle_at_time') {
    pushStep({
      id: 'step-candle-at-time',
      capability: 'chart.get_candle_at_time',
      args: { time: intent.queryTime! },
      required: false,
    });
  } else if (intent.finalQuery === 'compare_candles') {
    const rc = options.resolvedCompare;
    if (!rc) {
      throw new Error('compileChartActionIntent: compare_candles requires resolvedCompare.');
    }
    pushStep({
      id: 'step-compare-candles',
      capability: 'analysis.compare_candles',
      args: {
        left: serialiseCompareSide(rc.left),
        right: serialiseCompareSide(rc.right),
      },
      required: false,
    });
  }

  // 9. Deterministic chart analysis requests.
  // Each analysis is optional (required:false) and independent of other
  // analyses.  If a mutating setup step (symbol, date, timeframe, seek,
  // playback) has already been emitted, all analyses depend on that last
  // mutating step so a failed setup prevents them from running.  Otherwise,
  // in an analysis-only plan, they run without explicit dependencies.
  if (intent.analysisRequests && intent.analysisRequests.length > 0) {
    const seen = new Set<string>();
    let emitted = 0;
    for (const request of intent.analysisRequests) {
      const key = canonicalRequestKey(request);
      if (seen.has(key)) continue;
      seen.add(key);
      const step = compileAnalysisStep(emitted, request);
      step.dependsOn = lastMutatingStepId ? [lastMutatingStepId] : [];
      pushStep(step);
      emitted++;
    }
  }

  // Compact summary.
  const fragments: string[] = [];
  if (intent.previousSymbol) fragments.push('previous symbol');
  if (intent.symbol) fragments.push(intent.symbol);
  if (intent.date?.kind === 'relative_trading') fragments.push(`${intent.date.count} session(s) ${intent.date.direction}`);
  if (intent.date?.kind === 'absolute') fragments.push(intent.date.value!);
  if (intent.timeframeMinutes) fragments.push(`${intent.timeframeMinutes}m`);
  if (intent.seekTime) fragments.push(`@${intent.seekTime}`);
  if (intent.relativeSeekMinutes !== undefined) fragments.push(`${intent.relativeSeekMinutes}m relative`);
  if (intent.playback) fragments.push(intent.playback.action);
  if (intent.finalQuery) fragments.push(intent.finalQuery);
  if (intent.analysisRequests) {
    fragments.push(`analysis x${intent.analysisRequests.length}`);
  }
  const summary = fragments.length > 0 ? fragments.join(' · ') : 'Chart action';

  return {
    id: `plan-intent-${Date.now()}`,
    kind: planKind(steps),
    summary,
    steps,
    meta: { planner: 'compact-intent' },
  };
}

function sortKeys<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys) as unknown as T;
  const keys = Object.keys(value).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return out as T;
}

function canonicalRequestKey(request: AnalysisRequest): string {
  if (request.kind === 'window_compare') {
    return JSON.stringify(sortKeys({ kind: request.kind, left: request.left, right: request.right }));
  }
  if (request.kind === 'candle_shape') {
    return JSON.stringify(sortKeys({ kind: request.kind, source: request.source, marketTime: request.marketTime }));
  }
  return JSON.stringify(sortKeys({ kind: request.kind, window: (request as { window: AnalysisWindow }).window }));
}

function compileAnalysisStep(index: number, request: AnalysisRequest): AgentStep {
  switch (request.kind) {
    case 'window_ohlc':
    case 'window_change':
    case 'window_volume':
    case 'window_summary':
      return {
        id: `step-analysis-${index + 1}`,
        capability: `analysis.${request.kind}`,
        args: { window: request.window ?? defaultAnalysisWindow() },
        required: false,
      };
    case 'window_compare':
      return {
        id: `step-analysis-${index + 1}`,
        capability: 'analysis.window_compare',
        args: {
          left: request.left ?? defaultAnalysisWindow(),
          right: request.right ?? defaultAnalysisWindow(),
        },
        required: false,
      };
    case 'candle_shape':
      return {
        id: `step-analysis-${index + 1}`,
        capability: 'analysis.candle_shape',
        args: { source: request.source, ...(request.marketTime ? { marketTime: request.marketTime } : {}) },
        required: false,
      };
  }
}

function compilePlaybackStep(playback: SemanticPlayback): AgentStep {
  if (playback.action === 'pause') {
    return {
      id: 'step-pause',
      capability: 'playback.pause',
      args: {},
      required: true,
    };
  }

  const args: Record<string, unknown> = {};
  if (playback.speed !== undefined) args.speed = playback.speed;
  if (playback.untilTime !== undefined) {
    args.untilTime = playback.untilTime;
  }
  if (playback.direction !== undefined) {
    args.direction = playback.direction;
  }
  return {
    id: playback.action === 'play_until' ? 'step-play-until' : 'step-play',
    capability: 'playback.play_until',
    args,
    required: true,
  };
}
