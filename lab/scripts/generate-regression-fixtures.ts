/**
 * Generate explicit fixture artifacts for the five regression seeds.
 *
 * - `regression-pass-responses.json` contains synthetically valid responses that
 *   the oracles should accept.
 * - `regression-fail-responses.json` contains responses representing the
 *   original bugs; the oracles must reject these with useful violations.
 *
 * These artifacts validate lab machinery only. They are not real Orion output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario } from '../runner/scenario-validator.ts';
import type { Scenario, Turn, AnalysisWindow } from '../runner/scenario-types.ts';
import { computeCapability } from '../reference/calculator.ts';
import { FixtureEngineAdapter } from '../runner/adapters/engine-adapter.ts';
import type { AgentTurnResult } from '../runner/adapters/agent-adapter.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(__dirname, '..');
const scenariosDir = path.join(baseDir, 'scenarios', 'regression');
const fixturesDir = path.join(baseDir, 'tests', 'fixtures');

fs.mkdirSync(fixturesDir, { recursive: true });

const engine = new FixtureEngineAdapter({ fixtureDir: path.join(baseDir, 'reference', 'fixtures') });

async function computeReceipt(scenario: Scenario, turn: Turn): Promise<Record<string, unknown> | undefined> {
  const candles = await engine.fetchCandles(scenario.dataSet);
  const cap = turn.expectedCapabilities?.[0];
  if (!cap) return undefined;

  if (cap === 'analysis.window_ohlc') {
    const w = turn.exactInvariants?.window as AnalysisWindow;
    return {
      capability: cap,
      success: true,
      data: computeCapability(candles, { capability: 'analysis.window_ohlc', window: w }),
    };
  }
  if (cap === 'analysis.window_compare') {
    const template = turn.expectedContextAfter as any;
    const req = template?.analysisRequests?.[0];
    const left = req.left as AnalysisWindow;
    const right = req.right as AnalysisWindow;
    return {
      capability: cap,
      success: true,
      data: {
        left,
        right,
        ...computeCapability(candles, {
          capability: 'analysis.window_compare',
          left,
          right,
        }),
      },
    };
  }
  if (cap === 'analysis.candle_shape') {
    return {
      capability: cap,
      success: true,
      data: computeCapability(candles, {
        capability: 'analysis.candle_shape',
        marketTime: turn.exactInvariants?.marketTime,
      }),
    };
  }
  if (cap === 'analysis.window_summary') {
    const w = turn.exactInvariants?.window ?? { kind: 'whole_session' as const };
    return {
      capability: cap,
      success: true,
      data: computeCapability(candles, { capability: 'analysis.window_summary', window: w as AnalysisWindow }),
    };
  }
  return undefined;
}

function messageFor(scenario: Scenario, turn: Turn, summary?: any): string {
  if (scenario.id === 'first-hour-vs-last-hour') {
    if (turn.id === 't1') return `First hour (09:30–10:29): open 100.00 high 100.64 low 99.94 close 100.59.`;
    if (turn.id === 't2') return `Comparing first hour (09:30–10:29) with last hour (15:00–15:59).`;
  }
  if (scenario.id === 'explicit-time-candle-1130' || scenario.id === 'spoken-time-candle-1130') {
    return `The 11:30 candle is bullish with body 0.05 and range 0.09.`;
  }
  if (scenario.id === 'describe-whole-session') {
    return `SYNTH session summary: open ${summary.open.toFixed(2)} close ${summary.close.toFixed(2)}.`;
  }
  if (scenario.id === 'candle-anatomy-follow-up-unsupported') {
    if (turn.id === 't1') return `The 11:30 candle is bullish with body 0.05 and range 0.09.`;
    if (turn.id === 't2') return `I don't support that yet.`;
  }
  return `Fixture response for ${scenario.id}/${turn.id}.`;
}

async function buildPassResponse(scenario: Scenario, turn: Turn): Promise<AgentTurnResult> {
  const receipt = await computeReceipt(scenario, turn);
  const receipts = receipt ? [receipt] : [];
  const summary = receipt?.capability === 'analysis.window_summary' ? (receipt.data as any) : undefined;

  return {
    ok: true,
    route: (turn.expectedRoute as any) ?? 'deterministic',
    message: messageFor(scenario, turn, summary),
    capabilities: turn.expectedCapabilities ?? [],
    receipts,
    template: turn.expectedContextAfter ? JSON.parse(JSON.stringify(turn.expectedContextAfter)) : undefined,
    finalWorldState: turn.expectedFinalWorldState ? JSON.parse(JSON.stringify(turn.expectedFinalWorldState)) : undefined,
  };
}

async function buildFailResponse(scenario: Scenario, turn: Turn): Promise<AgentTurnResult> {
  const pass = await buildPassResponse(scenario, turn);

  switch (scenario.id) {
    case 'first-hour-vs-last-hour': {
      if (turn.id === 't2') {
        // Bug: compares first hour against 09:30–14:59 instead of 15:00–16:00.
        const template = JSON.parse(JSON.stringify(pass.template)) as any;
        if (template?.analysisRequests?.[0]?.right) {
          template.analysisRequests[0].right = { kind: 'time_range', fromTime: '09:30', toTime: '14:59' };
        }
        return { ...pass, template };
      }
      break;
    }
    case 'explicit-time-candle-1130':
    case 'spoken-time-candle-1130': {
      // Bug: returned candle at 11:49 instead of 11:30.
      const template = JSON.parse(JSON.stringify(pass.template)) as any;
      if (template?.analysisRequests?.[0]) {
        template.analysisRequests[0].marketTime = '11:49';
      }
      return {
        ...pass,
        template,
        message: 'The 11:49 candle is bullish with body 0.04 and range 0.08.',
      };
    }
    case 'describe-whole-session': {
      // Bug: "Describe" resolves a symbol instead of summarizing.
      return {
        ...pass,
        capabilities: ['session.resolve_symbol'],
        receipts: [{
          capability: 'session.resolve_symbol',
          success: true,
          data: { input: 'Describe', symbol: 'DESCRIBE' },
        }],
        template: undefined,
        message: 'Resolving symbol Describe...',
      };
    }
    case 'candle-anatomy-follow-up-unsupported': {
      if (turn.id === 't2') {
        // Bug: follow-up starts a new whole-session analysis and mutates context.
        return {
          ...pass,
          capabilities: ['analysis.window_ohlc'],
          receipts: [{
            capability: 'analysis.window_ohlc',
            success: true,
            data: { open: 100, close: 103.89 },
          }],
          template: {
            kind: 'chart_action',
            symbol: 'SYNTH',
            date: { kind: 'absolute', value: '2026-08-05' },
            timeframeMinutes: 1,
            analysisRequests: [{ kind: 'window_ohlc', window: { kind: 'whole_session' } }],
          },
          message: 'Here is the whole session OHLC.',
        };
      }
      break;
    }
  }

  return pass;
}

async function generate(scenarioPath: string, kind: 'pass' | 'fail'): Promise<Record<string, AgentTurnResult>> {
  const scenario = loadScenario(scenarioPath);
  const responses: Record<string, AgentTurnResult> = {};
  for (const turn of scenario.turns) {
    const response = kind === 'pass'
      ? await buildPassResponse(scenario, turn)
      : await buildFailResponse(scenario, turn);
    responses[`${scenario.id}:${turn.id}`] = response;
  }
  return responses;
}

async function main() {
  const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));
  const passResponses: Record<string, AgentTurnResult> = {};
  const failResponses: Record<string, AgentTurnResult> = {};
  const manifest: string[] = [];

  for (const file of files) {
    const scenarioPath = path.join(scenariosDir, file);
    manifest.push(scenarioPath);
    Object.assign(passResponses, await generate(scenarioPath, 'pass'));
    Object.assign(failResponses, await generate(scenarioPath, 'fail'));
  }

  fs.writeFileSync(path.join(fixturesDir, 'regression-pass-responses.json'), JSON.stringify(passResponses, null, 2));
  fs.writeFileSync(path.join(fixturesDir, 'regression-fail-responses.json'), JSON.stringify(failResponses, null, 2));
  fs.writeFileSync(path.join(fixturesDir, 'regression-manifest.json'), JSON.stringify({ scenarios: manifest }, null, 2));

  console.log(`Wrote ${Object.keys(passResponses).length} pass and ${Object.keys(failResponses).length} fail regression responses to ${fixturesDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
