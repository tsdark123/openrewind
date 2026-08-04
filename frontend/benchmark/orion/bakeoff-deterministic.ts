import { parseChartCommand } from '../../src/lib/orion/planner';
import { chartCommandToPlan } from '../../src/lib/orion/agent/planner-adapter';
import { validateAgentPlan } from '../../src/lib/orion/agent/validatePlan';
import { comparePlans } from './bakeoff-scorer';
import type { BakeoffPrompt, RepetitionResult } from './types';

export function runDeterministicCheck(
  prompt: BakeoffPrompt,
  model: string,
  availableTickers: string[]
): RepetitionResult {
  const cmd = parseChartCommand(prompt.text, availableTickers, undefined, '');
  const plan = chartCommandToPlan(cmd);

  const raw: RepetitionResult['raw'] = {
    rawText: '[deterministic-routing]',
    jsonOk: false,
    initialValid: false,
    repairRequired: false,
    rawMissingFields: 0,
    rawExtraFields: 0,
    rawFieldAccuracy: 0,
    rawHallucinationRate: 0,
    rawExactMatch: false,
  };

  const planValidation = plan ? validateAgentPlan(plan) : { ok: false, error: 'No deterministic plan.', errorCode: 'INVALID_PLAN' as const };
  const planScore = plan ? comparePlans(plan, plan) : 0;

  const pipeline: RepetitionResult['pipeline'] = {
    preSanitizeValid: false,
    finalValid: false,
    resolvedResult: { ok: true, intent: { kind: 'chart_action' } as any },
    planValidation,
    pipelineMissingFields: 0,
    pipelineExtraFields: 0,
    pipelineFieldAccuracy: 0,
    pipelinePlanScore: planScore,
    pipelineExactMatch: planScore === 1,
    pipelinePass: planValidation.ok && planScore === 1,
  };

  return {
    promptId: prompt.id,
    model,
    repetition: 1,
    metrics: {
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
    },
    raw,
    pipeline,
    safetyExecutablePlanProduced: false,
    safetyClassificationMatch: false,
  };
}
