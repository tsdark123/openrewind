import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunSummary, ScenarioResultEnvelope, TurnResult } from './artifact-types.ts';

export interface ReportOptions {
  outboxDir: string;
  summary: RunSummary;
  envelopes: ScenarioResultEnvelope[];
}

function violationLines(turn: TurnResult): string[] {
  const lines: string[] = [];
  const first = turn.violations[0];
  if (first) {
    lines.push(`- **First failing stage:** ${first.stage}`);
  }

  if (turn.expectedCapabilities) {
    lines.push(`- **Expected capabilities:** ${turn.expectedCapabilities.join(', ') || '(none)'}`);
  }
  if (turn.capabilities) {
    lines.push(`- **Actual capabilities:** ${turn.capabilities.join(', ') || '(none)'}`);
  }

  const invariants = turn.violations.filter((v) => v.stage === 'grounding' || v.stage === 'final-world-state');
  if (invariants.length > 0) {
    lines.push(`- **Violated exact invariants / final WorldState:**`);
    for (const v of invariants) {
      lines.push(`  - ${v.stage}: ${v.message}`);
      if (v.expected !== undefined) lines.push(`    - expected: ${JSON.stringify(v.expected)}`);
      if (v.actual !== undefined) lines.push(`    - actual: ${JSON.stringify(v.actual)}`);
    }
  }

  const forbidden = turn.violations.filter((v) => v.stage === 'forbidden');
  if (forbidden.length > 0) {
    lines.push(`- **Forbidden side effects:**`);
    for (const v of forbidden) {
      lines.push(`  - ${v.message}`);
      if (v.actual !== undefined) lines.push(`    - actual: ${JSON.stringify(v.actual)}`);
    }
  }

  const context = turn.violations.filter((v) => v.stage.startsWith('context'));
  if (context.length > 0) {
    lines.push(`- **Expected versus actual context:**`);
    for (const v of context) {
      lines.push(`  - ${v.message}`);
      if (v.expected !== undefined) lines.push(`    - expected: ${JSON.stringify(v.expected)}`);
      if (v.actual !== undefined) lines.push(`    - actual: ${JSON.stringify(v.actual)}`);
    }
  }

  const numeric = turn.violations.filter((v) => v.stage === 'numeric' || v.stage === 'consumer-numeric');
  if (numeric.length > 0) {
    lines.push(`- **Numeric mismatches:**`);
    for (const v of numeric) {
      lines.push(`  - ${v.message}`);
      if (v.expected !== undefined) lines.push(`    - expected: ${JSON.stringify(v.expected)}`);
      if (v.actual !== undefined) lines.push(`    - actual: ${JSON.stringify(v.actual)}`);
    }
  }

  if (turn.violations.length > 0) {
    lines.push(`- **All violations:**`);
    for (const v of turn.violations) {
      lines.push(`  - **${v.stage}**: ${v.message}`);
    }
  }

  return lines;
}

function familySummary(envelopes: ScenarioResultEnvelope[]): string[] {
  const fails = envelopes.filter((e) => e.payload.status !== 'pass');
  if (fails.length === 0) return [];

  const byFamily = new Map<string, { count: number; firstStages: Map<string, number>; example: string }>();
  for (const e of fails) {
    const family = e.payload.familyId ?? e.payload.scenarioId;
    const entry = byFamily.get(family) ?? { count: 0, firstStages: new Map<string, number>(), example: e.payload.scenarioId };
    entry.count++;
    for (const turn of e.payload.turns) {
      if (turn.status !== 'pass' && turn.violations.length > 0) {
        const stage = turn.violations[0].stage;
        entry.firstStages.set(stage, (entry.firstStages.get(stage) ?? 0) + 1);
      }
    }
    byFamily.set(family, entry);
  }

  const lines: string[] = [];
  lines.push('## Failure family summary');
  lines.push('');
  lines.push('| Family | Failing scenarios | First-failing stage distribution | Example scenario |');
  lines.push('|--------|-------------------|----------------------------------|------------------|');
  for (const [family, entry] of byFamily.entries()) {
    const stageDist = Array.from(entry.firstStages.entries())
      .map(([stage, count]) => `${stage}: ${count}`)
      .join(', ');
    lines.push(`| ${family} | ${entry.count} | ${stageDist} | ${entry.example} |`);
  }
  lines.push('');
  return lines;
}

export function generateMarkdownReport(opts: ReportOptions): string {
  const { summary, envelopes } = opts;

  const lines: string[] = [];
  lines.push(`# Orion Scenario Lab Report`);
  lines.push('');
  lines.push(`**Run ID:** ${summary.runId}`);
  lines.push(`**Mode:** ${summary.mode}`);
  lines.push(`**Timestamp:** ${summary.timestamp}`);
  lines.push(`**Note:** ${summary.note}`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Scenarios | ${summary.scenarioCount} |`);
  lines.push(`| Pass | ${summary.passCount} |`);
  lines.push(`| Fail | ${summary.failCount} |`);
  lines.push(`| Timeout | ${summary.timeoutCount} |`);
  lines.push(`| Skip | ${summary.skipCount} |`);
  lines.push('');

  for (const envelope of envelopes) {
    const p = envelope.payload;
    lines.push(`## ${p.scenarioId}`);
    lines.push('');
    lines.push(`**Status:** ${p.status}  `);
    if (p.familyId) lines.push(`**Family:** ${p.familyId}  `);
    lines.push(`**Duration:** ${p.durationMs}ms`);
    lines.push('');
    lines.push(`| Turn | Status | Duration | Violations |`);
    lines.push(`|------|--------|----------|------------|`);
    for (const turn of p.turns) {
      lines.push(
        `| ${turn.turnId} | ${turn.status} | ${turn.durationMs ?? '-'}ms | ${turn.violations.length} |`,
      );
    }
    lines.push('');

    for (const turn of p.turns) {
      if (turn.violations.length === 0) continue;
      lines.push(`### ${turn.turnId}: ${turn.utterance}`);
      lines.push('');
      for (const line of violationLines(turn)) {
        lines.push(line);
      }
      lines.push('');
    }
  }

  lines.push(...familySummary(envelopes));

  const report = lines.join('\n');
  const reportPath = path.join(opts.outboxDir, 'report.md');
  fs.writeFileSync(reportPath, report);
  return reportPath;
}

export function loadSummary(outboxDir: string): RunSummary {
  const raw = fs.readFileSync(path.join(outboxDir, 'summary.json'), 'utf8');
  return JSON.parse(raw) as RunSummary;
}

export function loadScenarioEnvelopes(outboxDir: string): ScenarioResultEnvelope[] {
  const lines = fs
    .readFileSync(path.join(outboxDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  const envelopes: ScenarioResultEnvelope[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.type === 'orion.scenario_result') {
      envelopes.push(parsed as ScenarioResultEnvelope);
    }
  }
  return envelopes;
}
