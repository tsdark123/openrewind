import { parseChartCommand } from '../../src/lib/orion/planner';
import { SYMBOL_ALIASES } from '../../src/lib/orion/symbolAliases';
import {
  buildIntentExtractionPrompt,
  buildIntentRepairPrompt,
  validateSemanticIntent,
  preValidateSanitize,
  type RequestContext,
} from '../../src/lib/orion/agent/intent';
import {
  resolveContextReference,
  compileChartActionIntent,
} from '../../src/lib/orion/agent/intentCompiler';
import { sanitizeIntentGrounding } from '../../src/lib/orion/agent/orchestrator';
import { validateAgentPlan } from '../../src/lib/orion/agent/validatePlan';
import { getRequestedDimensions } from '../../src/lib/orion/agent/dimensions';
import { createExecutionContext } from '../../src/lib/orion/agent/executionContext';
import type {
  AgentContext,
  AppState,
  ChartActionIntent,
  ExecutionContextStore,
  PlanValidationResult,
  ContextResolutionResult,
} from '../../src/lib/orion/agent/types';
import type { OllamaMessage, OllamaMetrics } from './bakeoff-ollama';
import type { RawModelFidelity, ProductionPipelineResult } from './types';

function parseIntentJson(content: string): unknown {
  const cleaned = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!cleaned) return undefined;
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function buildRequestContext(
  text: string,
  state: { symbol: string; replayDate: string; timeframe: number },
  availableTickers: string[]
): RequestContext {
  const cmd = parseChartCommand(text, availableTickers, SYMBOL_ALIASES, state.replayDate);
  const requested = getRequestedDimensions(text, cmd, state.replayDate);
  const parserCovered = new Set<string>();
  if (cmd.symbol) parserCovered.add('symbol');
  if (cmd.date || cmd.dateInput) parserCovered.add('date');
  if (cmd.timeframe !== undefined) parserCovered.add('timeframe');
  if (cmd.startTime || cmd.endTime) parserCovered.add('absoluteTime');
  if (cmd.relativeMinutes !== undefined) parserCovered.add('relativeSeek');
  if (cmd.speed !== undefined) parserCovered.add('playbackControl');
  if (cmd.intent === 'candle_query') parserCovered.add('candleQuery');
  const missing = Array.from(requested).filter((d) => !parserCovered.has(d));
  return {
    dimensions: Array.from(requested),
    missing,
    baseDate: state.replayDate,
    availableTickers,
    symbolAliases: SYMBOL_ALIASES,
  };
}

function makeAppState(
  symbol: string,
  replayDate: string,
  timeframe: number,
  sessionActive: boolean
): AppState {
  return {
    connected: true,
    sessionActive,
    symbol,
    replayDate,
    cursor: 0,
    totalCandles: 0,
    timeframe,
    currentPrice: 0,
    isPlaying: false,
    speed: 1,
    playbackDirection: 'forward',
    orderQuantity: 1,
    indicators: { ema20: false, sma50: false, bollinger: false, rsi: false, macd: false, atr: false, stochastic: false },
    balance: 0,
    equity: 0,
    openPositions: [],
    pendingOrders: [],
    tradeHistory: [],
    activeSessionTrades: [],
    performanceLog: {},
  };
}

export function makeAgentContext(
  store: ExecutionContextStore,
  stateSymbol: string,
  replayDate: string,
  timeframe: number,
  sessionActive: boolean,
  availableTickers: string[]
): AgentContext {
  return {
    getState: () => makeAppState(stateSymbol, replayDate, timeframe, sessionActive),
    chartRef: null,
    performanceLog: {},
    apiBase: 'http://127.0.0.1:9000',
    availableTickers,
    send: () => {},
    dispatch: () => {},
    onSwitchSymbol: () => {},
    onMessage: () => {},
    executionLog: store,
  };
}

export function buildExtractionMessages(opts: {
  prompt: { text: string; profile: 'active' | 'empty'; bucket: string };
  makeContext: () => { store: ExecutionContextStore; stateSymbol?: string };
  availableTickers: string[];
}): {
  messages: OllamaMessage[];
  state: { symbol: string; replayDate: string; timeframe: number; sessionActive: boolean };
  requestContext: RequestContext;
  store: ExecutionContextStore;
  stateSymbol: string;
} {
  const { store, stateSymbol = '' } = opts.makeContext();
  const latest = store.getEntries().slice(-1)[0];
  const after = latest?.after;
  const state =
    opts.prompt.profile === 'active'
      ? {
          symbol: after?.symbol || stateSymbol || 'AAPL',
          replayDate: after?.date || '2026-07-31',
          timeframe: after?.timeframe ?? 5,
          sessionActive: true,
        }
      : { symbol: '', replayDate: '', timeframe: 1, sessionActive: false };
  const system = buildIntentExtractionPrompt(store);
  const requestContext = buildRequestContext(opts.prompt.text, state, opts.availableTickers);
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: opts.prompt.text },
    ],
    state,
    requestContext,
    store,
    stateSymbol,
  };
}

export async function extractAndStage(opts: {
  prompt: { text: string; profile: 'active' | 'empty'; bucket: string; expected: string };
  makeContext: () => { store: ExecutionContextStore; stateSymbol?: string };
  availableTickers: string[];
  callOllama: (messages: OllamaMessage[]) => Promise<{ rawText: string; final: Record<string, unknown>; metrics: OllamaMetrics }>;
}): Promise<{
  raw: RawModelFidelity;
  pipeline: ProductionPipelineResult;
  finalMessages: OllamaMessage[];
  metrics: OllamaMetrics;
}> {
  const { messages, state, requestContext, store, stateSymbol } = buildExtractionMessages({
    prompt: opts.prompt,
    makeContext: opts.makeContext,
    availableTickers: opts.availableTickers,
  });

  const ctx = makeAgentContext(
    store,
    state.symbol,
    state.replayDate,
    state.timeframe,
    state.sessionActive,
    opts.availableTickers
  );

  let lastMetrics: OllamaMetrics = {
    requestStart: 0,
    firstTokenAt: 0,
    streamEndAt: 0,
    loadDuration: 0,
    promptEvalDuration: 0,
    evalDuration: 0,
    totalDuration: 0,
    promptEvalCount: 0,
    evalCount: 0,
    wallClockTotal: 0,
    tokensPerSecond: 0,
    trueTTFT: 0,
  };
  const first = await opts.callOllama(messages);
  lastMetrics = first.metrics;
  const raw: RawModelFidelity = {
    rawText: first.rawText,
    jsonOk: false,
    initialValid: false,
    repairRequired: false,
    rawMissingFields: 0,
    rawExtraFields: 0,
    rawFieldAccuracy: 0,
    rawHallucinationRate: 0,
    rawExactMatch: false,
  };

  const pipeline: ProductionPipelineResult = {
    preSanitizeValid: false,
    finalValid: false,
    resolvedResult: { ok: true, intent: { kind: 'chart_action' } as ChartActionIntent },
    planValidation: { ok: false, error: 'Not evaluated' },
    pipelineMissingFields: 0,
    pipelineExtraFields: 0,
    pipelineFieldAccuracy: 0,
    pipelinePlanScore: 0,
    pipelineExactMatch: false,
    pipelinePass: false,
  };

  const initialParsed = parseIntentJson(first.rawText);
  raw.initialParsed = initialParsed;
  raw.jsonOk = initialParsed !== undefined;

  const initialValidation = raw.jsonOk ? validateSemanticIntent(initialParsed) : { ok: false as const, error: 'JSON parse failed' };
  raw.initialValid = initialValidation.ok;
  if (!initialValidation.ok) {
    raw.initialError = ('error' in initialValidation ? initialValidation.error : undefined) as string | undefined;
    raw.parseError = raw.jsonOk ? undefined : 'JSON parse failed';
  } else {
    raw.initialIntent = initialValidation.intent;
  }

  const MAX_REPAIR = 1;
  let repairRawText: string | undefined;
  let finalParsed: unknown = initialParsed;
  let finalValidation = initialValidation;

  if ((!raw.jsonOk || !raw.initialValid) && MAX_REPAIR > 0) {
    raw.repairRequired = true;
    const errorText = raw.parseError ?? raw.initialError ?? 'validation failed';
    const repairPrompt = buildIntentRepairPrompt(errorText);
    const repairMessages: OllamaMessage[] = [
      ...messages,
      { role: 'assistant', content: first.rawText },
      { role: 'user', content: repairPrompt },
    ];
    const repair = await opts.callOllama(repairMessages);
    lastMetrics = repair.metrics;
    repairRawText = repair.rawText;
    raw.repairRawText = repairRawText;
    const repairParsed = parseIntentJson(repair.rawText);
    raw.repairParsed = repairParsed;
    if (repairParsed !== undefined) {
      finalParsed = repairParsed;
      const rv = validateSemanticIntent(repairParsed);
      finalValidation = rv;
      raw.repairValid = rv.ok;
    }
  }

  const finalMessages: OllamaMessage[] =
    raw.repairRequired && repairRawText !== undefined
      ? [...messages, { role: 'assistant', content: first.rawText }, { role: 'user', content: buildIntentRepairPrompt(raw.initialError ?? 'validation failed') }]
      : messages;

  if (!finalValidation.ok) {
    pipeline.finalValid = false;
    pipeline.finalError = ('error' in finalValidation ? finalValidation.error : 'unknown') as string;
    return { raw, pipeline, finalMessages, metrics: lastMetrics };
  }

  pipeline.finalValid = true;
  pipeline.finalValidatedIntent = finalValidation.intent;

  if (finalValidation.intent.kind === 'chart_action') {
    pipeline.preSanitizeInput = { ...finalValidation.intent };

    const sanitized = structuredClone(finalValidation.intent) as Record<string, unknown>;
    preValidateSanitize(sanitized, opts.prompt.text, requestContext);

    pipeline.preSanitizeOutput = sanitized;
    const postValidation = validateSemanticIntent(sanitized);
    if (!postValidation.ok) {
      pipeline.preSanitizeValid = false;
      pipeline.preSanitizeError = ('error' in postValidation ? postValidation.error : undefined) as string | undefined;
      return { raw, pipeline, finalMessages, metrics: lastMetrics };
    }
    pipeline.preSanitizeValid = true;
    pipeline.finalValidatedIntent = postValidation.intent;

    const resolved = resolveContextReference(postValidation.intent, ctx);
    if (!resolved.ok) {
      pipeline.finalError = resolved.error;
      pipeline.resolvedResult = resolved;
      return { raw, pipeline, finalMessages, metrics: lastMetrics };
    }

    // Apply the same field-level grounding sanitizer used by handleOrionMessage
    // so the benchmark measures the real production end-to-end plan.
    const originalContextReference = (postValidation.intent as ChartActionIntent).contextReference;
    const grounded = sanitizeIntentGrounding(
      resolved.intent,
      opts.prompt.text,
      originalContextReference,
      ctx
    );
    if (!grounded.ok || grounded.intent?.kind !== 'chart_action') {
      pipeline.finalError = grounded.reason ?? 'Grounding sanitizer rejected the intent';
      return { raw, pipeline, finalMessages, metrics: lastMetrics };
    }

    pipeline.resolvedResult = { ...resolved, intent: grounded.intent! };
    pipeline.finalValidatedIntent = grounded.intent!;

    try {
      const plan = compileChartActionIntent(grounded.intent!, {
        anchorDate: resolved.anchorDate ?? state.replayDate,
        stateSymbol: state.symbol || stateSymbol,
        resolvedCandle: resolved.resolvedCandle,
        resolvedCompare: resolved.resolvedCompare,
      });
      pipeline.compiledPlan = plan;
      pipeline.planValidation = validateAgentPlan(plan);
    } catch (e) {
      pipeline.planValidation = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        errorCode: 'INVALID_PLAN',
      };
    }
  } else {
    // clarification/unsupported: no further resolution needed.
    pipeline.preSanitizeValid = true;
    pipeline.preSanitizeOutput = { ...finalValidation.intent };
    pipeline.planValidation = { ok: true };
  }

  return { raw, pipeline, finalMessages, metrics: lastMetrics };
}
