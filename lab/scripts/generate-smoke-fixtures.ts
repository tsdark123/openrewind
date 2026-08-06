/**
 * Generate deterministic fixture agent responses for smoke scenarios.
 *
 * These are explicit test artifacts used to validate lab machinery in
 * fixture/dry-run mode. They are not real Orion model output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario } from '../runner/scenario-validator.ts';
import type { Scenario } from '../runner/scenario-types.ts';
import { computeCapability } from '../reference/calculator.ts';
import { FixtureEngineAdapter } from '../runner/adapters/engine-adapter.ts';
import type { AgentTurnResult } from '../runner/adapters/agent-adapter.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(__dirname, '..');
const scenariosDir = path.join(baseDir, 'scenarios', 'smoke');
const fixturesDir = path.join(baseDir, 'tests', 'fixtures');

fs.mkdirSync(fixturesDir, { recursive: true });

const engine = new FixtureEngineAdapter({ fixtureDir: path.join(baseDir, 'reference', 'fixtures') });

function buildFinalWorldState(scenario: Scenario, turn: { id: string; exactInvariants?: { timeframe?: number } }): Record<string, unknown> {
  const session = scenario.initialWorldState.session;
  const invariantTimeframe = turn.exactInvariants?.timeframe ?? session.timeframe;
  const cursor = (() => {
    if (turn.id === 'absolute-seek') return 60;
    if (turn.id === 'relative-seek') return 15;
    return session.cursor;
  })();
  const totalCandles = (() => {
    if (invariantTimeframe === 5) return 78;
    if (turn.id === 'symbol-switch') return 390;
    return session.totalCandles;
  })();
  const sessionActive = (() => {
    if (turn.id === 'symbol-switch') return true;
    return session.sessionActive;
  })();

  return {
    symbol: session.symbol || scenario.dataSet.symbol,
    date: session.date || scenario.dataSet.date,
    timeframe: invariantTimeframe,
    cursor,
    totalCandles,
    isPlaying: false,
    speed: 1,
    direction: 'forward',
    currentPrice: session.currentPrice || 0,
    sessionActive,
  };
}

function buildMessage(scenario: Scenario, summaryData?: any): string {
  switch (scenario.id) {
    case 'whole-session-summary':
      return `SYNTH session summary: open ${summaryData.open.toFixed(2)} close ${summaryData.close.toFixed(2)}.`;
    case 'symbol-switch':
      return `Loaded SYNTH for 2026-08-05.`;
    case 'timeframe-change':
      return `Switched to 5 minute candles.`;
    case 'absolute-seek':
      return `Jumped to 11:30.`;
    case 'relative-seek':
      return `Moved forward 15 minutes.`;
    default:
      return `Fixture response for ${scenario.id}.`;
  }
}

async function buildResponse(scenario: Scenario, turnIndex: number): Promise<AgentTurnResult> {
  const turn = scenario.turns[turnIndex];
  const capabilities = turn.expectedCapabilities ?? [];
  const receipts: Record<string, unknown>[] = [];
  let summaryData: any;

  if (capabilities.includes('analysis.window_summary')) {
    const candles = await engine.fetchCandles(scenario.dataSet);
    summaryData = computeCapability(candles, {
      capability: 'analysis.window_summary',
      window: turn.exactInvariants?.window ?? { kind: 'whole_session' },
    });
    receipts.push({
      stepId: `${turn.id}-summary`,
      capability: 'analysis.window_summary',
      success: true,
      planId: `${scenario.id}-${turn.id}`,
      message: 'Fixture summary generated.',
      data: summaryData,
    });
  }

  const finalWorldState = buildFinalWorldState(scenario, turn);

  return {
    ok: true,
    route: 'deterministic',
    message: buildMessage(scenario, summaryData),
    capabilities,
    receipts,
    template: turn.expectedContextAfter ? JSON.parse(JSON.stringify(turn.expectedContextAfter)) : undefined,
    finalWorldState,
  };
}

async function main() {
  const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));
  const responses: Record<string, AgentTurnResult> = {};
  const manifest: string[] = [];

  for (const file of files) {
    const scenarioPath = path.join(scenariosDir, file);
    const scenario = loadScenario(scenarioPath);
    manifest.push(scenarioPath);
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      const response = await buildResponse(scenario, i);
      responses[`${scenario.id}:${turn.id}`] = response;
    }
  }

  fs.writeFileSync(
    path.join(fixturesDir, 'smoke-responses.json'),
    JSON.stringify(responses, null, 2),
  );
  fs.writeFileSync(
    path.join(fixturesDir, 'smoke-manifest.json'),
    JSON.stringify({ scenarios: manifest }, null, 2),
  );

  console.log(`Wrote ${Object.keys(responses).length} fixture responses to ${fixturesDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
