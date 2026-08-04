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
  ExecutionContextEntry, InheritableField, CompareSide, ResolvedCompare,
  ResolvedCompareSide, AnalysisRequest, AnalysisWindow,
} from './types';
import type { AgentContext } from './types';
import { getCapability } from './capabilities';

export interface CompileOptions {
  /** Anchor for relative_trading dates (YYYY-MM-DD). Defaults to today. */
  anchorDate?: string;
  /** Resolved candle for "go back to the candle" or fallback. */
  resolvedCandle?: CandleSnapshot;
  /** Resolved comparison sides for "compare_candles". */
  resolvedCompare?: ResolvedCompare;
  /** Current session symbol, used as a fallback when a date is supplied with no symbol. */
  stateSymbol?: string;
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

function mergeAnalysisRequests(
  base: AnalysisRequest[] | undefined,
  current: AnalysisRequest[] | undefined
): { ok: true; requests: AnalysisRequest[] } | { ok: false; error: string } {
  if (!current) return { ok: true, requests: base ?? [] };
  if (!base) {
    // No previous analysis to inherit from; current must be complete.
    for (let i = 0; i < current.length; i++) {
      const r = current[i];
      if (r.kind === 'candle_shape') continue; // source is required, no window needed
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

  const resolved: AnalysisRequest[] = [];
  for (let i = 0; i < current.length; i++) {
    const cur = current[i];
    const baseReq = i < base.length ? base[i] : lastBase;
    const inheritedWindow = baseReq ? analysisRequestWindow(baseReq) : baseWindow;

    if (cur.kind === 'window_compare') {
      const left = cur.left ??
        (baseReq?.kind === 'window_compare' ? baseReq.left : inheritedWindow) ??
        defaultAnalysisWindow();
      const right = cur.right ??
        (baseReq?.kind === 'window_compare' ? baseReq.right : inheritedWindow) ??
        defaultAnalysisWindow();
      resolved.push({ kind: 'window_compare', left, right });
      continue;
    }

    if (cur.kind === 'candle_shape') {
      resolved.push({
        kind: 'candle_shape',
        source: cur.source,
        marketTime: cur.marketTime,
      });
      continue;
    }

    const kind = cur.kind;
    if (!kind) return { ok: false, error: `analysisRequests[${i}] has no kind and cannot be resolved.` };
    const window = cur.window ?? inheritedWindow ?? defaultAnalysisWindow();
    resolved.push({ kind, window } as AnalysisRequest);
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

export function resolveContextReference(
  intent: ChartActionIntent,
  ctx: AgentContext
): ContextResolutionResult {
  // Candle comparisons resolve both explicit sides before compilation.
  if (intent.finalQuery === 'compare_candles') {
    const resolved = resolveCompareOperands(intent, ctx);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return { ok: true, intent, resolvedCompare: resolved.resolved };
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
    const mergedAnalysis = mergeAnalysisRequests(source.analysisRequests, merged.analysisRequests);
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

  // 2. Resolve symbol when present (and not previous).
  let resolveSymbolId: string | undefined;
  if (intent.symbol) {
    resolveSymbolId = 'step-resolve-symbol';
    pushStep({
      id: resolveSymbolId,
      capability: 'session.resolve_symbol',
      args: { name: intent.symbol },
      required: true,
    });
  }

  // 3. Resolve trading date when present.
  if (intent.date) {
    if (intent.previousSymbol) {
      throw new Error('compileChartActionIntent: date cannot be combined with previousSymbol.');
    }
    if (!resolveSymbolId) {
      if (!options.stateSymbol) {
        throw new Error('compileChartActionIntent: date requires a symbol.');
      }
      resolveSymbolId = 'step-resolve-symbol';
      pushStep({
        id: resolveSymbolId,
        capability: 'session.resolve_symbol',
        args: { name: options.stateSymbol },
        required: true,
      });
    }
    const resolveDateId = 'step-resolve-date';
    const dateStep: AgentStep = {
      id: resolveDateId,
      capability: 'session.resolve_trading_date',
      args: {
        symbol: argRef(resolveSymbolId, 'symbol'),
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
      dependsOn: [resolveSymbolId],
    };
    steps.push(dateStep);
    lastStepId = resolveDateId;

    // 4. Switch symbol using resolved symbol and date.
    pushStep({
      id: 'step-switch',
      capability: 'session.switch_symbol',
      args: {
        symbol: argRef(resolveSymbolId, 'symbol'),
        date: argRef(resolveDateId, 'date'),
      },
      required: true,
      dependsOn: [resolveDateId],
    });
  } else if (resolveSymbolId) {
    // 4a. Switch to the resolved symbol with no date.
    pushStep({
      id: 'step-switch',
      capability: 'session.switch_symbol',
      args: { symbol: argRef(resolveSymbolId, 'symbol') },
      required: true,
      dependsOn: [resolveSymbolId],
    });
  }

  // 5. Set timeframe.
  if (intent.timeframeMinutes !== undefined) {
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
  if (intent.analysisRequests && intent.analysisRequests.length > 0) {
    const seen = new Set<string>();
    let emitted = 0;
    for (const request of intent.analysisRequests) {
      const key = canonicalRequestKey(request);
      if (seen.has(key)) continue;
      seen.add(key);
      const step = compileAnalysisStep(emitted, request);
      if (lastMutatingStepId && !step.dependsOn) {
        step.dependsOn = [lastMutatingStepId];
      }
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

function canonicalRequestKey(request: AnalysisRequest): string {
  if (request.kind === 'window_compare') {
    return JSON.stringify({ kind: request.kind, left: request.left, right: request.right });
  }
  if (request.kind === 'candle_shape') {
    return JSON.stringify({ kind: request.kind, source: request.source, marketTime: request.marketTime });
  }
  return JSON.stringify({ kind: request.kind, window: (request as { window: AnalysisWindow }).window });
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
