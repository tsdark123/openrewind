import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const labDir = path.resolve(__dirname, '..');

describe('fixture dry-run runner', () => {
  it('produces events.jsonl, summary.json and report.md in outbox/fixture-run', () => {
    const outbox = path.resolve(labDir, 'outbox', 'fixture-run');
    if (fs.existsSync(outbox)) {
      fs.rmSync(outbox, { recursive: true, force: true });
    }

    execSync('npx tsx runner/run-fixture.ts', {
      cwd: labDir,
      stdio: 'pipe',
      encoding: 'utf8',
    });

    const eventsPath = path.join(outbox, 'events.jsonl');
    const summaryPath = path.join(outbox, 'summary.json');
    const reportPath = path.join(outbox, 'report.md');

    expect(fs.existsSync(eventsPath)).toBe(true);
    expect(fs.existsSync(summaryPath)).toBe(true);
    expect(fs.existsSync(reportPath)).toBe(true);

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.mode).toBe('fixture');
    expect(summary.note).toMatch(/fixture-mode lab validation/);
    expect(summary.passCount).toBe(summary.scenarioCount);

    const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const scenarios = events.filter((e) => e.type === 'orion.scenario_result');
    expect(scenarios.length).toBe(summary.scenarioCount);
    expect(events.some((e) => e.type === 'orion.run_summary')).toBe(true);

    const report = fs.readFileSync(reportPath, 'utf8');
    expect(report).toContain('fixture-mode lab validation');
  });
});
