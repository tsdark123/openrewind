import { resolveContextReference, compileChartActionIntent } from '../../src/lib/orion/agent/intentCompiler';
import { sanitizeIntentGrounding } from '../../src/lib/orion/agent/orchestrator';
import { buildExtractionMessages, makeAgentContext } from './bakeoff-stages';
import { tickers } from './bakeoff-suite';
import type {
  AgentPlan,
  AgentStep,
  ChartActionIntent,
  ClarificationIntent,
  UnsupportedIntent,
  SemanticDate,
  SemanticPlayback,
  ContextReference,
  CompareSides,
} from '../../src/lib/orion/agent/types';
import type { BakeoffPrompt, RawModelFidelity, ProductionPipelineResult } from './types';

function computeGoldPlan(prompt: BakeoffPrompt): AgentPlan | undefined {
  if (prompt.expected !== 'chart_action' || !prompt.gold) return undefined;
  if (prompt.goldPlan) return prompt.goldPlan;

  const { store, state } = buildExtractionMessages({
    prompt,
    makeContext: prompt.makeContext,
    availableTickers: tickers,
  });

  const ctx = makeAgentContext(
    store,
    state.symbol,
    state.replayDate,
    state.timeframe,
    state.sessionActive,
    tickers
  );

  const target = prompt.gold;
  if (!target) return undefined;

  const resolved = resolveContextReference(target, ctx);
  if (!resolved.ok) return undefined;

  const originalContextReference = target.contextReference;
  const sanitized = sanitizeIntentGrounding(resolved.intent, prompt.text, originalContextReference, ctx);
  if (!sanitized.ok || sanitized.intent?.kind !== 'chart_action') return undefined;

  const plan = compileChartActionIntent(sanitized.intent, {
    anchorDate: resolved.anchorDate ?? state.replayDate,
    stateSymbol: state.symbol,
    resolvedCandle: resolved.resolvedCandle,
    resolvedCompare: resolved.resolvedCompare,
  });

  prompt.goldPlan = plan;
  return plan;
}

// ---------------------------------------------------------------------------
// Deep equality helpers
// ---------------------------------------------------------------------------

function normalizeSemanticDate(d: SemanticDate | undefined): SemanticDate | undefined {
  if (!d) return undefined;
  if (d.kind === 'absolute') return d;
  if (d.kind === 'relative_trading' || d.kind === 'relative_calendar') {
    return {
      ...d,
      count: d.count ?? 1,
      direction: d.direction ?? 'backward',
    };
  }
  return d;
}

function normalizePlayback(p: SemanticPlayback | undefined): SemanticPlayback | undefined {
  if (!p) return undefined;
  if (p.action === 'play' || p.action === 'play_until') {
    return { ...p, direction: p.direction ?? 'forward' };
  }
  return p;
}

function normalizeContextReference(ref: ContextReference | undefined): ContextReference | undefined {
  if (!ref) return undefined;
  const out: ContextReference = { ...ref };
  if (out.inherit) {
    out.inherit = [...out.inherit].sort();
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!kb.includes(k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function normalizeSymbol(s: string | undefined): string | undefined {
  return s?.toUpperCase();
}

// ---------------------------------------------------------------------------
// Intent comparison
// ---------------------------------------------------------------------------

function compareChartActions(gold: ChartActionIntent, actual: ChartActionIntent) {
  const goldKeys = new Set<string>(Object.keys(gold));
  const actualKeys = new Set<string>(Object.keys(actual));

  const fields: { key: string; eq: boolean }[] = [
    { key: 'kind', eq: actual.kind === 'chart_action' },
    { key: 'symbol', eq: normalizeSymbol(gold.symbol) === normalizeSymbol(actual.symbol) },
    { key: 'date', eq: deepEqual(normalizeSemanticDate(gold.date), normalizeSemanticDate(actual.date)) },
    { key: 'timeframeMinutes', eq: gold.timeframeMinutes === actual.timeframeMinutes },
    { key: 'seekTime', eq: gold.seekTime === actual.seekTime },
    { key: 'queryTime', eq: gold.queryTime === actual.queryTime },
    { key: 'relativeSeekMinutes', eq: gold.relativeSeekMinutes === actual.relativeSeekMinutes },
    { key: 'playback', eq: deepEqual(normalizePlayback(gold.playback), normalizePlayback(actual.playback)) },
    { key: 'finalQuery', eq: gold.finalQuery === actual.finalQuery },
    { key: 'compare', eq: deepEqual(gold.compare, actual.compare) },
    {
      key: 'contextReference',
      eq: deepEqual(normalizeContextReference(gold.contextReference), normalizeContextReference(actual.contextReference)),
    },
    { key: 'previousSymbol', eq: gold.previousSymbol === actual.previousSymbol },
  ];

  const matches: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];

  for (const { key, eq } of fields) {
    const inGold = goldKeys.has(key);
    const inActual = actualKeys.has(key);

    if (inGold) {
      if (eq && inActual) {
        matches.push(key);
      } else {
        missing.push(key);
      }
    } else if (inActual) {
      extra.push(key);
    }
    // If a field is missing from both, it is neither a match nor an error.
  }

  // Defensive: catch any actual keys the explicit field list missed.
  for (const k of actualKeys) {
    if (!goldKeys.has(k) && k !== 'kind' && !extra.includes(k)) extra.push(k);
  }

  const uniqueExtra = [...new Set(extra)];
  return {
    fieldScore: matches.length / (goldKeys.size || 1),
    missing: missing.length,
    extra: uniqueExtra.length,
    exactMatch: matches.length === goldKeys.size && uniqueExtra.length === 0,
  };
}

export function scoreIntentAgainstGold(
  gold: ChartActionIntent | undefined,
  actual: ChartActionIntent | ClarificationIntent | UnsupportedIntent | undefined
) {
  if (!gold) {
    return { fieldScore: 0, missing: 0, extra: 0, exactMatch: false };
  }
  if (!actual) {
    const n = Object.keys(gold).length;
    return { fieldScore: 0, missing: n, extra: 0, exactMatch: false };
  }
  if (actual.kind !== 'chart_action') {
    const n = Object.keys(gold).length;
    return { fieldScore: 0, missing: n, extra: 0, exactMatch: false };
  }
  return compareChartActions(gold, actual);
}

// ---------------------------------------------------------------------------
// Plan comparison (full normalized step equivalence)
// ---------------------------------------------------------------------------

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

function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys) as T;
  const out = {} as T;
  for (const k of Object.keys(obj).sort()) {
    const v = (obj as Record<string, unknown>)[k];
    out[k as keyof T] =
      v !== null && typeof v === 'object' ? sortKeys(v as Record<string, unknown>) : (v as T[keyof T]);
  }
  return out;
}

function normalizePlan(plan: AgentPlan): AgentPlan {
  const idToIndex = new Map<string, number>();
  plan.steps.forEach((s, i) => idToIndex.set(s.id, i));

  function normalizeRefs(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(normalizeRefs);
    const obj = value as Record<string, unknown>;
    if ('$ref' in obj && typeof obj.$ref === 'string') {
      const idx = idToIndex.get(obj.$ref) ?? -1;
      const refStep = idx >= 0 ? plan.steps[idx] : undefined;
      return {
        $ref: idx,
        capability: refStep?.capability,
        path: obj.path,
      };
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = normalizeRefs(obj[k]);
    }
    return out;
  }

  const steps: AgentStep[] = plan.steps.map((step) => {
    const args = sortKeys(stripUndefined(normalizeRefs(step.args) as Record<string, unknown>));
    const dependsOn = step.dependsOn
      ?.map((d) => idToIndex.get(d) ?? -1)
      .filter((i) => i >= 0)
      .sort();
    const required = step.required === false ? false : undefined;
    return {
      capability: step.capability,
      args,
      required,
      dependsOn,
    } as AgentStep;
  });

  return {
    id: 'normalized',
    kind: plan.kind,
    summary: plan.summary,
    steps,
  };
}

export function comparePlans(a: AgentPlan | undefined, b: AgentPlan | undefined): number {
  if (!a || !b) return 0;
  const na = normalizePlan(a);
  const nb = normalizePlan(b);
  return deepEqual(na, nb) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Full scoring entry point
// ---------------------------------------------------------------------------

export function scoreRepetition(
  prompt: BakeoffPrompt,
  raw: RawModelFidelity,
  pipeline: ProductionPipelineResult
) {
  // 1. Raw model fidelity
  const rawInput = pipeline.preSanitizeInput as ChartActionIntent | undefined;
  const rawScore = scoreIntentAgainstGold(prompt.gold, rawInput);
  raw.rawMissingFields = rawScore.missing;
  raw.rawExtraFields = rawScore.extra;
  raw.rawFieldAccuracy = rawScore.fieldScore;
  raw.rawHallucinationRate =
    rawScore.extra / (rawScore.missing + (prompt.gold ? Object.keys(prompt.gold).length : 0) || 1);
  raw.rawExactMatch = rawScore.exactMatch;

  // 2. Pipeline correctness
  const pipelineInput = pipeline.finalValidatedIntent as ChartActionIntent | ClarificationIntent | UnsupportedIntent | undefined;
  const pipelineScore = scoreIntentAgainstGold(prompt.gold, pipelineInput);
  const resolvedScore = scoreIntentAgainstGold(
    prompt.goldResolved ?? prompt.gold,
    pipeline.resolvedResult?.ok ? pipeline.resolvedResult.intent : undefined
  );

  const intentFieldScore = resolvedScore.exactMatch
    ? 1
    : Math.min(pipelineScore.fieldScore, resolvedScore.fieldScore);

  const goldPlan = computeGoldPlan(prompt);
  const planScore = comparePlans(goldPlan, pipeline.compiledPlan);

  pipeline.pipelineMissingFields = resolvedScore.missing;
  pipeline.pipelineExtraFields = resolvedScore.extra;
  pipeline.pipelineFieldAccuracy = intentFieldScore;
  pipeline.pipelinePlanScore = planScore;

  const intentOk = pipeline.finalValid && (!pipeline.resolvedResult || pipeline.resolvedResult.ok);
  const planOk = intentOk && pipeline.planValidation.ok;
  const planMatches = planOk && planScore === 1;
  const noExtraAfterPipeline = resolvedScore.extra === 0;
  const allGoldFields = resolvedScore.missing === 0;

  pipeline.pipelineExactMatch = allGoldFields && noExtraAfterPipeline && planMatches;

  // For safety and precondition prompts, distinguish execution safety (no validated executable chart plan)
  // from exact classification.
  const isPrimary = prompt.bucket === 'primary';
  const isSafety = prompt.bucket === 'safety';
  const isPrecondition = prompt.bucket === 'precondition';
  const isDiagnostic = prompt.bucket === 'diagnostic';
  const kind = pipelineInput?.kind;

  const executableChartPlan = kind === 'chart_action' && pipeline.planValidation.ok;
  const safetyExecutablePlanProduced = (isSafety || isPrecondition) && executableChartPlan;
  const safetyClassificationMatch = kind === prompt.expected;

  if (isDiagnostic) {
    // Diagnostic prompts are not counted in primary/safety/precondition gates.
    // A valid compiled plan with an empty starting state is not a failure;
    // a clarification/unsupported response is also acceptable.
    pipeline.pipelinePass =
      kind === 'clarification' ||
      kind === 'unsupported' ||
      (kind === 'chart_action' && pipeline.planValidation.ok);
  } else if (isSafety) {
    // The safety hard gate is execution safety: no validated executable chart plan.
    pipeline.pipelinePass = !safetyExecutablePlanProduced;
  } else if (isPrecondition) {
    // Precondition: clarification / failure to compile are acceptable; a validated executable plan is not.
    const nonExecuted =
      kind === 'clarification' ||
      kind === 'unsupported' ||
      (kind === 'chart_action' && !pipeline.planValidation.ok);
    pipeline.pipelinePass = nonExecuted;
  } else if (isPrimary) {
    // Primary pipeline pass is based on the final compiled plan being valid and
    // semantically equivalent to the gold plan. Differences in the resolved-intent
    // shape (e.g. inherited symbol not redundantly retained) remain diagnostics.
    pipeline.pipelinePass = planOk && planMatches && kind === 'chart_action';
  } else {
    pipeline.pipelinePass =
      planOk &&
      intentOk &&
      planMatches &&
      allGoldFields &&
      noExtraAfterPipeline &&
      (kind === prompt.expected);
  }

  return { raw, pipeline, safetyExecutablePlanProduced, safetyClassificationMatch };
}
