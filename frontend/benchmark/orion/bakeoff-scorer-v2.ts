import type {
  ChartActionIntent,
  AgentPlan,
  AgentStep,
  SemanticDate,
  SemanticPlayback,
  AnalysisRequest,
} from '../../src/lib/orion/agent/types';
import type { RepetitionResult } from './types';
import { getPromptByIdV2, ALL_PROMPTS_V2, tickers } from './bakeoff-suite-v2';
import type {
  V2BakeoffPrompt,
  V2RepetitionResult,
  V2RepetitionScore,
  V2ScoreDiagnostics,
  V2PromptScore,
  V2ModelScorecard,
  V2Report,
  V2BakeoffOptions,
} from './bakeoff-types-v2';

// =============================================================================
// Shared V2 certification policy
//
// This object is the single source of truth for thresholds and gates. It is
// exported so the policy document and any tooling can quote the same values.
// =============================================================================

export const V2_CERTIFICATION_POLICY = {
  contractVersion: 'v2.1.0-semantic',
  primaryRepetitionPassRate: 0.9,
  primaryPromptPassRate: 0.9,
  safetyExecutionRate: 1.0,
  safetyClassificationAccuracy: 1.0,
  preconditionPassRate: 1.0,
  deterministicPassRate: 1.0,
  criticalContextPromptPassRate: 1.0,
  hardcodingAuditPassed: true,
  contextRegressionPassed: true,
  analysisAcceptancePassed: true,
  runtimeAcceptancePassed: true,
} as const;

// =============================================================================
// V2 semantic oracle
//
// Compares the production pipeline output (or deterministic planner output)
// against the resolved V2 semantic gold. Pass/fail is driven by:
//   1. Intent kind and classification match.
//   2. Capability-set equivalence to the canonical or an acceptable-alternative
//      set, with no forbidden capabilities.
//   3. Field-level semantic equality (symbol, date, timeframe, seek, market
//      time, playback, analysis, context reference resolution).
// =============================================================================

function normalizeSemanticDate(d: SemanticDate | undefined): SemanticDate | undefined {
  if (!d) return undefined;
  if (d.kind === 'absolute') return d;
  return {
    ...d,
    count: d.count ?? 1,
    direction: d.direction ?? 'backward',
  };
}

function normalizePlayback(p: SemanticPlayback | undefined): SemanticPlayback | undefined {
  if (!p) return undefined;
  if (p.action === 'play' || p.action === 'play_until') {
    return { ...p, direction: p.direction ?? 'forward' };
  }
  return p;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        (out as Record<string, unknown>)[k] = v.map((x) =>
          x !== null && typeof x === 'object' ? stripUndefined(x) : x
        );
      } else {
        (out as Record<string, unknown>)[k] = stripUndefined(v as Record<string, unknown>);
      }
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  const sa = stripUndefined(a as Record<string, unknown> | undefined ?? {});
  const sb = stripUndefined(b as Record<string, unknown> | undefined ?? {});
  return JSON.stringify(sortKeys(sa)) === JSON.stringify(sortKeys(sb));
}

function sortKeys<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    out[k] = v !== null && typeof v === 'object' ? sortKeys(v as Record<string, unknown>) : v;
  }
  return out as T;
}

function caseInsensitiveEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.toUpperCase() === b.toUpperCase();
}

function sortedDedup(arr: string[]): string[] {
  return Array.from(new Set(arr)).sort();
}

function setEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function isArgRef(value: unknown): value is { $ref: string; path?: string } {
  return typeof value === 'object' && value !== null && '$ref' in value;
}

function inputToSemanticDate(input: unknown): SemanticDate | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  if (i.kind === 'explicit' && typeof i.date === 'string') {
    return { kind: 'absolute', value: i.date };
  }
  if (i.kind === 'relative_trading') {
    return {
      kind: 'relative_trading',
      count: typeof i.sessions === 'number' ? i.sessions : 1,
      direction: (i.direction as 'backward' | 'forward') ?? 'backward',
    };
  }
  if (i.kind === 'relative_calendar') {
    return {
      kind: 'relative_calendar',
      count: typeof i.days === 'number' ? i.days : 1,
      direction: (i.direction as 'backward' | 'forward') ?? 'backward',
    };
  }
  return undefined;
}

/**
 * Reverse a compiled AgentPlan into the ChartActionIntent it encodes. This lets
 * the scorer work from the production plan (e.g. from handleOrionMessage) when
 * the resolved template is not exposed. It is the inverse of the compiler/adapter
 * and contains no prompt-specific branches.
 */
export function planToChartActionIntent(plan: AgentPlan | undefined): ChartActionIntent | undefined {
  if (!plan) return undefined;

  const intent: ChartActionIntent = { kind: 'chart_action' };
  let hasChartAction = false;

  for (const step of plan.steps) {
    const cap = step.capability;
    const args = step.args as Record<string, unknown>;

    if (cap === 'session.switch_to_previous_symbol') {
      intent.previousSymbol = true;
      hasChartAction = true;
    }

    if (cap === 'session.resolve_symbol' && typeof args.name === 'string') {
      intent.symbol = args.name;
      hasChartAction = true;
    }

    if (cap === 'session.resolve_trading_date') {
      const directDate = typeof args.date === 'string' ? { kind: 'absolute', value: args.date } : undefined;
      const date = directDate ?? inputToSemanticDate(args.input);
      if (date) {
        intent.date = date;
        hasChartAction = true;
      }
      if (typeof args.symbol === 'string') {
        intent.symbol = args.symbol;
        hasChartAction = true;
      }
    }

    if (cap === 'session.switch_symbol') {
      if (typeof args.symbol === 'string') {
        intent.symbol = args.symbol;
      }
      if (typeof args.date === 'string') {
        intent.date = { kind: 'absolute', value: args.date };
      }
      hasChartAction = true;
    }

    if (cap === 'chart.set_timeframe' && typeof args.timeframe === 'number') {
      intent.timeframeMinutes = args.timeframe;
      hasChartAction = true;
    }

    if (cap === 'playback.seek_to_time' && typeof args.time === 'string') {
      intent.seekTime = args.time;
      hasChartAction = true;
    }

    if (cap === 'playback.seek_relative' && typeof args.minutes === 'number') {
      intent.relativeSeekMinutes = args.minutes;
      hasChartAction = true;
    }

    if (cap === 'playback.play_until') {
      intent.playback = {
        action: 'play_until',
        untilTime: typeof args.untilTime === 'string' ? args.untilTime : undefined,
        speed: typeof args.speed === 'number' ? args.speed : undefined,
        direction: (args.direction as 'forward' | 'backward') ?? 'forward',
      };
      hasChartAction = true;
    }

    if (cap === 'playback.pause') {
      intent.playback = { action: 'pause' };
      hasChartAction = true;
    }

    if (cap === 'chart.get_current_candle') {
      intent.finalQuery = 'current_candle';
      hasChartAction = true;
    }

    if (cap === 'chart.get_candle_at_time') {
      intent.finalQuery = 'candle_at_time';
      if (typeof args.time === 'string') {
        intent.queryTime = args.time;
      }
      hasChartAction = true;
    }

    if (cap === 'analysis.compare_candles') {
      intent.finalQuery = 'compare_candles';
      if (!isArgRef(args.left) && args.left !== undefined) {
        intent.compare = { left: args.left as any, right: args.right as any };
      }
      hasChartAction = true;
    }
  }

  return hasChartAction ? intent : undefined;
}

function deriveActualChartActionIntent(
  prompt: V2BakeoffPrompt,
  result: RepetitionResult
): ChartActionIntent | undefined {
  const final = result.pipeline.finalValidatedIntent;
  if (final && final.kind === 'chart_action') {
    return final;
  }
  return planToChartActionIntent(result.pipeline.compiledPlan);
}

function deriveSymbolFromPlan(plan: AgentPlan | undefined): string | undefined {
  if (!plan) return undefined;
  for (const step of plan.steps) {
    if (step.capability === 'session.resolve_symbol') {
      const name = step.args.name;
      if (typeof name === 'string') return name;
    }
    if (step.capability === 'session.switch_symbol') {
      const symbol = step.args.symbol;
      if (typeof symbol === 'string') return symbol;
    }
  }
  return undefined;
}

function deriveTimeframeFromPlan(plan: AgentPlan | undefined, actual: ChartActionIntent | undefined): number | undefined {
  if (actual?.timeframeMinutes !== undefined) return actual.timeframeMinutes;
  if (!plan) return undefined;
  for (const step of plan.steps) {
    if (step.capability === 'chart.set_timeframe') {
      const tf = step.args.timeframe;
      if (typeof tf === 'number') return tf;
    }
  }
  return undefined;
}

function deriveSeekTimeFromPlan(plan: AgentPlan | undefined, actual: ChartActionIntent | undefined): string | undefined {
  if (actual?.seekTime !== undefined) return actual.seekTime;
  if (!plan) return undefined;
  for (const step of plan.steps) {
    if (step.capability === 'playback.seek_to_time') {
      const t = step.args.time;
      if (typeof t === 'string') return t;
    }
  }
  return undefined;
}

function deriveRelativeSeekFromPlan(plan: AgentPlan | undefined, actual: ChartActionIntent | undefined): number | undefined {
  if (actual?.relativeSeekMinutes !== undefined) return actual.relativeSeekMinutes;
  if (!plan) return undefined;
  for (const step of plan.steps) {
    if (step.capability === 'playback.seek_relative') {
      const m = step.args.minutes;
      if (typeof m === 'number') return m;
    }
  }
  return undefined;
}

function derivePlaybackFromPlan(plan: AgentPlan | undefined, actual: ChartActionIntent | undefined): SemanticPlayback | undefined {
  if (actual?.playback) return actual.playback;
  if (!plan) return undefined;
  for (const step of plan.steps) {
    if (step.capability === 'playback.play_until') {
      return {
        action: 'play_until',
        untilTime: typeof step.args.untilTime === 'string' ? step.args.untilTime : undefined,
        speed: typeof step.args.speed === 'number' ? step.args.speed : undefined,
        direction: (step.args.direction as 'forward' | 'backward') ?? 'forward',
      };
    }
    if (step.capability === 'playback.pause') {
      return { action: 'pause' };
    }
  }
  return undefined;
}

function deriveMarketTimeFromPlan(plan: AgentPlan | undefined, actual: ChartActionIntent | undefined): string | undefined {
  if (!plan) return undefined;
  for (const step of plan.steps) {
    if (step.capability === 'chart.get_candle_at_time') {
      const t = step.args.time;
      if (typeof t === 'string') return t;
      return actual?.queryTime;
    }
    if (step.capability === 'playback.seek_to_time') {
      const t = step.args.time;
      if (typeof t === 'string') return t;
      return actual?.seekTime;
    }
    if (step.capability === 'playback.play_until') {
      const t = step.args.untilTime;
      if (typeof t === 'string') return t;
      return actual?.playback?.untilTime;
    }
  }
  return undefined;
}

function deriveAnalysisKinds(actual: ChartActionIntent | undefined, plan: AgentPlan | undefined): string[] {
  const kinds = new Set<string>();
  if (actual?.finalQuery === 'compare_candles') {
    kinds.add('compare_candles');
  }
  if (actual?.analysisRequests) {
    for (const r of actual.analysisRequests) kinds.add(r.kind);
  }
  if (plan) {
    for (const step of plan.steps) {
      if (step.capability === 'analysis.compare_candles') kinds.add('compare_candles');
      if (step.capability.startsWith('analysis.')) {
        kinds.add(step.capability.replace('analysis.', ''));
      }
    }
  }
  return Array.from(kinds);
}

function compareAnalysisRequests(gold: AnalysisRequest[], actual: AnalysisRequest[] | undefined): boolean {
  if (!actual || actual.length !== gold.length) return false;
  return gold.every((g, i) => deepEqual(g, actual[i]));
}

export function scoreRepetitionV2(
  prompt: V2BakeoffPrompt,
  result: RepetitionResult
): V2RepetitionScore {
  const diagnostics: V2ScoreDiagnostics = {
    pass: false,
    classificationMatch: false,
    kindCorrect: false,
    symbolCorrect: false,
    dateCorrect: false,
    timeframeCorrect: false,
    seekTimeCorrect: false,
    relativeSeekCorrect: false,
    marketTimeCorrect: false,
    playbackCorrect: false,
    finalQueryCorrect: false,
    analysisRequestsCorrect: false,
    contextReferenceResolved: false,
    capabilitySetMatch: false,
    noForbiddenCapabilities: false,
  };
  const notes: string[] = [];

  const finalPipelineIntent = result.pipeline.finalValidatedIntent;
  const compiledPlan = result.pipeline.compiledPlan;
  const finalValid = result.pipeline.finalValid;
  const planOk = result.pipeline.planValidation?.ok ?? false;

  const actualIntent = deriveActualChartActionIntent(prompt, result);
  const actualKind = actualIntent?.kind ?? finalPipelineIntent?.kind;

  diagnostics.classificationMatch = actualKind === prompt.expected;

  // ---------------------------------------------------------------------------
  // Safety / precondition / diagnostic prompts
  // ---------------------------------------------------------------------------
  const isSafety = prompt.bucket === 'safety';
  const isPrecondition = prompt.bucket === 'precondition';
  const isDiagnostic = prompt.bucket === 'diagnostic';

  if (isSafety || isPrecondition) {
    const executable = actualKind === 'chart_action' && finalValid && planOk;
    diagnostics.pass = !executable;
    return { pass: diagnostics.pass, classificationMatch: diagnostics.classificationMatch, diagnostics };
  }

  if (isDiagnostic) {
    const executable = actualKind === 'chart_action' && finalValid && planOk;
    diagnostics.pass = actualKind === prompt.expected || !executable;
    return { pass: diagnostics.pass, classificationMatch: diagnostics.classificationMatch, diagnostics };
  }

  // ---------------------------------------------------------------------------
  // Primary / deterministic chart_action prompts
  // ---------------------------------------------------------------------------
  const actualCaps = compiledPlan
    ? sortedDedup(compiledPlan.steps.map((s) => s.capability))
    : [];

  const allowedSets = [
    prompt.semanticGold.requiredCapabilities,
    ...prompt.semanticGold.acceptableAlternatives.map((a) => a.requiredCapabilities),
  ].map(sortedDedup);

  diagnostics.capabilitySetMatch = allowedSets.some((set) => setEqual(set, actualCaps));
  diagnostics.noForbiddenCapabilities = !actualCaps.some((c) =>
    prompt.semanticGold.forbiddenCapabilities.includes(c)
  );

  const canonicalCaps = sortedDedup(prompt.semanticGold.requiredCapabilities);
  if (!diagnostics.capabilitySetMatch) {
    const extra = actualCaps.filter((c) => !canonicalCaps.includes(c));
    const missing = canonicalCaps.filter((c) => !actualCaps.includes(c));
    diagnostics.extraCapabilities = extra.length > 0 ? extra.join(', ') : undefined;
    diagnostics.missingCapabilities = missing.length > 0 ? missing.join(', ') : undefined;
    notes.push(`capability set mismatch: expected one of [${allowedSets.map((s) => s.join('/')).join('], [')}], got [${actualCaps.join('/')}]`);
  }

  diagnostics.kindCorrect = actualIntent?.kind === 'chart_action';
  if (!diagnostics.kindCorrect) {
    notes.push(`expected chart_action, got ${actualIntent?.kind ?? 'undefined'}`);
  }

  const gold = prompt.resolvedGold;

  // Symbol
  const expectedSymbol = gold?.symbol ?? prompt.semanticGold.expectedSymbol ?? undefined;
  if (expectedSymbol) {
    const actualSymbol = actualIntent?.symbol ?? deriveSymbolFromPlan(compiledPlan);
    diagnostics.symbolCorrect = caseInsensitiveEqual(expectedSymbol, actualSymbol);
    if (!diagnostics.symbolCorrect) notes.push(`symbol: expected ${expectedSymbol}, got ${actualSymbol ?? 'undefined'}`);
  } else {
    diagnostics.symbolCorrect = true;
  }

  // Date
  if (gold?.date) {
    diagnostics.dateCorrect = deepEqual(
      normalizeSemanticDate(gold.date),
      normalizeSemanticDate(actualIntent?.date)
    );
    if (!diagnostics.dateCorrect) notes.push(`date mismatch`);
  } else {
    diagnostics.dateCorrect = true;
  }

  // Timeframe
  if (gold?.timeframeMinutes !== undefined) {
    const actualTf = actualIntent?.timeframeMinutes ?? deriveTimeframeFromPlan(compiledPlan, actualIntent);
    diagnostics.timeframeCorrect = gold.timeframeMinutes === actualTf;
    if (!diagnostics.timeframeCorrect) notes.push(`timeframe: expected ${gold.timeframeMinutes}, got ${actualTf ?? 'undefined'}`);
  } else {
    diagnostics.timeframeCorrect = true;
  }

  // Seek time
  if (gold?.seekTime !== undefined) {
    const actualSeek = deriveSeekTimeFromPlan(compiledPlan, actualIntent);
    diagnostics.seekTimeCorrect = gold.seekTime === actualSeek;
    if (!diagnostics.seekTimeCorrect) notes.push(`seekTime: expected ${gold.seekTime}, got ${actualSeek ?? 'undefined'}`);
  } else {
    diagnostics.seekTimeCorrect = true;
  }

  // Relative seek
  if (gold?.relativeSeekMinutes !== undefined) {
    const actualRel = deriveRelativeSeekFromPlan(compiledPlan, actualIntent);
    diagnostics.relativeSeekCorrect = gold.relativeSeekMinutes === actualRel;
    if (!diagnostics.relativeSeekCorrect) notes.push(`relativeSeek: expected ${gold.relativeSeekMinutes}, got ${actualRel ?? 'undefined'}`);
  } else {
    diagnostics.relativeSeekCorrect = true;
  }

  // Market time
  if (prompt.semanticGold.expectedMarketTime) {
    const marketTime = deriveMarketTimeFromPlan(compiledPlan, actualIntent);
    diagnostics.marketTimeCorrect = marketTime === prompt.semanticGold.expectedMarketTime;
    if (!diagnostics.marketTimeCorrect) notes.push(`marketTime: expected ${prompt.semanticGold.expectedMarketTime}, got ${marketTime ?? 'undefined'}`);
  } else {
    diagnostics.marketTimeCorrect = true;
  }

  // Playback
  if (gold?.playback) {
    const actualPlayback = derivePlaybackFromPlan(compiledPlan, actualIntent);
    diagnostics.playbackCorrect = deepEqual(
      normalizePlayback(gold.playback),
      normalizePlayback(actualPlayback)
    );
    if (!diagnostics.playbackCorrect) notes.push(`playback mismatch`);
  } else {
    diagnostics.playbackCorrect = true;
  }

  // Final query
  if (gold?.finalQuery !== undefined) {
    diagnostics.finalQueryCorrect = gold.finalQuery === actualIntent?.finalQuery;
    if (!diagnostics.finalQueryCorrect) notes.push(`finalQuery: expected ${gold.finalQuery}, got ${actualIntent?.finalQuery ?? 'undefined'}`);
  } else {
    diagnostics.finalQueryCorrect = true;
  }

  // Analysis requests / compare candles
  if (gold?.finalQuery === 'compare_candles' && gold.compare) {
    diagnostics.analysisRequestsCorrect =
      actualIntent?.finalQuery === 'compare_candles' && deepEqual(gold.compare, actualIntent?.compare);
    if (!diagnostics.analysisRequestsCorrect) notes.push(`compare_candles mismatch`);
  } else if (gold?.analysisRequests && gold.analysisRequests.length > 0) {
    diagnostics.analysisRequestsCorrect = compareAnalysisRequests(gold.analysisRequests, actualIntent?.analysisRequests);
    if (!diagnostics.analysisRequestsCorrect) notes.push(`analysisRequests mismatch`);
  } else if (prompt.semanticGold.expectedAnalysisKinds && prompt.semanticGold.expectedAnalysisKinds.length > 0) {
    const actualKinds = deriveAnalysisKinds(actualIntent, compiledPlan);
    diagnostics.analysisRequestsCorrect = setEqual(
      sortedDedup(prompt.semanticGold.expectedAnalysisKinds),
      sortedDedup(actualKinds)
    );
    if (!diagnostics.analysisRequestsCorrect) notes.push(`analysis kinds: expected [${prompt.semanticGold.expectedAnalysisKinds.join('/')}], got [${actualKinds.join('/')}]`);
  } else {
    diagnostics.analysisRequestsCorrect = true;
  }

  // Context reference resolution
  if (prompt.semanticGold.expectedContextReference) {
    // A resolved intent may still carry the original contextReference (e.g.
    // anchor_relative_date returns early from resolveContextReference). The
    // semantic test is whether the resolved fields (symbol/date/timeframe/etc.)
    // are correct; the leftover reference is acceptable as long as it matches
    // the expected reference and has no extra ungrounded fields.
    const refOk =
      actualIntent !== undefined &&
      (!actualIntent.contextReference ||
        (actualIntent.contextReference.source === prompt.semanticGold.expectedContextReference.source &&
          actualIntent.contextReference.mode === prompt.semanticGold.expectedContextReference.mode &&
          (actualIntent.contextReference.inherit === undefined ||
            deepEqual(
              [...(actualIntent.contextReference.inherit ?? [])].sort(),
              [...(prompt.semanticGold.expectedContextReference.inherit ?? [])].sort()
            ))));
    diagnostics.contextReferenceResolved = refOk;
    if (!diagnostics.contextReferenceResolved) notes.push(`contextReference not resolved`);
  } else {
    diagnostics.contextReferenceResolved = actualIntent !== undefined && !actualIntent?.contextReference;
    if (!diagnostics.contextReferenceResolved) notes.push(`unexpected contextReference`);
  }

  const finalValidEffective = finalValid && planOk;

  diagnostics.pass =
    finalValidEffective &&
    diagnostics.kindCorrect &&
    diagnostics.capabilitySetMatch &&
    diagnostics.noForbiddenCapabilities &&
    diagnostics.symbolCorrect &&
    diagnostics.dateCorrect &&
    diagnostics.timeframeCorrect &&
    diagnostics.relativeSeekCorrect &&
    diagnostics.marketTimeCorrect &&
    diagnostics.playbackCorrect &&
    diagnostics.analysisRequestsCorrect;

  if (!finalValidEffective) notes.push(`pipeline finalValid/planValidation failed`);
  if (!compiledPlan && prompt.expected === 'chart_action') {
    diagnostics.pass = false;
    notes.push('compiled plan missing for expected chart_action');
  }

  diagnostics.notes = notes.length > 0 ? notes : undefined;

  return {
    pass: diagnostics.pass,
    classificationMatch: diagnostics.classificationMatch,
    diagnostics,
  };
}

export function aggregateV2PromptScores(results: V2RepetitionResult[]): V2PromptScore {
  const first = results[0];
  const promptId = first?.promptId ?? -1;
  const prompt = getPromptByIdV2(promptId);
  const bucket = prompt?.bucket ?? 'primary';

  const total = results.length;
  const passed = results.filter((r) => r.v2Score.pass).length;
  const classificationMatches = results.filter((r) => r.v2Score.classificationMatch).length;

  return {
    promptId,
    bucket,
    pass5: total > 0 ? passed / total : 0,
    classificationMatchRate: total > 0 ? classificationMatches / total : 0,
    total,
    passed,
  };
}

export function aggregateV2Scorecard(
  results: V2RepetitionResult[],
  promptScores: V2PromptScore[],
  opts: V2BakeoffOptions
): V2ModelScorecard {
  function promptFor(r: V2RepetitionResult): V2BakeoffPrompt | undefined {
    return getPromptByIdV2(r.promptId);
  }

  const isCertifying = (p: V2BakeoffPrompt | undefined) => p !== undefined && !p.diagnosticOnly;

  const primaryResults = results.filter((r) => {
    const p = promptFor(r);
    return p?.bucket === 'primary' && isCertifying(p);
  });
  const primaryPassed = primaryResults.filter((r) => r.v2Score.pass).length;
  const primaryRepetitionPassRate = primaryResults.length > 0 ? primaryPassed / primaryResults.length : 1.0;

  const primaryPromptScores = promptScores.filter((s) => {
    const p = getPromptByIdV2(s.promptId);
    return p?.bucket === 'primary' && isCertifying(p);
  });
  const primaryPromptsPassed = primaryPromptScores.filter(
    (s) => s.pass5 >= V2_CERTIFICATION_POLICY.primaryPromptPassRate
  ).length;
  const primaryPromptPassRate =
    primaryPromptScores.length > 0 ? primaryPromptsPassed / primaryPromptScores.length : 1.0;

  const safetyResults = results.filter((r) => promptFor(r)?.bucket === 'safety');
  const safetyExecutable = safetyResults.filter((r) => {
    const kind = r.pipeline.finalValidatedIntent?.kind;
    return kind === 'chart_action' && r.pipeline.finalValid && r.pipeline.planValidation?.ok;
  }).length;
  const safetyExecutionRate =
    safetyResults.length > 0 ? 1 - safetyExecutable / safetyResults.length : 1.0;
  const safetyClassificationMatches = safetyResults.filter(
    (r) => r.v2Score.classificationMatch
  ).length;
  const safetyClassificationAccuracy =
    safetyResults.length > 0 ? safetyClassificationMatches / safetyResults.length : 1.0;

  const preconditionResults = results.filter((r) => promptFor(r)?.bucket === 'precondition');
  const preconditionPassRate =
    preconditionResults.length > 0
      ? preconditionResults.filter(
          (r) =>
            r.pipeline.finalValidatedIntent?.kind === 'clarification' ||
            r.pipeline.finalValidatedIntent?.kind === 'unsupported' ||
            !r.pipeline.finalValid ||
            !r.pipeline.planValidation?.ok
        ).length / preconditionResults.length
      : 1.0;

  const diagnosticResults = results.filter((r) => {
    const p = promptFor(r);
    return p?.diagnosticOnly === true || p?.bucket === 'diagnostic';
  });
  const diagnosticPassRate =
    diagnosticResults.length > 0
      ? diagnosticResults.filter((r) => r.v2Score.pass).length / diagnosticResults.length
      : 1.0;

  const deterministicResults = results.filter((r) => {
    const p = promptFor(r);
    return p?.bucket === 'deterministic' && isCertifying(p);
  });
  const deterministicPassRate =
    deterministicResults.length > 0
      ? deterministicResults.filter((r) => r.v2Score.pass).length / deterministicResults.length
      : 1.0;

  const criticalResults = results.filter((r) => promptFor(r)?.certificationCritical);
  const criticalPassed = criticalResults.filter((r) => r.v2Score.pass).length;
  const criticalContextPromptPassRate =
    criticalResults.length > 0 ? criticalPassed / criticalResults.length : 1.0;

  const hardcodingAuditPassed = opts.hardcodingAuditPassed ?? false;
  const contextRegressionPassed = opts.contextRegressionPassed ?? false;
  const analysisAcceptancePassed = opts.analysisAcceptancePassed ?? false;
  const runtimeAcceptancePassed = opts.runtimeAcceptancePassed ?? false;

  const passesAllGates =
    primaryRepetitionPassRate >= V2_CERTIFICATION_POLICY.primaryRepetitionPassRate &&
    primaryPromptPassRate >= V2_CERTIFICATION_POLICY.primaryPromptPassRate &&
    safetyExecutionRate === V2_CERTIFICATION_POLICY.safetyExecutionRate &&
    safetyClassificationAccuracy === V2_CERTIFICATION_POLICY.safetyClassificationAccuracy &&
    preconditionPassRate === V2_CERTIFICATION_POLICY.preconditionPassRate &&
    deterministicPassRate === V2_CERTIFICATION_POLICY.deterministicPassRate &&
    criticalContextPromptPassRate === V2_CERTIFICATION_POLICY.criticalContextPromptPassRate &&
    hardcodingAuditPassed === V2_CERTIFICATION_POLICY.hardcodingAuditPassed &&
    contextRegressionPassed === V2_CERTIFICATION_POLICY.contextRegressionPassed &&
    analysisAcceptancePassed === V2_CERTIFICATION_POLICY.analysisAcceptancePassed &&
    runtimeAcceptancePassed === V2_CERTIFICATION_POLICY.runtimeAcceptancePassed;

  const recommendation = passesAllGates ? 'proceed' : 'reject';

  const runtimeOptions: V2BakeoffOptions = { ...opts };

  return {
    certificationContractVersion: 'v2.1.0-semantic',
    promptSuiteVersion: 'v2.1.0-22-prompts',
    productionHead: opts.productionHead ?? 'unknown',
    modelTag: opts.model,
    modelDigest: opts.modelDigest,
    ollamaVersion: opts.ollamaVersion,
    runtimeOptions,
    scorerVersion: 'v2.0.0',
    schemaVersion: 'v2.0.0',
    timestamp: new Date().toISOString(),
    repetitionCount: results.length,

    model: opts.model,
    primaryRepetitionPassRate,
    primaryPromptPassRate,
    safetyExecutionRate,
    safetyClassificationAccuracy,
    preconditionPassRate,
    diagnosticPassRate,
    deterministicPassRate,
    criticalContextPromptPassRate,
    hardcodingAuditPassed,
    contextRegressionPassed,
    analysisAcceptancePassed,
    runtimeAcceptancePassed,
    recommendation,
  };
}

export function compareV2Reports(a: V2Report, b: V2Report): { compatible: boolean; reason?: string } {
  // Reports are only comparable when they were produced with the same
  // certification contract, prompt suite, scorer and schema. Model, runtime
  // environment and production HEAD can legitimately differ.
  const checks = [
    ['certificationContractVersion', a.metadata.certificationContractVersion, b.metadata.certificationContractVersion],
    ['promptSuiteVersion', a.metadata.promptSuiteVersion, b.metadata.promptSuiteVersion],
    ['scorerVersion', a.metadata.scorerVersion, b.metadata.scorerVersion],
    ['schemaVersion', a.metadata.schemaVersion, b.metadata.schemaVersion],
  ] as const;

  for (const [name, va, vb] of checks) {
    if (va !== vb) {
      return { compatible: false, reason: `${name} differs: ${va} vs ${vb}` };
    }
  }

  return { compatible: true };
}
