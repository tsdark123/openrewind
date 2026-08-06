import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { callOllamaStreaming, unloadModel, type OllamaMessage } from './bakeoff-ollama';
import { extractAndStage } from './bakeoff-stages';
import { runDeterministicCheck } from './bakeoff-deterministic';
import { ALL_PROMPTS_V2 } from './bakeoff-suite-v2';
import { tickers } from './bakeoff-suite';
import {
  scoreRepetitionV2,
  aggregateV2PromptScores,
  aggregateV2Scorecard,
} from './bakeoff-scorer-v2';
import type {
  V2BakeoffPrompt,
  V2RepetitionResult,
  V2PromptScore,
  V2Report,
  V2BakeoffOptions,
} from './bakeoff-types-v2';

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

async function runOneRepetitionV2(
  prompt: V2BakeoffPrompt,
  model: string,
  rep: number,
  opts: V2BakeoffOptions
): Promise<V2RepetitionResult> {
  const callOllama = async (msgs: OllamaMessage[]) => {
    const res = await callOllamaStreaming({
      model,
      messages: msgs,
      format: 'json',
      numCtx: opts.numCtx ?? 4096,
      numPredict: opts.numPredict ?? 160,
      temperature: opts.temperature ?? 0,
      seed: opts.seed ?? 42,
      think: false,
      keepAlive: '10m',
      stream: true,
    });
    return { rawText: res.rawText, final: res.final, metrics: res.metrics };
  };

  const { raw, pipeline, metrics } = await extractAndStage({
    prompt,
    makeContext: prompt.makeContext,
    availableTickers: tickers,
    callOllama,
  });

  const v2Score = scoreRepetitionV2(prompt, {
    promptId: prompt.id,
    model,
    repetition: rep,
    metrics,
    raw,
    pipeline,
    safetyExecutablePlanProduced: false,
    safetyClassificationMatch: false,
  } as V2RepetitionResult);

  const kind = pipeline.finalValidatedIntent?.kind;
  const executableChartPlan =
    kind === 'chart_action' && pipeline.finalValid && pipeline.planValidation.ok;

  return {
    promptId: prompt.id,
    model,
    repetition: rep,
    metrics,
    raw,
    pipeline,
    safetyExecutablePlanProduced: executableChartPlan,
    safetyClassificationMatch: kind === prompt.expected,
    v2Score,
  };
}

export async function runBakeoffV2(opts: V2BakeoffOptions): Promise<V2Report> {
  const results: V2RepetitionResult[] = [];
  const promptScores: V2PromptScore[] = [];

  for (const prompt of ALL_PROMPTS_V2) {
    const promptResults: V2RepetitionResult[] = [];
    const reps = opts.repetitions ?? BUCKET_REPS[prompt.bucket];

    if (prompt.bucket === 'deterministic') {
      const r = runDeterministicCheck(
        prompt as unknown as import('./types').BakeoffPrompt,
        opts.model,
        tickers
      );
      const v2Score = scoreRepetitionV2(prompt, r as V2RepetitionResult);
      const v2r: V2RepetitionResult = {
        ...r,
        v2Score,
        safetyExecutablePlanProduced: false,
        safetyClassificationMatch: false,
      };
      promptResults.push(v2r);
      results.push(v2r);
    } else {
      for (let i = 0; i < reps; i++) {
        const r = await runOneRepetitionV2(prompt, opts.model, i + 1, opts);
        promptResults.push(r);
        results.push(r);
      }
    }

    promptScores.push(aggregateV2PromptScores(promptResults));
  }

  await unloadModel(opts.model);

  const productionHead = opts.productionHead ?? getProductionHead();
  const scorecard = aggregateV2Scorecard(results, promptScores, {
    ...opts,
    productionHead,
  });

  const metadata = {
    certificationContractVersion: 'v2.0.0-semantic',
    promptSuiteVersion: 'v2.0.0-22-prompts',
    productionHead,
    modelTag: opts.model,
    modelDigest: opts.modelDigest,
    ollamaVersion: opts.ollamaVersion,
    runtimeOptions: { ...opts, productionHead },
    scorerVersion: 'v2.0.0',
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
