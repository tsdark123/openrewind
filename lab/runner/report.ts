import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunSummary, ScenarioResultEnvelope } from './artifact-types.ts';

export interface ReportOptions {
  outboxDir: string;
  summary: RunSummary;
  envelopes: ScenarioResultEnvelope[];
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
      for (const v of turn.violations) {
        lines.push(`- **${v.stage}**: ${v.message}`);
      }
      lines.push('');
    }
  }

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
