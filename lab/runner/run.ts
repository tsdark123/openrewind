/**
 * Generic scenario runner used by the Windows orchestrator.
 *
 * `--mode fixture` runs with the fixture engine/agent adapters.
 *
 * `--mode production` requires an adapter module that exports:
 *   - createProductionAgentAdapter(engineUrl: string, initialWorldState: unknown): Promise<AgentAdapter>
 *   - createProductionEngineAdapter(engineUrl: string): Promise<EngineAdapter>
 * supplied via `--adapter-module <path>` or `ORION_LAB_PRODUCTION_ADAPTER_MODULE`.
 *
 * V1 ships a fixture-mode implementation. Production mode is intentionally
 * left as an extension point because a fully headless production AgentContext
 * requires the Windows OpenRewind runtime (React/Tauri/browser state).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ScenarioRunner } from './scenario-runner.ts';
import { FixtureEngineAdapter } from './adapters/engine-adapter.ts';
import { FixtureAgentAdapter } from './adapters/fixture-agent.ts';
import { loadScenario } from './scenario-validator.ts';
import { generateMarkdownReport } from './report.ts';
import type { AgentAdapter } from './adapters/agent-adapter.ts';
import type { EngineAdapter } from './adapters/engine-adapter.ts';

interface CliOptions {
  mode: 'fixture' | 'production';
  manifest: string;
  outbox: string;
  engineUrl: string;
  ollamaUrl: string;
  model: string;
  runId: string;
  adapterModule?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const mode = (getArg(args, '--mode') as 'fixture' | 'production') ?? 'fixture';
  const manifest = getArg(args, '--manifest');
  const outbox = getArg(args, '--outbox');
  const engineUrl = getArg(args, '--engine-url') ?? 'http://127.0.0.1:19000';
  const ollamaUrl = getArg(args, '--ollama-url') ?? 'http://127.0.0.1:11434';
  const model = getArg(args, '--model') ?? 'qwen3:8b';
  const runId = getArg(args, '--run-id') ?? `run-${Date.now()}`;
  const adapterModule = getArg(args, '--adapter-module') ?? process.env.ORION_LAB_PRODUCTION_ADAPTER_MODULE;

  if (!manifest || !outbox) {
    throw new Error('Usage: run.ts --mode <fixture|production> --manifest <path> --outbox <dir> [--engine-url ...] [--ollama-url ...] [--model ...] [--run-id ...] [--adapter-module ...]');
  }

  if (!fs.existsSync(manifest)) {
    throw new Error(`Manifest not found: ${manifest}`);
  }

  return { mode, manifest, outbox, engineUrl, ollamaUrl, model, runId, adapterModule };
}

function getArg(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function loadAdapters(opts: CliOptions): Promise<{ engine: EngineAdapter; agent: AgentAdapter }> {
  if (opts.mode === 'fixture') {
    const responses = path.resolve(import.meta.dirname ?? '.', '..', 'tests', 'fixtures', 'smoke-responses.json');
    return {
      engine: new FixtureEngineAdapter(),
      agent: fs.existsSync(responses)
        ? new FixtureAgentAdapter({ fixturePath: responses })
        : new FixtureAgentAdapter(),
    };
  }

  if (!opts.adapterModule) {
    throw new Error(
      'Production mode requires --adapter-module or ORION_LAB_PRODUCTION_ADAPTER_MODULE. ' +
      'V1 does not ship a headless production adapter; create one that builds the OpenRewind AgentContext for Windows.',
    );
  }

  const resolved = path.resolve(opts.adapterModule);
  const mod = await import(resolved);
  if (typeof mod.createProductionAgentAdapter !== 'function' || typeof mod.createProductionEngineAdapter !== 'function') {
    throw new Error(`Adapter module ${resolved} must export createProductionAgentAdapter and createProductionEngineAdapter.`);
  }

  const engine = await mod.createProductionEngineAdapter(opts.engineUrl);
  const manifestData = JSON.parse(fs.readFileSync(opts.manifest, 'utf8')) as { scenarios: string[] };
  const firstScenario = loadScenario(manifestData.scenarios[0]);
  const agent = await mod.createProductionAgentAdapter(opts.engineUrl, firstScenario.initialWorldState);
  return { engine, agent };
}

async function main() {
  const opts = parseArgs();
  const manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf8')) as { scenarios: string[] };
  const scenarios = manifest.scenarios.map((p) => loadScenario(p));

  const { engine, agent } = await loadAdapters(opts);

  const runner = new ScenarioRunner({
    runId: opts.runId,
    mode: opts.mode,
    agentAdapter: agent,
    engineAdapter: engine,
    outboxDir: opts.outbox,
    model: opts.model,
    engineUrl: opts.engineUrl,
    ollamaUrl: opts.ollamaUrl,
  });

  const { summary, scenarioEnvelopes } = await runner.runScenarios(scenarios);
  const reportPath = generateMarkdownReport({
    outboxDir: opts.outbox,
    summary,
    envelopes: scenarioEnvelopes,
  });

  console.log(`${opts.mode} run complete.`);
  console.log(`  Outbox:  ${opts.outbox}`);
  console.log(`  Report:  ${reportPath}`);
  console.log(`  Status:  ${summary.passCount}/${summary.scenarioCount} passed`);

  if (agent.close) await agent.close();
  await engine.stop();

  if (summary.failCount > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
