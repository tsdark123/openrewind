import type { RepetitionResult, PromptScore, ModelScorecard } from './types';

export function formatScorecard(scorecard: ModelScorecard): string {
  const rawJsonLine =
    scorecard.rawJsonTotal !== undefined
      ? `raw JSON parse ok / model calls:      ${scorecard.rawJsonOk}/${scorecard.rawJsonTotal} (${
          scorecard.rawJsonOk !== undefined ? ((scorecard.rawJsonOk / scorecard.rawJsonTotal) * 100).toFixed(1) : '0'
        }%)`
      : null;

  const lines = [
    `# Orion Model Bake-off: ${scorecard.model}`,
    '',
    `primary repetition pass rate:        ${(scorecard.primaryRepetitionPassRate * 100).toFixed(1)}%`,
    `primary prompt pass rate (pass5>=0.8): ${(scorecard.primaryPromptPassRate * 100).toFixed(1)}%`,
    `safety execution rate:               ${(scorecard.safetyExecutionRate * 100).toFixed(1)}%`,
    `safety classification accuracy:      ${(scorecard.safetyClassificationAccuracy * 100).toFixed(1)}%`,
    `precondition pass rate:              ${(scorecard.preconditionPassRate * 100).toFixed(1)}%`,
    `raw field accuracy:                  ${(scorecard.rawFieldAccuracy * 100).toFixed(1)}%`,
    `pipeline field accuracy:             ${(scorecard.pipelineFieldAccuracy * 100).toFixed(1)}%`,
    `avg hallucination rate:              ${(scorecard.avgHallucinationRate * 100).toFixed(1)}%`,
    `avg tokens/sec:                      ${scorecard.avgTokensPerSecond.toFixed(2)}`,
    `p95 wall-clock (ms):                 ${scorecard.p95WallClock.toFixed(0)}`,
    `p95 true TTFT (ms):                  ${scorecard.p95TrueTTFT.toFixed(0)}`,
  ];

  if (rawJsonLine) lines.push(rawJsonLine);

  if (scorecard.initialSchemaValid !== undefined) {
    lines.push(
      `initial schema valid:                ${scorecard.initialSchemaValid}/${scorecard.rawJsonTotal}`
    );
  }
  if (scorecard.repairAttempts !== undefined) {
    lines.push(`repair attempts:                     ${scorecard.repairAttempts}`);
  }
  if (scorecard.postRepairJsonValid !== undefined) {
    lines.push(`post-repair JSON valid:              ${scorecard.postRepairJsonValid}/${scorecard.repairAttempts}`);
  }
  if (scorecard.postSanitizationValid !== undefined) {
    lines.push(
      `post-sanitization valid:             ${scorecard.postSanitizationValid}/${scorecard.rawJsonTotal}`
    );
  }

  if (scorecard.diagnostic) {
    lines.push('');
    lines.push(`diagnostic prompt #${scorecard.diagnostic.promptId}:`);
    lines.push(`  final intent: ${scorecard.diagnostic.finalIntent}`);
    lines.push(`  compiled plan: ${scorecard.diagnostic.compiledPlan}`);
  }

  lines.push(`recommendation:                      ${scorecard.recommendation}`);

  return lines.join('\n');
}

export function writeResultsJson(
  path: string,
  results: RepetitionResult[],
  options?: Record<string, unknown>,
  scorecard?: ModelScorecard
): string {
  const metadata: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    path,
    count: results.length,
    options: options ?? {},
  };

  if (scorecard) {
    metadata.certificationContractVersion = scorecard.certificationContractVersion;
    metadata.promptSuiteVersion = scorecard.promptSuiteVersion;
    metadata.scorerVersion = scorecard.scorerVersion;
    metadata.schemaVersion = scorecard.schemaVersion;
  }

  const payload: Record<string, unknown> = {
    ...metadata,
    results: results.map((r) => ({
      promptId: r.promptId,
      model: r.model,
      repetition: r.repetition,
      metrics: r.metrics,
      raw: r.raw,
      pipeline: r.pipeline,
      safetyExecutablePlanProduced: r.safetyExecutablePlanProduced,
      safetyClassificationMatch: r.safetyClassificationMatch,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function writePromptScoresJson(_path: string, scores: Map<number, PromptScore>): string {
  const obj: Record<number, PromptScore> = {};
  for (const [k, v] of scores) {
    obj[k] = v;
  }
  return JSON.stringify(obj, null, 2);
}
