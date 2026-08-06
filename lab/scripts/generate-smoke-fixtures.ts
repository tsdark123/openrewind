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
import type { Scenario, Turn } from '../runner/scenario-types.ts';
import { computeCapability } from '../reference/calculator.ts';
import { FixtureEngineAdapter } from '../runner/adapters/engine-adapter.ts';
import type { AgentTurnResult } from '../runner/adapters/agent-adapter.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(__dirname, '..');
const scenariosDir = path.join(baseDir, 'scenarios', 'smoke');
const fixturesDir = path.join(baseDir, 'tests', 'fixtures');

fs.mkdirSync(fixturesDir, { recursive: true });

const engine = new FixtureEngineAdapter({ fixtureDir: path.join(baseDir, 'reference', 'fixtures') });

function buildFinalWorldState(scenario: Scenario, turn: Turn): Record<string, unknown> {
  const session = scenario.initialWorldState.session;
  const invariantTimeframe = turn.exactInvariants?.timeframe ?? session.timeframe;

  const expected = turn.expectedFinalWorldState ?? {};
  const cursor = expected.cursor ?? session.cursor;
  const totalCandles = expected.totalCandles ?? (invariantTimeframe === 5 ? 78 : session.totalCandles || 390);
  const sessionActive = expected.sessionActive ?? (scenario.id === 'symbol-switch' ? true : session.sessionActive);

  return {
    symbol: expected.symbol ?? session.symbol ?? scenario.dataSet.symbol,
    date: expected.date ?? session.date ?? scenario.dataSet.date,
    timeframe: expected.timeframe ?? invariantTimeframe,
    cursor,
    totalCandles,
    isPlaying: expected.isPlaying ?? false,
    speed: expected.speed ?? 1,
    direction: (expected.direction as any) ?? 'forward',
    currentPrice: expected.currentPrice ?? session.currentPrice ?? 0,
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

async function buildReceipts(scenario: Scenario, turn: Turn): Promise<{ receipts: Record<string, unknown>[]; summaryData?: any }> {
  const receipts: Record<string, unknown>[] = [];
  let summaryData: any;

  for (const cap of turn.expectedCapabilities ?? []) {
    const stepId = `${turn.id}-${cap.replace(/\./g, '-')}`;
    if (cap === 'session.switch_symbol') {
      receipts.push({
        stepId,
        capability: cap,
        success: true,
        planId: `${scenario.id}-${turn.id}`,
        message: `Switched to ${scenario.dataSet.symbol} ${scenario.dataSet.date}.`,
        data: { symbol: scenario.dataSet.symbol, date: scenario.dataSet.date, sessionActive: true },
      });
    } else if (cap === 'chart.set_timeframe') {
      receipts.push({
        stepId,
        capability: cap,
        success: true,
        planId: `${scenario.id}-${turn.id}`,
        message: `Timeframe set to ${turn.exactInvariants?.timeframe ?? 5}m.`,
        data: { timeframe: turn.exactInvariants?.timeframe ?? 5 },
      });
    } else if (cap === 'playback.seek_to_time') {
      receipts.push({
        stepId,
        capability: cap,
        success: true,
        planId: `${scenario.id}-${turn.id}`,
        message: `Seeked to ${turn.exactInvariants?.seekTime}.`,
        data: { time: turn.exactInvariants?.seekTime, cursor: 60 },
      });
    } else if (cap === 'playback.seek_relative') {
      receipts.push({
        stepId,
        capability: cap,
        success: true,
        planId: `${scenario.id}-${turn.id}`,
        message: `Seeked relative 15 minutes.`,
        data: { minutes: 15, cursor: 15 },
      });
    } else if (cap === 'analysis.window_summary') {
      const candles = await engine.fetchCandles(scenario.dataSet);
      summaryData = computeCapability(candles, {
        capability: 'analysis.window_summary',
        window: turn.exactInvariants?.window ?? { kind: 'whole_session' },
      });
      receipts.push({
        stepId,
        capability: cap,
        success: true,
        planId: `${scenario.id}-${turn.id}`,
        message: 'Fixture summary generated.',
        data: summaryData,
      });
    }
  }

  return { receipts, summaryData };
}

async function buildResponse(scenario: Scenario, turnIndex: number): Promise<AgentTurnResult> {
  const turn = scenario.turns[turnIndex];
  const { receipts, summaryData } = await buildReceipts(scenario, turn);
  const finalWorldState = buildFinalWorldState(scenario, turn);

  return {
    ok: true,
    route: 'deterministic',
    message: buildMessage(scenario, summaryData),
    capabilities: turn.expectedCapabilities ?? [],
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
