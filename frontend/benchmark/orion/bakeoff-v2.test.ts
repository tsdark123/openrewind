import { describe, it, expect } from 'vitest';
import { ALL_PROMPTS_V2, getPromptByIdV2 } from './bakeoff-suite-v2';
import {
  scoreRepetitionV2,
  aggregateV2PromptScores,
  aggregateV2Scorecard,
  compareV2Reports,
} from './bakeoff-scorer-v2';
import { formatV2Scorecard, writeV2ResultsJson } from './bakeoff-report-v2';
import { runDeterministicCheck } from './bakeoff-deterministic';
import type { RepetitionResult } from './types';
import type { V2RepetitionResult, V2Report } from './bakeoff-types-v2';

function zeroMetrics(): RepetitionResult['metrics'] {
  return {
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
}

function zeroRaw(): RepetitionResult['raw'] {
  return {
    rawText: '',
    jsonOk: false,
    initialValid: false,
    repairRequired: false,
    rawMissingFields: 0,
    rawExtraFields: 0,
    rawFieldAccuracy: 0,
    rawHallucinationRate: 0,
    rawExactMatch: false,
  };
}

function makeResultFromGold(prompt: (typeof ALL_PROMPTS_V2)[number], overrides: Partial<RepetitionResult> = {}): RepetitionResult {
  const pipeline: RepetitionResult['pipeline'] = {
    preSanitizeValid: true,
    finalValid: true,
    finalValidatedIntent: prompt.resolvedGold,
    resolvedResult: { ok: true, intent: prompt.resolvedGold ?? { kind: 'chart_action' } },
    compiledPlan: prompt.resolvedGoldPlan,
    planValidation: { ok: true },
    pipelineMissingFields: 0,
    pipelineExtraFields: 0,
    pipelineFieldAccuracy: 1,
    pipelinePlanScore: 1,
    pipelineExactMatch: true,
    pipelinePass: true,
  };
  return {
    promptId: prompt.id,
    model: 'self-test',
    repetition: 1,
    metrics: zeroMetrics(),
    raw: zeroRaw(),
    pipeline,
    safetyExecutablePlanProduced: false,
    safetyClassificationMatch: false,
    ...overrides,
  };
}

function makeV2ResultFromGold(prompt: (typeof ALL_PROMPTS_V2)[number], overrides: Partial<RepetitionResult> = {}): V2RepetitionResult {
  const base = makeResultFromGold(prompt, overrides);
  return {
    ...base,
    v2Score: scoreRepetitionV2(prompt, base),
  };
}

describe('Orion Chapter 2A V2 certification contract', () => {
  it('loads all 22 prompts and every chart-action prompt has a resolved gold plan', () => {
    expect(ALL_PROMPTS_V2).toHaveLength(22);
    const ids = ALL_PROMPTS_V2.map((p) => p.id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));

    for (const prompt of ALL_PROMPTS_V2) {
      if (prompt.expected === 'chart_action') {
        expect(prompt.resolvedGold, `prompt #${prompt.id} resolvedGold`).toBeDefined();
        expect(prompt.resolvedGoldPlan, `prompt #${prompt.id} resolvedGoldPlan`).toBeDefined();
        expect(prompt.resolvedCapabilitySet, `prompt #${prompt.id} resolvedCapabilitySet`).toBeDefined();
      }
    }
  });

  it('self-scores every chart-action prompt against its own resolved gold as a pass', () => {
    for (const prompt of ALL_PROMPTS_V2) {
      if (prompt.expected !== 'chart_action') continue;
      const result = makeV2ResultFromGold(prompt);
      expect(result.v2Score.pass, `prompt #${prompt.id} should pass on its own gold`).toBe(true);
      expect(result.v2Score.diagnostics.capabilitySetMatch, `prompt #${prompt.id} capability set`).toBe(true);
    }
  });

  it('accepts semantically-equivalent routes for prompts that list alternatives', () => {
    const prompt = getPromptByIdV2(1);
    expect(prompt).toBeDefined();
    if (!prompt || prompt.expected !== 'chart_action') return;

    // Prompt #1 canonical: seek_to_time + get_current_candle.
    // Acceptable alternative: switch to the same setup and directly read the
    // candle at 11:15 (get_candle_at_time).
    const altPlan = {
      id: 'plan-alt-1',
      kind: 'mixed' as const,
      summary: 'Switch + direct candle-at-time',
      steps: [
        { id: 'r1', capability: 'session.resolve_symbol', args: { name: 'NVDA' }, required: true },
        { id: 'r2', capability: 'session.resolve_trading_date', args: { symbol: { $ref: 'r1', path: 'symbol' }, input: { kind: 'relative_trading', sessions: 1, direction: 'backward', from: '2026-07-31' } }, required: true, dependsOn: ['r1'] },
        { id: 'r3', capability: 'session.switch_symbol', args: { symbol: { $ref: 'r1' }, date: { $ref: 'r2' } }, required: true, dependsOn: ['r2'] },
        { id: 'r4', capability: 'chart.set_timeframe', args: { timeframe: 15 }, required: true },
        { id: 'r5', capability: 'chart.get_candle_at_time', args: { time: '11:15' }, required: false },
      ],
    };

    const altIntent = {
      kind: 'chart_action' as const,
      symbol: 'NVDA',
      date: { kind: 'relative_trading' as const, count: 1, direction: 'backward' as const },
      timeframeMinutes: 15,
      queryTime: '11:15',
      finalQuery: 'candle_at_time' as const,
    };

    const result = makeV2ResultFromGold(prompt, {
      pipeline: {
        ...makeResultFromGold(prompt).pipeline,
        finalValidatedIntent: altIntent,
        compiledPlan: altPlan,
      },
    });

    expect(result.v2Score.pass, 'alternative route for #1 should pass').toBe(true);
    expect(result.v2Score.diagnostics.marketTimeCorrect).toBe(true);
  });

  it('rejects an incorrect market time even when the capability set matches', () => {
    const prompt = getPromptByIdV2(1);
    expect(prompt).toBeDefined();
    if (!prompt || prompt.expected !== 'chart_action') return;

    const badPlan = {
      id: 'plan-bad-1',
      kind: 'mixed' as const,
      summary: 'Wrong time',
      steps: [
        { id: 'r1', capability: 'session.resolve_symbol', args: { name: 'NVDA' }, required: true },
        { id: 'r2', capability: 'session.resolve_trading_date', args: { symbol: { $ref: 'r1' }, input: { kind: 'relative_trading', sessions: 1, direction: 'backward', from: '2026-07-31' } }, required: true, dependsOn: ['r1'] },
        { id: 'r3', capability: 'session.switch_symbol', args: { symbol: { $ref: 'r1' }, date: { $ref: 'r2' } }, required: true, dependsOn: ['r2'] },
        { id: 'r4', capability: 'chart.set_timeframe', args: { timeframe: 15 }, required: true },
        { id: 'r5', capability: 'playback.seek_to_time', args: { time: '11:30' }, required: true },
        { id: 'r6', capability: 'chart.get_current_candle', args: {}, required: false },
      ],
    };

    const badIntent = {
      kind: 'chart_action' as const,
      symbol: 'NVDA',
      date: { kind: 'relative_trading' as const, count: 1, direction: 'backward' as const },
      timeframeMinutes: 15,
      seekTime: '11:30',
      finalQuery: 'current_candle' as const,
    };

    const result = makeV2ResultFromGold(prompt, {
      pipeline: {
        ...makeResultFromGold(prompt).pipeline,
        finalValidatedIntent: badIntent,
        compiledPlan: badPlan,
      },
    });

    expect(result.v2Score.pass).toBe(false);
    expect(result.v2Score.diagnostics.marketTimeCorrect).toBe(false);
  });

  it('rejects a chart_action for safety prompts that expect clarification or unsupported', () => {
    for (const prompt of ALL_PROMPTS_V2) {
      if (prompt.bucket !== 'safety') continue;

      const executable: RepetitionResult = {
        ...makeResultFromGold(prompt),
        pipeline: {
          ...makeResultFromGold(prompt).pipeline,
          finalValid: true,
          planValidation: { ok: true },
          finalValidatedIntent: { kind: 'chart_action', symbol: 'AAPL' },
          compiledPlan: {
            id: 'plan-unsafe',
            kind: 'mixed',
            summary: 'unsafe',
            steps: [{ id: 's1', capability: 'session.resolve_symbol', args: { name: 'AAPL' }, required: true }],
          },
        },
      };

      const score = scoreRepetitionV2(prompt, executable);
      expect(score.pass, `safety prompt #${prompt.id} must reject executable chart_action`).toBe(false);
      expect(score.classificationMatch).toBe(false);

      const benign: RepetitionResult = {
        ...makeResultFromGold(prompt),
        pipeline: {
          ...makeResultFromGold(prompt).pipeline,
          finalValid: true,
          planValidation: { ok: true },
          finalValidatedIntent: { kind: prompt.expected },
          compiledPlan: undefined,
        },
      };

      const benignScore = scoreRepetitionV2(prompt, benign);
      expect(benignScore.pass, `safety prompt #${prompt.id} should accept expected ${prompt.expected}`).toBe(true);
      expect(benignScore.classificationMatch).toBe(true);
    }
  });

  it('rejects forbidden capabilities and duplicate conflicting capabilities', () => {
    const prompt = getPromptByIdV2(7);
    expect(prompt).toBeDefined();
    if (!prompt || prompt.expected !== 'chart_action') return;

    // Prompt #7 must only contain playback.seek_relative.
    const badPlan = {
      id: 'plan-bad-7',
      kind: 'action' as const,
      summary: 'seek + extra query',
      steps: [
        { id: 'r1', capability: 'playback.seek_relative', args: { minutes: 15 }, required: true },
        { id: 'r2', capability: 'chart.get_current_candle', args: {}, required: false },
      ],
    };

    const result = makeV2ResultFromGold(prompt, {
      pipeline: {
        ...makeResultFromGold(prompt).pipeline,
        finalValidatedIntent: {
          kind: 'chart_action' as const,
          relativeSeekMinutes: 15,
          finalQuery: 'current_candle',
        },
        compiledPlan: badPlan,
      },
    });

    expect(result.v2Score.pass).toBe(false);
    expect(result.v2Score.diagnostics.capabilitySetMatch).toBe(false);
  });

  it('rejects context-reference inheritance failures', () => {
    const prompt = getPromptByIdV2(15);
    expect(prompt).toBeDefined();
    if (!prompt || prompt.expected !== 'chart_action') return;

    // Prompt #15: inherit timeframe (15m) and switch to prior session.
    // Wrong timeframe should fail.
    const badPlan = {
      id: 'plan-bad-15',
      kind: 'action' as const,
      summary: 'wrong tf',
      steps: [
        { id: 'r1', capability: 'session.resolve_symbol', args: { name: 'NVDA' }, required: true },
        { id: 'r2', capability: 'session.resolve_trading_date', args: { symbol: { $ref: 'r1' }, input: { kind: 'relative_trading', sessions: 1, direction: 'backward', from: '2026-07-31' } }, required: true, dependsOn: ['r1'] },
        { id: 'r3', capability: 'session.switch_symbol', args: { symbol: { $ref: 'r1' }, date: { $ref: 'r2' } }, required: true, dependsOn: ['r2'] },
        { id: 'r4', capability: 'chart.set_timeframe', args: { timeframe: 5 }, required: true },
      ],
    };

    const badIntent = {
      kind: 'chart_action' as const,
      symbol: 'NVDA',
      date: { kind: 'relative_trading' as const, count: 1, direction: 'backward' as const },
      timeframeMinutes: 5,
    };

    const result = makeV2ResultFromGold(prompt, {
      pipeline: {
        ...makeResultFromGold(prompt).pipeline,
        finalValidatedIntent: badIntent,
        compiledPlan: badPlan,
      },
    });

    expect(result.v2Score.pass).toBe(false);
    expect(result.v2Score.diagnostics.timeframeCorrect).toBe(false);
  });

  it('scores deterministic prompt #9 as a pass and #10 as a known fail', () => {
    const prompt9 = getPromptByIdV2(9)!;
    const result9 = runDeterministicCheck(prompt9 as unknown as import('./types').BakeoffPrompt, 'deterministic', [
      'AAPL',
      'MSFT',
      'NVDA',
    ]);
    const score9 = scoreRepetitionV2(prompt9, result9 as V2RepetitionResult);
    if (!score9.pass) {
      // eslint-disable-next-line no-console
      console.log('score9 fail', score9.diagnostics, result9.pipeline.compiledPlan?.steps.map((s) => s.capability));
    }
    expect(score9.pass).toBe(true);
    expect(score9.diagnostics.capabilitySetMatch).toBe(true);
    expect(score9.diagnostics.timeframeCorrect).toBe(true);

    const prompt10 = getPromptByIdV2(10)!;
    const result10 = runDeterministicCheck(prompt10 as unknown as import('./types').BakeoffPrompt, 'deterministic', [
      'AAPL',
      'MSFT',
      'NVDA',
    ]);
    const score10 = scoreRepetitionV2(prompt10, result10 as V2RepetitionResult);
    // The deterministic parser currently routes #10 as a fast-forward/switch
    // without the canonical play_until, so the V2 scorer rightfully fails it.
    expect(score10.pass).toBe(false);
  });

  it('aggregates prompt and scorecard metadata with version fields', () => {
    const prompt = getPromptByIdV2(1)!;
    const results: V2RepetitionResult[] = [
      { ...makeV2ResultFromGold(prompt), v2Score: scoreRepetitionV2(prompt, makeResultFromGold(prompt)) },
      { ...makeV2ResultFromGold(prompt), v2Score: scoreRepetitionV2(prompt, makeResultFromGold(prompt)) },
    ];

    const promptScore = aggregateV2PromptScores(results);
    expect(promptScore.promptId).toBe(1);
    expect(promptScore.pass5).toBe(1);

    const scorecard = aggregateV2Scorecard(results, [promptScore], {
      model: 'qwen3:8b',
      productionHead: 'abc123',
      ollamaVersion: '0.32.6',
    });

    expect(scorecard.certificationContractVersion).toBe('v2.0.0-semantic');
    expect(scorecard.promptSuiteVersion).toBe('v2.0.0-22-prompts');
    expect(scorecard.scorerVersion).toBe('v2.0.0');
    expect(scorecard.schemaVersion).toBe('v2.0.0');
    expect(scorecard.modelTag).toBe('qwen3:8b');
    expect(scorecard.ollamaVersion).toBe('0.32.6');
    expect(scorecard.productionHead).toBe('abc123');
    expect(scorecard.repetitionCount).toBe(2);
  });

  it('refuses to compare reports with incompatible certification contract versions', () => {
    const base = (id: string): V2Report => ({
      metadata: {
        certificationContractVersion: 'v2.0.0-semantic',
        promptSuiteVersion: 'v2.0.0-22-prompts',
        productionHead: 'abc123',
        modelTag: 'qwen3:8b',
        modelDigest: 'sha256:abc',
        ollamaVersion: '0.32.6',
        runtimeOptions: { model: 'qwen3:8b' },
        scorerVersion: 'v2.0.0',
        schemaVersion: 'v2.0.0',
        timestamp: new Date().toISOString(),
        repetitionCount: 10,
      },
      results: [],
      promptScores: [],
      scorecard: {
        certificationContractVersion: 'v2.0.0-semantic',
        promptSuiteVersion: 'v2.0.0-22-prompts',
        productionHead: 'abc123',
        modelTag: 'qwen3:8b',
        modelDigest: 'sha256:abc',
        ollamaVersion: '0.32.6',
        runtimeOptions: { model: 'qwen3:8b' },
        scorerVersion: 'v2.0.0',
        schemaVersion: 'v2.0.0',
        timestamp: new Date().toISOString(),
        repetitionCount: 10,
        model: 'qwen3:8b',
        primaryRepetitionPassRate: 0.9,
        primaryPromptPassRate: 0.8,
        safetyExecutionRate: 1.0,
        safetyClassificationAccuracy: 1.0,
        preconditionPassRate: 1.0,
        diagnosticPassRate: 1.0,
        deterministicPassRate: 1.0,
        recommendation: 'proceed',
      },
    });

    const a = base('a');
    const b = base('b');
    expect(compareV2Reports(a, b).compatible).toBe(true);

    const differentContract = base('c');
    differentContract.metadata.certificationContractVersion = 'legacy-v1';
    expect(compareV2Reports(a, differentContract).compatible).toBe(false);

    const differentModel = base('d');
    differentModel.metadata.modelTag = 'qwen3:4b';
    differentModel.metadata.productionHead = 'def456';
    expect(compareV2Reports(a, differentModel).compatible).toBe(true);
  });

  it('writes a V2 report with all required metadata fields', () => {
    const scorecard = aggregateV2Scorecard([], [], {
      model: 'qwen3:8b',
      productionHead: 'abc123',
      ollamaVersion: '0.32.6',
      modelDigest: 'sha256:abc',
    });

    const report: V2Report = {
      metadata: { ...scorecard, runtimeOptions: { model: 'qwen3:8b' } },
      results: [],
      promptScores: [],
      scorecard,
    };

    const json = writeV2ResultsJson('test.json', report);
    const parsed = JSON.parse(json);

    expect(parsed.metadata.certificationContractVersion).toBe('v2.0.0-semantic');
    expect(parsed.metadata.promptSuiteVersion).toBe('v2.0.0-22-prompts');
    expect(parsed.metadata.productionHead).toBe('abc123');
    expect(parsed.metadata.modelTag).toBe('qwen3:8b');
    expect(parsed.metadata.modelDigest).toBe('sha256:abc');
    expect(parsed.metadata.ollamaVersion).toBe('0.32.6');
    expect(parsed.metadata.scorerVersion).toBe('v2.0.0');
    expect(parsed.metadata.schemaVersion).toBe('v2.0.0');
    expect(parsed.metadata.repetitionCount).toBe(0);

    const md = formatV2Scorecard(scorecard);
    expect(md).toContain('Orion Chapter 2A V2 Certification Scorecard');
    expect(md).toContain('v2.0.0-semantic');
    expect(md).toContain('qwen3:8b');
    expect(md).toContain('sha256:abc');
    expect(md).toContain('0.32.6');
  });
});
