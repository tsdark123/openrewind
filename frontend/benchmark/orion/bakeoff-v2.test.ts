import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALL_PROMPTS_V2, getPromptByIdV2 } from './bakeoff-suite-v2';
import {
  scoreRepetitionV2,
  aggregateV2PromptScores,
  aggregateV2Scorecard,
  compareV2Reports,
  planToChartActionIntent,
  V2_CERTIFICATION_POLICY,
} from './bakeoff-scorer-v2';
import { formatV2Scorecard, writeV2ResultsJson } from './bakeoff-report-v2';
import { runOneRepetitionV2 } from './bakeoff-runner-v2';
import type { RepetitionResult } from './types';
import type { V2RepetitionResult, V2Report, V2PromptScore } from './bakeoff-types-v2';

vi.mock('../../src/lib/orion/client', () => ({
  ORION_AGENT_MODEL: 'qwen3:8b',
  AGENT_KEEP_ALIVE: '10m',
  orionChat: vi.fn().mockResolvedValue({ content: '', toolCalls: [], raw: {} }),
}));

vi.mock('../../src/lib/orion/agent/executor', () => ({
  executeAgentPlan: vi.fn().mockResolvedValue({ ok: true, receipts: [] }),
}));

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

  it('routes deterministic prompts #9 and #10 through the production boundary', async () => {
    const prompt9 = getPromptByIdV2(9)!;
    const result9 = await runOneRepetitionV2(prompt9, 'qwen3:8b', 1, { model: 'qwen3:8b' });

    if (!result9.v2Score.pass) {
      // eslint-disable-next-line no-console
      console.log('score9 fail', result9.v2Score.diagnostics, result9.pipeline.compiledPlan?.steps.map((s) => s.capability));
    }
    expect(result9.orchestratorRoute).toBe('deterministic');
    expect(result9.v2Score.pass).toBe(true);
    expect(result9.v2Score.diagnostics.capabilitySetMatch).toBe(true);
    expect(result9.v2Score.diagnostics.timeframeCorrect).toBe(true);

    const prompt10 = getPromptByIdV2(10)!;
    const result10 = await runOneRepetitionV2(prompt10, 'qwen3:8b', 1, { model: 'qwen3:8b' });
    // The production deterministic path routes #10 as a switch+seek, not the
    // V2-expected play_until, so it must be recorded as a fail.
    expect(result10.orchestratorRoute).toBe('deterministic');
    expect(result10.v2Score.pass).toBe(false);
    expect(result10.v2Score.diagnostics.capabilitySetMatch).toBe(false);
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

    expect(scorecard.certificationContractVersion).toBe('v2.1.1-semantic');
    expect(scorecard.promptSuiteVersion).toBe('v2.1.0-22-prompts');
    expect(scorecard.scorerVersion).toBe('v2.0.1');
    expect(scorecard.schemaVersion).toBe('v2.0.0');
    expect(scorecard.modelTag).toBe('qwen3:8b');
    expect(scorecard.ollamaVersion).toBe('0.32.6');
    expect(scorecard.productionHead).toBe('abc123');
    expect(scorecard.repetitionCount).toBe(2);
  });

  it('refuses to compare reports with incompatible certification contract versions', () => {
    const base = (id: string): V2Report => ({
      metadata: {
        certificationContractVersion: 'v2.1.1-semantic',
        promptSuiteVersion: 'v2.1.0-22-prompts',
        productionHead: 'abc123',
        modelTag: 'qwen3:8b',
        modelDigest: 'sha256:abc',
        ollamaVersion: '0.32.6',
        runtimeOptions: { model: 'qwen3:8b' },
        scorerVersion: 'v2.0.1',
        schemaVersion: 'v2.0.0',
        timestamp: new Date().toISOString(),
        repetitionCount: 10,
      },
      results: [],
      promptScores: [],
      scorecard: {
        certificationContractVersion: 'v2.1.1-semantic',
        promptSuiteVersion: 'v2.1.0-22-prompts',
        productionHead: 'abc123',
        modelTag: 'qwen3:8b',
        modelDigest: 'sha256:abc',
        ollamaVersion: '0.32.6',
        runtimeOptions: { model: 'qwen3:8b' },
        scorerVersion: 'v2.0.1',
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
        criticalContextPromptPassRate: 1.0,
        hardcodingAuditPassed: true,
        contextRegressionPassed: true,
        analysisAcceptancePassed: true,
        runtimeAcceptancePassed: true,
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

    // A report produced under the previous v2.1.0 contract is incompatible with
    // the corrected v2.1.1 contract and scorer.
    const oldV2 = base('e');
    oldV2.metadata.certificationContractVersion = 'v2.1.0-semantic';
    oldV2.metadata.promptSuiteVersion = 'v2.1.0-22-prompts';
    oldV2.metadata.scorerVersion = 'v2.0.0';
    oldV2.scorecard.certificationContractVersion = 'v2.1.0-semantic';
    oldV2.scorecard.promptSuiteVersion = 'v2.1.0-22-prompts';
    oldV2.scorecard.scorerVersion = 'v2.0.0';
    expect(compareV2Reports(a, oldV2).compatible).toBe(false);
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

    expect(parsed.metadata.certificationContractVersion).toBe('v2.1.1-semantic');
    expect(parsed.metadata.promptSuiteVersion).toBe('v2.1.0-22-prompts');
    expect(parsed.metadata.productionHead).toBe('abc123');
    expect(parsed.metadata.modelTag).toBe('qwen3:8b');
    expect(parsed.metadata.modelDigest).toBe('sha256:abc');
    expect(parsed.metadata.ollamaVersion).toBe('0.32.6');
    expect(parsed.metadata.scorerVersion).toBe('v2.0.1');
    expect(parsed.metadata.schemaVersion).toBe('v2.0.0');
    expect(parsed.metadata.repetitionCount).toBe(0);

    const md = formatV2Scorecard(scorecard);
    expect(md).toContain('Orion Chapter 2A V2 Certification Scorecard');
    expect(md).toContain('v2.1.1-semantic');
    expect(md).toContain('qwen3:8b');
    expect(md).toContain('sha256:abc');
    expect(md).toContain('0.32.6');
  });

  it('has no deterministic bypass or prompt-ID branches outside fixtures', () => {
    const __filename = fileURLToPath(import.meta.url);
    const dir = path.dirname(__filename);
    const runner = readFileSync(path.join(dir, 'bakeoff-runner-v2.ts'), 'utf-8');
    const scorer = readFileSync(path.join(dir, 'bakeoff-scorer-v2.ts'), 'utf-8');

    expect(runner).not.toContain('runDeterministicCheck');
    expect(runner).not.toContain('extractAndStage');
    expect(runner).not.toContain('chartCommandToPlan');
    expect(runner).not.toContain('parseChartCommand');
    expect(scorer).not.toContain('runDeterministicCheck');
    expect(scorer).not.toContain('chartCommandToPlan');
    expect(scorer).not.toContain('parseChartCommand');

    // Direct prompt-id switches are forbidden; generic lookups like
    // getPromptByIdV2(r.promptId) are still allowed.
    expect(runner).not.toMatch(/prompt\.id\s*===?\s*\d/);
    expect(scorer).not.toMatch(/prompt\.id\s*===?\s*\d/);
  });

  it('drives context setup and relative-seek expectations from fixture metadata', () => {
    const activeIds = new Set([6, 7, 8, 11, 13, 14, 15, 16, 17, 18]);
    for (const prompt of ALL_PROMPTS_V2) {
      const expectedProfile = activeIds.has(prompt.id) ? 'active' : 'empty';
      expect(prompt.profile, `prompt #${prompt.id} profile`).toBe(expectedProfile);
      expect(prompt.makeContext, `prompt #${prompt.id} makeContext`).toBeDefined();

      if (prompt.id === 6) {
        expect(prompt.semanticGold.expectedRelativeSeekMinutes).toBe(-30);
      } else if (prompt.id === 7) {
        expect(prompt.semanticGold.expectedRelativeSeekMinutes).toBe(15);
      } else {
        expect(prompt.semanticGold.expectedRelativeSeekMinutes).toBeUndefined();
      }

      const critical =
        prompt.semanticGold.expectedContextReference != null ||
        prompt.semanticGold.requiredCapabilities.includes('analysis.compare_candles');
      expect(prompt.certificationCritical, `prompt #${prompt.id} certificationCritical`).toBe(critical);
    }
  });

  it('shares the same threshold constants between policy and scorer', () => {
    expect(V2_CERTIFICATION_POLICY.primaryRepetitionPassRate).toBe(0.9);
    expect(V2_CERTIFICATION_POLICY.primaryPromptPassRate).toBe(0.9);
    expect(V2_CERTIFICATION_POLICY.safetyExecutionRate).toBe(1.0);
    expect(V2_CERTIFICATION_POLICY.safetyClassificationAccuracy).toBe(1.0);
    expect(V2_CERTIFICATION_POLICY.preconditionPassRate).toBe(1.0);
    expect(V2_CERTIFICATION_POLICY.deterministicPassRate).toBe(1.0);
    expect(V2_CERTIFICATION_POLICY.criticalContextPromptPassRate).toBe(1.0);
    expect(V2_CERTIFICATION_POLICY.hardcodingAuditPassed).toBe(true);
    expect(V2_CERTIFICATION_POLICY.contextRegressionPassed).toBe(true);
    expect(V2_CERTIFICATION_POLICY.analysisAcceptancePassed).toBe(true);
    expect(V2_CERTIFICATION_POLICY.runtimeAcceptancePassed).toBe(true);
  });

  it('rejects certification when a certification-critical context prompt fails', () => {
    const critical = ALL_PROMPTS_V2.find((p) => p.certificationCritical)!;
    const others = ALL_PROMPTS_V2.filter((p) => !p.certificationCritical && p.expected === 'chart_action').slice(0, 5);

    const results: V2RepetitionResult[] = [];
    const promptScores: V2PromptScore[] = [];

    for (const p of [...others, critical]) {
      const r = makeV2ResultFromGold(p);
      if (p.id === critical.id) {
        r.v2Score = { ...r.v2Score, pass: false };
      }
      results.push(r);
      promptScores.push(aggregateV2PromptScores([r]));
    }

    const scorecard = aggregateV2Scorecard(results, promptScores, {
      model: 'qwen3:8b',
      hardcodingAuditPassed: true,
      contextRegressionPassed: true,
      analysisAcceptancePassed: true,
      runtimeAcceptancePassed: true,
    });

    expect(scorecard.criticalContextPromptPassRate).toBeLessThan(1);
    expect(scorecard.recommendation).toBe('reject');
  });

  it('keeps diagnostic-only results visible but excludes them from certifying pass rates', () => {
    const diagnostic = getPromptByIdV2(10)!;
    expect(diagnostic.diagnosticOnly).toBe(true);

    const prompt9 = getPromptByIdV2(9)!;
    const diagnosticResult = makeV2ResultFromGold(diagnostic);
    diagnosticResult.v2Score = {
      pass: false,
      classificationMatch: false,
      diagnostics: diagnosticResult.v2Score.diagnostics,
    };

    const results: V2RepetitionResult[] = [makeV2ResultFromGold(prompt9), diagnosticResult];
    const promptScores = results.map((r) => aggregateV2PromptScores([r]));

    const scorecard = aggregateV2Scorecard(results, promptScores, {
      model: 'qwen3:8b',
      hardcodingAuditPassed: true,
      contextRegressionPassed: true,
      analysisAcceptancePassed: true,
      runtimeAcceptancePassed: true,
    });

    expect(scorecard.deterministicPassRate).toBe(1.0);
    expect(scorecard.diagnosticPassRate).toBeLessThan(1);
    expect(scorecard.recommendation).toBe('proceed');
  });

  it('rejects certification when hardcoding-audit or context-regression gates fail', () => {
    const prompt = getPromptByIdV2(1)!;
    const results = [makeV2ResultFromGold(prompt)];
    const promptScores = [aggregateV2PromptScores(results)];

    const run = (audit: boolean, reg: boolean) =>
      aggregateV2Scorecard(results, promptScores, {
        model: 'qwen3:8b',
        hardcodingAuditPassed: audit,
        contextRegressionPassed: reg,
        analysisAcceptancePassed: true,
        runtimeAcceptancePassed: true,
      }).recommendation;

    expect(run(true, true)).toBe('proceed');
    expect(run(false, true)).toBe('reject');
    expect(run(true, false)).toBe('reject');
  });

  describe('compare_candles scorer rejects non-matching concrete snapshots', () => {
    const prompt = getPromptByIdV2(17)!;
    const goldPlan = prompt.resolvedGoldPlan;

    function buildResultWithComparePlan(comparePlan: typeof goldPlan) {
      const base = makeResultFromGold(prompt, {
        pipeline: {
          ...makeResultFromGold(prompt).pipeline,
          compiledPlan: comparePlan,
        },
      });
      return scoreRepetitionV2(prompt, base);
    }

    it('passes when the compiled compare plan matches the resolved gold snapshots', () => {
      const score = buildResultWithComparePlan(goldPlan);
      expect(score.pass).toBe(true);
      expect(score.diagnostics.analysisRequestsCorrect).toBe(true);
    });

    it('rejects swapped left/right snapshots', () => {
      if (!goldPlan) throw new Error('goldPlan missing');
      const compareStep = goldPlan.steps.find((s) => s.capability === 'analysis.compare_candles')!;
      const swapped = {
        ...goldPlan,
        steps: [
          {
            ...compareStep,
            args: {
              left: compareStep.args.right,
              right: compareStep.args.left,
            },
          },
        ],
      };
      const score = buildResultWithComparePlan(swapped as any);
      expect(score.pass).toBe(false);
      expect(score.diagnostics.analysisRequestsCorrect).toBe(false);
    });

    it('rejects duplicate snapshots on both sides', () => {
      if (!goldPlan) throw new Error('goldPlan missing');
      const compareStep = goldPlan.steps.find((s) => s.capability === 'analysis.compare_candles')!;
      const duplicate = {
        ...goldPlan,
        steps: [
          {
            ...compareStep,
            args: {
              left: compareStep.args.left,
              right: compareStep.args.left,
            },
          },
        ],
      };
      const score = buildResultWithComparePlan(duplicate as any);
      expect(score.pass).toBe(false);
      expect(score.diagnostics.analysisRequestsCorrect).toBe(false);
    });

    it('rejects a compare side with a wrong snapshot id', () => {
      if (!goldPlan) throw new Error('goldPlan missing');
      const compareStep = goldPlan.steps.find((s) => s.capability === 'analysis.compare_candles')!;
      const wrong = {
        ...goldPlan,
        steps: [
          {
            ...compareStep,
            args: {
              left: { ...(compareStep.args.left as any), snapshotId: 999 },
              right: compareStep.args.right,
            },
          },
        ],
      };
      const score = buildResultWithComparePlan(wrong as any);
      expect(score.pass).toBe(false);
      expect(score.diagnostics.analysisRequestsCorrect).toBe(false);
    });

    it('rejects a compare side that references the live chart instead of a snapshot', () => {
      if (!goldPlan) throw new Error('goldPlan missing');
      const compareStep = goldPlan.steps.find((s) => s.capability === 'analysis.compare_candles')!;
      const live = {
        ...goldPlan,
        steps: [
          {
            ...compareStep,
            args: {
              left: { source: 'chart' },
              right: compareStep.args.right,
            },
          },
        ],
      };
      const score = buildResultWithComparePlan(live as any);
      expect(score.pass).toBe(false);
      expect(score.diagnostics.analysisRequestsCorrect).toBe(false);
    });
  });
});
