import { readFileSync } from 'fs';
import { resolveContextReference, compileChartActionIntent } from '../../src/lib/orion/agent/intentCompiler';
import type { ChartActionIntent, AgentPlan, SemanticDate, SemanticPlayback } from '../../src/lib/orion/agent/types';
import { buildExtractionMessages, makeAgentContext } from './bakeoff-stages';
import { makeEmptyContext, makeContextFixture, tickers } from './bakeoff-suite';
import type {
  V2BakeoffPrompt,
  V2SemanticExpectation,
  V2AcceptableAlternative,
  V2PromptKind,
  V2Bucket,
  V2Profile,
} from './bakeoff-types-v2';

// Load the V2 design plan once at module load.
const designPlanPath = new URL('./output/v2-design-plan.json', import.meta.url);
const designPlan: { prompts: V2SemanticExpectation[] } = JSON.parse(
  readFileSync(designPlanPath, 'utf-8')
);

const FIXTURE_CONTEXT_PROMPT_IDS = new Set([
  6, 7, 8, 11, 13, 14, 15, 16, 17, 18,
]);

function profileForPrompt(id: number): V2Profile {
  return FIXTURE_CONTEXT_PROMPT_IDS.has(id) ? 'active' : 'empty';
}

function makeContextForPrompt(id: number): () => { store: import('../../src/lib/orion/agent/types').ExecutionContextStore; stateSymbol?: string } {
  return FIXTURE_CONTEXT_PROMPT_IDS.has(id) ? makeContextFixture : makeEmptyContext;
}

function normalizeSemanticDate(d: V2SemanticExpectation['expectedDate']): SemanticDate | undefined {
  if (!d) return undefined;
  if (d.kind === 'absolute') {
    return { kind: 'absolute', value: d.value };
  }
  return {
    kind: d.kind,
    count: d.count ?? 1,
    direction: d.direction ?? 'backward',
  };
}

function normalizePlayback(p: V2SemanticExpectation['expectedPlayback']): SemanticPlayback | undefined {
  if (!p) return undefined;
  return { ...p, direction: p.direction ?? 'forward' };
}

/**
 * Derive the canonical (unresolved) ChartActionIntent for a prompt from its
 * V2 semantic expectation. This is the gold extraction that the model *should*
 * produce; it is then resolved and compiled to obtain the canonical capability
 * set and the resolved gold intent.
 */
function buildBaseChartActionIntent(gold: V2SemanticExpectation): ChartActionIntent | undefined {
  if (gold.expectedKind !== 'chart_action') return undefined;

  const intent: ChartActionIntent = { kind: 'chart_action' };

  if (gold.expectedSymbol) {
    intent.symbol = gold.expectedSymbol;
  }

  const date = normalizeSemanticDate(gold.expectedDate);
  if (date) {
    intent.date = date;
  }

  if (gold.expectedTimeframe !== null && gold.expectedTimeframe !== undefined) {
    intent.timeframeMinutes = gold.expectedTimeframe;
  }

  if (gold.expectedSeekTime) {
    intent.seekTime = gold.expectedSeekTime;
  }

  if (gold.expectedPlayback) {
    intent.playback = normalizePlayback(gold.expectedPlayback);
  }

  if (gold.expectedContextReference) {
    intent.contextReference = { ...gold.expectedContextReference };
  }

  if (gold.requiredCapabilities.includes('session.switch_to_previous_symbol')) {
    intent.previousSymbol = true;
  }

  // Derive finalQuery / relativeSeek from the semantic intent.
  if (gold.expectedFinalQuery) {
    if (gold.expectedFinalQuery === 'compare_candles') {
      intent.finalQuery = 'compare_candles';
      intent.compare = {
        left: { source: 'latest_returned_candle' },
        right: { source: 'previous_returned_candle' },
      };
    } else if (gold.expectedFinalQuery === 'candle_at_time' && gold.expectedMarketTime) {
      intent.finalQuery = 'candle_at_time';
      intent.queryTime = gold.expectedMarketTime;
    } else if (gold.expectedFinalQuery === 'current_candle') {
      intent.finalQuery = 'current_candle';
    }
  }

  if (gold.expectedRelativeSeekMinutes !== undefined) {
    intent.relativeSeekMinutes = gold.expectedRelativeSeekMinutes;
  }

  if (gold.expectedAnalysisRequests && gold.expectedAnalysisRequests.length > 0) {
    intent.analysisRequests = gold.expectedAnalysisRequests;
  }

  return intent;
}

function deriveExpectedFinalQuery(gold: V2SemanticExpectation): V2SemanticExpectation['expectedFinalQuery'] {
  if (gold.expectedAnalysisKinds?.includes('compare_candles')) return 'compare_candles';

  const caps = new Set(gold.requiredCapabilities);

  if (caps.has('analysis.compare_candles') || gold.expectedAnalysisKinds?.includes('compare_candles')) {
    return 'compare_candles';
  }

  if (caps.has('chart.get_candle_at_time') && !gold.expectedSeekTime && gold.expectedMarketTime) {
    return 'candle_at_time';
  }

  if (caps.has('chart.get_current_candle')) {
    return 'current_candle';
  }

  return undefined;
}

function deriveExpectedRelativeSeekMinutes(id: number): number | undefined {
  if (id === 6) return -30;
  if (id === 7) return 15;
  return undefined;
}

function computeV2ResolvedGold(
  prompt: V2BakeoffPrompt
): { resolvedGold?: ChartActionIntent; resolvedGoldPlan?: AgentPlan; resolvedCapabilitySet?: string[] } {
  const gold = prompt.semanticGold;
  if (gold.expectedKind !== 'chart_action') {
    return {};
  }

  const baseIntent = buildBaseChartActionIntent(gold);
  if (!baseIntent) {
    return {};
  }

  const { state, store, stateSymbol } = buildExtractionMessages({
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

  const resolved = resolveContextReference(baseIntent, ctx, prompt.text);
  if (!resolved.ok) {
    return {};
  }

  const resolvedGold = resolved.intent;
  // ResolveContextReference should consume the contextReference, but the
  // anchor_relative_date branch returns early; make sure it is removed.
  delete resolvedGold.contextReference;

  try {
    const resolvedGoldPlan = compileChartActionIntent(resolvedGold, {
      anchorDate: resolved.anchorDate || state.replayDate || undefined,
      stateSymbol: state.symbol || stateSymbol,
      resolvedCandle: resolved.resolvedCandle,
      resolvedCompare: resolved.resolvedCompare,
    });

    const resolvedCapabilitySet = Array.from(
      new Set(resolvedGoldPlan.steps.map((s) => s.capability))
    ).sort();

    return { resolvedGold, resolvedGoldPlan, resolvedCapabilitySet };
  } catch {
    return { resolvedGold };
  }
}

function normalizeV2SemanticExpectation(raw: V2SemanticExpectation): V2SemanticExpectation {
  const gold: V2SemanticExpectation = {
    ...raw,
    bucket: raw.bucket as V2Bucket,
    expectedKind: raw.expectedKind as V2PromptKind,
    expectedDate: raw.expectedDate as V2SemanticExpectation['expectedDate'],
    expectedPlayback: raw.expectedPlayback as V2SemanticExpectation['expectedPlayback'],
    expectedContextReference: raw.expectedContextReference as V2SemanticExpectation['expectedContextReference'],
    acceptableAlternatives: (raw.acceptableAlternatives ?? []).map((alt) => ({
      description: alt.description,
      requiredCapabilities: alt.requiredCapabilities,
    })),
    expectedFinalQuery: deriveExpectedFinalQuery(raw),
    expectedRelativeSeekMinutes: deriveExpectedRelativeSeekMinutes(raw.id),
  };
  return gold;
}

function buildV2Prompt(gold: V2SemanticExpectation): V2BakeoffPrompt {
  const prompt: V2BakeoffPrompt = {
    id: gold.id,
    text: gold.text,
    profile: profileForPrompt(gold.id),
    bucket: gold.bucket,
    expected: gold.expectedKind,
    semanticGold: normalizeV2SemanticExpectation(gold),
    makeContext: makeContextForPrompt(gold.id),
  };

  const resolved = computeV2ResolvedGold(prompt);
  prompt.resolvedGold = resolved.resolvedGold;
  prompt.resolvedGoldPlan = resolved.resolvedGoldPlan;
  prompt.resolvedCapabilitySet = resolved.resolvedCapabilitySet;

  return prompt;
}

export const ALL_PROMPTS_V2: V2BakeoffPrompt[] = designPlan.prompts
  .slice()
  .sort((a, b) => a.id - b.id)
  .map(buildV2Prompt);

export function getPromptByIdV2(id: number): V2BakeoffPrompt | undefined {
  return ALL_PROMPTS_V2.find((p) => p.id === id);
}

export { tickers };
export type { V2AcceptableAlternative, V2SemanticExpectation, V2BakeoffPrompt };
