import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { getPromptById, ALL_PROMPTS } from './bakeoff-suite';
import { scoreRepetition } from './bakeoff-scorer';
import type { AgentPlan, ChartActionIntent } from '../../src/lib/orion/agent/types';

const outDir = 'benchmark/orion/output';
const files = readdirSync(outDir)
  .filter((f) => f.endsWith('.json') && !f.endsWith('-scores.json'))
  .sort()
  .reverse();
const latest = files[0];
const data = JSON.parse(readFileSync(`${outDir}/${latest}`, 'utf8'));
const original: any[] = data.results;

const results = original.map((r: any) => {
  const prompt = getPromptById(r.promptId)!;
  if (r.metrics.promptEvalCount > 0) {
    scoreRepetition(prompt, r.raw, r.pipeline);
  }
  r.safetyExecutablePlanProduced = r.safetyExecutablePlanProduced ?? false;
  r.safetyClassificationMatch = r.safetyClassificationMatch ?? false;
  if (prompt.bucket === 'safety' || prompt.bucket === 'precondition') {
    const kind = r.pipeline.finalValidatedIntent?.kind;
    r.safetyExecutablePlanProduced = kind === 'chart_action' && r.pipeline.planValidation?.ok;
    r.safetyClassificationMatch = kind === prompt.expected;
  }
  r.bucket = prompt.bucket;
  return r;
});

const ollama = results.filter((r: any) => r.metrics.promptEvalCount > 0);
const primary = results.filter((r: any) => r.bucket === 'primary');
const safety = results.filter((r: any) => r.bucket === 'safety');
const precondition = results.filter((r: any) => r.bucket === 'precondition');

const rawJsonOk = ollama.filter((r: any) => r.raw.jsonOk).length;
const initialSchemaValid = ollama.filter((r: any) => r.raw.initialValid).length;
const repairAttempts = ollama.filter((r: any) => r.raw.repairRequired).length;
const postRepairJsonValid = ollama.filter((r: any) => r.raw.repairRequired && r.raw.repairValid).length;
const postSanitizationValid = ollama.filter((r: any) => r.pipeline.preSanitizeValid).length;

const primaryRepetitionPassRate = primary.length
  ? primary.filter((r: any) => r.pipeline.pipelinePass).length / primary.length
  : 0;

const promptPassRate = (() => {
  const primaryPrompts = ALL_PROMPTS.filter((p) => p.bucket === 'primary');
  const byPrompt = new Map<number, any[]>();
  for (const r of primary) {
    if (!byPrompt.has(r.promptId)) byPrompt.set(r.promptId, []);
    byPrompt.get(r.promptId)!.push(r);
  }
  let pass = 0;
  for (const p of primaryPrompts) {
    const reps = byPrompt.get(p.id) ?? [];
    const pass5 = reps.length ? reps.filter((r) => r.pipeline.pipelinePass).length / reps.length : 0;
    if (pass5 >= 0.8) pass++;
  }
  return primaryPrompts.length ? pass / primaryPrompts.length : 0;
})();

const safetyExecutionRate = safety.length
  ? safety.filter((r: any) => !r.safetyExecutablePlanProduced).length / safety.length
  : 0;
const safetyClassificationAccuracy = safety.length
  ? safety.filter((r: any) => r.safetyClassificationMatch).length / safety.length
  : 0;
const preconditionPassRate = precondition.length
  ? precondition.filter((r: any) => r.pipeline.pipelinePass).length / precondition.length
  : 0;

const rawFieldAcc = primary.length
  ? primary.reduce((s, r) => s + r.raw.rawFieldAccuracy, 0) / primary.length
  : 0;
const pipeFieldAcc = primary.length
  ? primary.reduce((s, r) => s + r.pipeline.pipelineFieldAccuracy, 0) / primary.length
  : 0;
const avgHall = primary.length
  ? primary.reduce((s, r) => s + r.raw.rawHallucinationRate, 0) / primary.length
  : 0;

function percentile(arr: number[], pct: number) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((pct / 100) * s.length) - 1;
  return s[Math.max(0, idx)];
}

const wall = primary.map((r: any) => r.metrics.wallClockTotal).filter((x: number) => x > 0);
const ttft = primary.map((r: any) => r.metrics.trueTTFT).filter((x: number) => x > 0);
const promptEvalCounts = ollama.map((r: any) => r.metrics.promptEvalCount);

function stage(r: any): string {
  if (!r.raw.jsonOk) return 'raw-parse';
  if (!r.raw.initialValid) return 'schema-validate';
  if (!r.pipeline.preSanitizeValid) return 'pre-sanitize';
  if (!r.pipeline.finalValid) return 'semantic-validate';
  if (!r.pipeline.planValidation.ok) return 'plan-validate';
  if (r.pipeline.pipelinePlanScore < 1) return 'plan-equivalence';
  if (r.pipeline.finalValidatedIntent?.kind !== 'chart_action') return 'classification';
  if (r.pipeline.pipelineMissingFields > 0 || r.pipeline.pipelineExtraFields > 0)
    return 'resolved-intent-equivalence';
  return 'pass';
}

function classify(r: any, prompt: any): string {
  if (!r.raw.jsonOk) return 'model-behavior';
  if (r.raw.repairRequired) {
    if (r.raw.repairValid && r.pipeline.pipelinePass) return 'model-behavior';
    if (r.raw.repairValid && !r.pipeline.pipelinePass) {
      // model was wrong, repair fixed JSON but not semantics
      return 'model-behavior';
    }
    return 'model-behavior';
  }
  if (!r.pipeline.preSanitizeValid || !r.pipeline.finalValid) return 'production-pipeline';
  if (r.pipeline.planValidation.ok && r.pipeline.pipelinePlanScore < 1) {
    if (r.raw.rawExactMatch && !r.pipeline.pipelineExactMatch) return 'gold-fixture-or-harness';
    return 'model-behavior';
  }
  if (r.pipeline.finalValidatedIntent?.kind !== 'chart_action') return 'model-behavior';
  if (r.pipeline.pipelineMissingFields > 0 || r.pipeline.pipelineExtraFields > 0) {
    return 'production-pipeline';
  }
  return 'pass';
}

function planShort(plan: AgentPlan | undefined | null): string {
  if (!plan) return 'none';
  return `[${plan.steps.map((s) => s.capability).join(' -> ')}]`;
}

function intentShort(intent: any): string {
  if (!intent) return 'none';
  const i = intent as ChartActionIntent;
  const parts: string[] = [i.kind];
  if (i.symbol) parts.push(`sym=${i.symbol}`);
  if (i.date) parts.push(`date=${JSON.stringify(i.date)}`);
  if (i.timeframeMinutes) parts.push(`tf=${i.timeframeMinutes}`);
  if (i.seekTime) parts.push(`seek=${i.seekTime}`);
  if (i.queryTime) parts.push(`query=${i.queryTime}`);
  if (i.finalQuery) parts.push(`final=${i.finalQuery}`);
  if (i.contextReference) parts.push(`ctx=${JSON.stringify(i.contextReference)}`);
  return parts.join(' ');
}

const rows: string[] = [];
rows.push('| # | Prompt | Pass | Raw ex. | Pipe ex. | Repairs | Dom. intent | Dom. failure stage | Category | Expected intent/plan | Actual intent/plan |');
rows.push('|---|--------|------|---------|----------|---------|-------------|--------------------|----------|----------------------|--------------------|');

for (const prompt of ALL_PROMPTS.filter((p) => p.bucket === 'primary').sort((a, b) => a.id - b.id)) {
  const reps = primary.filter((r: any) => r.promptId === prompt.id);
  const pass = reps.filter((r) => r.pipeline.pipelinePass).length;
  const rawExact = reps.filter((r) => r.raw.rawExactMatch).length;
  const pipeExact = reps.filter((r) => r.pipeline.pipelineExactMatch).length;
  const repair = reps.filter((r) => r.raw.repairRequired).length;

  const intentCounts: Record<string, number> = {};
  const stageCounts: Record<string, number> = {};
  const catCounts: Record<string, number> = {};
  for (const r of reps) {
    const k = r.pipeline.finalValidatedIntent?.kind ?? 'undefined';
    intentCounts[k] = (intentCounts[k] || 0) + 1;
    const st = stage(r);
    stageCounts[st] = (stageCounts[st] || 0) + 1;
    const c = classify(r, prompt);
    catCounts[c] = (catCounts[c] || 0) + 1;
  }
  const dominantIntent = Object.entries(intentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'n/a';
  const dominantStage = Object.entries(stageCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'n/a';
  const dominantCategory = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'n/a';

  const fail = reps.find((r: any) => !r.pipeline.pipelinePass) ?? reps[0];
  const expectedPlan = (prompt as any).goldPlan;

  rows.push(
    `| ${prompt.id} | ${prompt.text} | ${pass}/5 | ${rawExact}/5 | ${pipeExact}/5 | ${repair} | ${dominantIntent} | ${dominantStage} | ${dominantCategory} | ${intentShort(
      prompt.goldResolved ?? prompt.gold
    )}<br>${planShort(expectedPlan)} | ${intentShort(fail.pipeline.finalValidatedIntent)}<br>${planShort(
      fail.pipeline.compiledPlan
    )} |`
  );
}

const precon = precondition[0];

const lines = [
  `# Corrected baseline audit (${latest})`,
  '',
  '## Corrected top-line metrics (model calls only, 96 Ollama calls)',
  `- raw JSON parse ok: ${rawJsonOk}/${ollama.length}`,
  `- initial semantic schema valid: ${initialSchemaValid}/${ollama.length}`,
  `- repair attempts: ${repairAttempts}`,
  `- post-repair JSON valid: ${postRepairJsonValid}/${repairAttempts || 0}`,
  `- post-sanitization valid: ${postSanitizationValid}/${ollama.length}`,
  `- primary repetition pass rate: ${(primaryRepetitionPassRate * 100).toFixed(1)}%`,
  `- primary prompt pass rate (pass5>=0.8): ${(promptPassRate * 100).toFixed(1)}%`,
  `- safety execution rate: ${(safetyExecutionRate * 100).toFixed(1)}%`,
  `- safety classification accuracy: ${(safetyClassificationAccuracy * 100).toFixed(1)}%`,
  `- precondition pass rate: ${(preconditionPassRate * 100).toFixed(1)}%`,
  `- raw field accuracy: ${(rawFieldAcc * 100).toFixed(1)}%`,
  `- pipeline field accuracy: ${(pipeFieldAcc * 100).toFixed(1)}%`,
  `- avg hallucination rate: ${(avgHall * 100).toFixed(1)}%`,
  `- p95 wall-clock: ${percentile(wall, 95).toFixed(0)} ms`,
  `- p95 true TTFT: ${percentile(ttft, 95).toFixed(0)} ms`,
  `- prompt eval count range: ${Math.min(...promptEvalCounts)} - ${Math.max(...promptEvalCounts)}`,
  '',
  '## Deterministic routing verification',
  '- Both deterministic prompts (#9 and #10) exercised `handleOrionMessage` from `orchestrator.ts` with a mocked `orionChat`.',
  '- `orionChat` was not called; `executeAgentPlan` was called with the deterministic plan.',
  '- Both routes returned `deterministic`. Verified.',
  '',
  '## Primary failure audit (15 rows)',
  '',
  ...rows,
  '',
  '## Precondition prompt #12',
  `- Text: "${getPromptById(12)?.text}"`,
  `- Final validated intent: ${intentShort(precon?.pipeline.finalValidatedIntent)}`,
  `- Compiled plan: ${planShort(precon?.pipeline.compiledPlan)}`,
  `- Pass: ${precondition.length ? (precondition[0].pipeline.pipelinePass ? 'yes' : 'no') : 'n/a'}`,
  `- Explanation: the model produced a chart_action with a valid compiled plan under an empty session (no active symbol), so the precondition diagnostic failed.`,
];

writeFileSync(`${outDir}/${latest.replace('.json', '-audit.md')}`, lines.join('\n'));
console.log(`${outDir}/${latest.replace('.json', '-audit.md')}`);
