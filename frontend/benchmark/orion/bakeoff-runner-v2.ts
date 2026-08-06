import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { tickers } from './bakeoff-suite';
import type {
  V2BakeoffPrompt,
  V2RepetitionResult,
  V2PromptScore,
  V2Report,
  V2BakeoffOptions,
} from './bakeoff-types-v2';
import type { AgentContext, AppState, ExecutionContextStore } from '../../src/lib/orion/agent/types';

const BUCKET_REPS: Record<V2BakeoffPrompt['bucket'], number> = {
  primary: 5,
  deterministic: 1,
  precondition: 1,
  safety: 5,
  diagnostic: 1,
};

function getProductionHead(): string {
  try {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function makeBenchmarkAppState(
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

function makeBenchmarkAgentContext(
  store: ExecutionContextStore,
  symbol: string,
  replayDate: string,
  timeframe: number,
  sessionActive: boolean,
  availableTickers: string[]
): AgentContext {
  const state = makeBenchmarkAppState(symbol, replayDate, timeframe, sessionActive);
  const ctx: AgentContext = {
    getState: () => state,
    chartRef: null,
    performanceLog: {},
    apiBase: 'http://127.0.0.1:1',
    availableTickers,
    send: () => {
      throw new Error('Benchmark adapter: send is not wired to an engine.');
    },
    dispatch: () => {
      throw new Error('Benchmark adapter: dispatch is not wired to an engine.');
    },
    onSwitchSymbol: (s, d) => {
      state.symbol = s;
      if (d) state.replayDate = d;
      state.sessionActive = true;
    },
    onMessage: () => {},
    executionLog: store,
  };
  return ctx;
}

export async function runOneRepetitionV2(
  prompt: V2BakeoffPrompt,
  model: string,
  rep: number,
  opts: V2BakeoffOptions
): Promise<V2RepetitionResult> {
  // Ensure the production client resolves the requested model before any
  // orchestrator/client modules are loaded for this repetition.
  (globalThis as typeof globalThis & { process?: { env?: Record<string, string> } }).process!.env!.ORION_AGENT_MODEL = model;

  const [
    { buildExtractionMessages },
    { handleOrionMessage },
    { scoreRepetitionV2, planToChartActionIntent },
  ] = await Promise.all([
    import('./bakeoff-stages'),
    import('../../src/lib/orion/agent/orchestrator'),
    import('./bakeoff-scorer-v2'),
  ]);

  const { store, stateSymbol } = prompt.makeContext();

  const extraction = buildExtractionMessages({
    prompt,
    makeContext: () => ({ store, stateSymbol }),
    availableTickers: tickers,
  });

  const state = extraction.state;
  const ctx = makeBenchmarkAgentContext(
    store,
    state.symbol,
    state.replayDate,
    state.timeframe,
    state.sessionActive,
    tickers
  );

  const orResult = await handleOrionMessage({
    text: prompt.text,
    ctx,
    setupReady: true,
  });

  const compiledPlan = orResult.plan;
  const isError = orResult.route === 'error' || orResult.route === 'aborted';
  const isChart = compiledPlan !== undefined;
  const planOk = !isError && (compiledPlan === undefined || compiledPlan.steps.length > 0);

  const finalValidatedIntent = isChart
    ? planToChartActionIntent(compiledPlan)
    : orResult.route === 'unsupported'
      ? ({ kind: 'unsupported', message: orResult.message } as any)
      : ({ kind: 'clarification', message: orResult.message } as any);

  const raw: V2RepetitionResult['raw'] = {
    rawText: '[production-route]',
    jsonOk: isChart,
    initialValid: isChart,
    repairRequired: false,
    rawMissingFields: 0,
    rawExtraFields: 0,
    rawFieldAccuracy: 0,
    rawHallucinationRate: 0,
    rawExactMatch: false,
    ollamaFinal: { route: orResult.route, wasChat: orResult.wasChat },
  };

  const metrics: V2RepetitionResult['metrics'] = {
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

  const pipeline: V2RepetitionResult['pipeline'] = {
    preSanitizeValid: !isError,
    finalValid: !isError,
    finalValidatedIntent,
    compiledPlan,
    planValidation: { ok: planOk },
    pipelineMissingFields: 0,
    pipelineExtraFields: 0,
    pipelineFieldAccuracy: 0,
    pipelinePlanScore: 0,
    pipelineExactMatch: false,
    pipelinePass: planOk,
  };

  const actualKind = finalValidatedIntent?.kind ?? 'clarification';
  const executableChartPlan = actualKind === 'chart_action' && !isError && planOk;

  const partial: Omit<V2RepetitionResult, 'v2Score'> = {
    promptId: prompt.id,
    model,
    repetition: rep,
    metrics,
    raw,
    pipeline,
    safetyExecutablePlanProduced: executableChartPlan,
    safetyClassificationMatch: actualKind === prompt.expected,
    orchestratorRoute: orResult.route,
  };

  const v2Score = scoreRepetitionV2(prompt, partial as V2RepetitionResult);

  return { ...partial, v2Score };
}

export async function runBakeoffV2(opts: V2BakeoffOptions): Promise<V2Report> {
  (globalThis as typeof globalThis & { process?: { env?: Record<string, string> } }).process!.env!.ORION_AGENT_MODEL = opts.model;

  const [{ ALL_PROMPTS_V2 }, { aggregateV2PromptScores, aggregateV2Scorecard }] = await Promise.all([
    import('./bakeoff-suite-v2'),
    import('./bakeoff-scorer-v2'),
  ]);

  const results: V2RepetitionResult[] = [];
  const promptScores: V2PromptScore[] = [];

  for (const prompt of ALL_PROMPTS_V2) {
    const promptResults: V2RepetitionResult[] = [];
    const reps = opts.repetitions ?? BUCKET_REPS[prompt.bucket];

    for (let i = 0; i < reps; i++) {
      const r = await runOneRepetitionV2(prompt, opts.model, i + 1, opts);
      promptResults.push(r);
      results.push(r);
    }

    promptScores.push(aggregateV2PromptScores(promptResults));
  }

  const productionHead = opts.productionHead ?? getProductionHead();
  const scorecard = aggregateV2Scorecard(results, promptScores, {
    ...opts,
    productionHead,
  });

  const metadata = {
    certificationContractVersion: 'v2.1.1-semantic',
    promptSuiteVersion: 'v2.1.0-22-prompts',
    productionHead,
    modelTag: opts.model,
    modelDigest: opts.modelDigest,
    ollamaVersion: opts.ollamaVersion,
    runtimeOptions: { ...opts, productionHead },
    scorerVersion: 'v2.0.1',
    schemaVersion: 'v2.0.0',
    timestamp: new Date().toISOString(),
    repetitionCount: results.length,
  };

  return {
    metadata,
    results,
    promptScores,
    scorecard,
  };
}

export { BUCKET_REPS };
