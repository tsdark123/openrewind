import type { V2Report, V2ModelScorecard, V2PromptScore } from './bakeoff-types-v2';

export function formatV2Scorecard(scorecard: V2ModelScorecard): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  const lines = [
    '# Orion Chapter 2A V2 Certification Scorecard',
    '',
    `**Model**: ${scorecard.model}`,
    `**Contract**: ${scorecard.certificationContractVersion}`,
    `**Prompt suite**: ${scorecard.promptSuiteVersion}`,
    `**Scorer**: ${scorecard.scorerVersion}`,
    `**Schema**: ${scorecard.schemaVersion}`,
    `**Production HEAD**: \`${scorecard.productionHead}\``,
    `**Model tag**: ${scorecard.modelTag}`,
    scorecard.modelDigest ? `**Model digest**: ${scorecard.modelDigest}` : null,
    scorecard.ollamaVersion ? `**Ollama version**: ${scorecard.ollamaVersion}` : null,
    `**Timestamp**: ${scorecard.timestamp}`,
    `**Repetition count**: ${scorecard.repetitionCount}`,
    '',
    '## Pass rates',
    '',
    `| Metric | Value |`,
    `|---|---|`,
    `| Primary repetition pass rate | ${pct(scorecard.primaryRepetitionPassRate)} |`,
    `| Primary prompt pass rate | ${pct(scorecard.primaryPromptPassRate)} |`,
    `| Safety execution rate | ${pct(scorecard.safetyExecutionRate)} |`,
    `| Safety classification accuracy | ${pct(scorecard.safetyClassificationAccuracy)} |`,
    `| Precondition pass rate | ${pct(scorecard.preconditionPassRate)} |`,
    `| Diagnostic pass rate | ${pct(scorecard.diagnosticPassRate)} |`,
    `| Deterministic pass rate | ${pct(scorecard.deterministicPassRate)} |`,
    '',
    `**Recommendation**: ${scorecard.recommendation}`,
    '',
    '## Runtime options',
    '',
    '```json',
    JSON.stringify(scorecard.runtimeOptions, null, 2),
    '```',
  ];

  return lines.filter((l) => l !== null).join('\n');
}

function formatPromptScore(score: V2PromptScore): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return `| ${score.promptId} | ${score.bucket} | ${pct(score.pass5)} | ${score.passed}/${score.total} | ${pct(score.classificationMatchRate)} |`;
}

export function writeV2ResultsJson(_path: string, report: V2Report): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      metadata: report.metadata,
      promptScores: report.promptScores,
      scorecard: report.scorecard,
      results: report.results,
    },
    null,
    2
  );
}

export function writeV2ReportMd(_path: string, report: V2Report): string {
  const lines = [
    formatV2Scorecard(report.scorecard),
    '',
    '## Prompt scores',
    '',
    `| Prompt | Bucket | Pass5 | Passed/Total | Classification |`,
    `|---|---|---|---|---|`,
    ...report.promptScores.map(formatPromptScore),
    '',
    '## Repetition summary',
    '',
    `Total repetitions: ${report.results.length}`,
    `Passed: ${report.results.filter((r) => r.v2Score.pass).length}`,
    `Failed: ${report.results.filter((r) => !r.v2Score.pass).length}`,
  ];

  return lines.join('\n');
}
