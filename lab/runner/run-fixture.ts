/**
 * Fixture-mode scenario runner.
 *
 * Loads a manifest of scenario files, replays explicit fixture agent responses,
 * and writes events.jsonl, summary.json and report.md.
 *
 * This validates lab machinery without Ollama, the engine, or Tauri.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ScenarioRunner } from './scenario-runner.ts';
import { FixtureEngineAdapter } from './adapters/engine-adapter.ts';
import { FixtureAgentAdapter } from './adapters/fixture-agent.ts';
import { loadScenario } from './scenario-validator.ts';
import { generateMarkdownReport } from './report.ts';

interface RunFixtureOptions {
  manifest: string;
  responses: string;
  outbox: string;
  runId?: string;
}

function parseArgs(): RunFixtureOptions {
  const args = process.argv.slice(2);
  const manifest = getArg(args, '--manifest') ?? path.resolve(import.meta.dirname ?? '.', '..', 'tests', 'fixtures', 'smoke-manifest.json');
  const responses = getArg(args, '--responses') ?? path.resolve(import.meta.dirname ?? '.', '..', 'tests', 'fixtures', 'smoke-responses.json');
  const outbox = getArg(args, '--outbox') ?? path.resolve(import.meta.dirname ?? '.', '..', 'outbox', 'fixture-run');
  const runId = getArg(args, '--run-id');

  if (!fs.existsSync(manifest)) {
    throw new Error(`Manifest not found: ${manifest}`);
  }
  if (!fs.existsSync(responses)) {
    throw new Error(`Responses fixture not found: ${responses}`);
  }

  return { manifest, responses, outbox, runId };
}

function getArg(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  const opts = parseArgs();
  const manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf8')) as { scenarios: string[] };
  const scenarios = manifest.scenarios.map((p) => loadScenario(p));

  const engine = new FixtureEngineAdapter();
  const agent = new FixtureAgentAdapter({ fixturePath: opts.responses });

  const runner = new ScenarioRunner({
    runId: opts.runId ?? `fixture-${Date.now()}`,
    mode: 'fixture',
    agentAdapter: agent,
    engineAdapter: engine,
    outboxDir: opts.outbox,
  });

  const { summary, scenarioEnvelopes } = await runner.runScenarios(scenarios);
  const reportPath = generateMarkdownReport({
    outboxDir: opts.outbox,
    summary,
    envelopes: scenarioEnvelopes,
  });

  console.log(`Fixture run complete.`);
  console.log(`  Outbox:  ${opts.outbox}`);
  console.log(`  Report:  ${reportPath}`);
  console.log(`  Status:  ${summary.passCount}/${summary.scenarioCount} passed`);

  if (summary.failCount > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
