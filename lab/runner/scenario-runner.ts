import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Scenario } from './scenario-types.ts';
import type { AgentAdapter, AgentTurnContext, AgentTurnResult } from './adapters/agent-adapter.ts';
import type { EngineAdapter } from './adapters/engine-adapter.ts';
import { evaluateTurn } from './oracles.ts';
import type {
  ScenarioResultEnvelope,
  ScenarioResultPayload,
  TurnResult,
  RunSummary,
} from './artifact-types.ts';

export interface ScenarioRunnerOptions {
  runId: string;
  mode: 'fixture' | 'production';
  agentAdapter: AgentAdapter;
  engineAdapter: EngineAdapter;
  outboxDir: string;
  model?: string;
  engineUrl?: string;
  ollamaUrl?: string;
  manifestSha?: string;
}

export interface RunResult {
  summary: RunSummary;
  scenarioEnvelopes: ScenarioResultEnvelope[];
}

export class ScenarioRunner {
  private startTime = Date.now();

  constructor(private opts: ScenarioRunnerOptions) {}

  async runScenarios(scenarios: Scenario[]): Promise<RunResult> {
    const envelopes: ScenarioResultEnvelope[] = [];
    let passCount = 0;
    let failCount = 0;
    let timeoutCount = 0;
    let skipCount = 0;

    fs.mkdirSync(this.opts.outboxDir, { recursive: true });
    const eventsPath = path.join(this.opts.outboxDir, 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
      fs.unlinkSync(eventsPath);
    }

    for (const scenario of scenarios) {
      const envelope = await this.runScenario(scenario, eventsPath);
      envelopes.push(envelope);
      if (envelope.payload.status === 'pass') passCount++;
      else if (envelope.payload.status === 'fail') failCount++;
      else if (envelope.payload.status === 'timeout') timeoutCount++;
      else if (envelope.payload.status === 'skip') skipCount++;
    }

    const summary: RunSummary = {
      runId: this.opts.runId,
      mode: this.opts.mode,
      timestamp: new Date().toISOString(),
      startTime: new Date(this.startTime).toISOString(),
      endTime: new Date().toISOString(),
      manifestSha: this.opts.manifestSha,
      scenarioCount: scenarios.length,
      passCount,
      failCount,
      timeoutCount,
      skipCount,
      model: this.opts.model,
      engineUrl: this.opts.engineUrl,
      ollamaUrl: this.opts.ollamaUrl,
      note: 'fixture-mode lab validation; not real Orion certification',
    };

    const summaryPath = path.join(this.opts.outboxDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    // Write summary envelope as the last line of events.jsonl
    const summaryEnvelope = {
      type: 'orion.run_summary' as const,
      version: '1.0.0' as const,
      payload: summary,
    };
    fs.appendFileSync(eventsPath, JSON.stringify(summaryEnvelope) + '\n');

    return { summary, scenarioEnvelopes: envelopes };
  }

  private async runScenario(
    scenario: Scenario,
    eventsPath: string,
  ): Promise<ScenarioResultEnvelope> {
    const turnResults: TurnResult[] = [];
    const previousAgentResults: AgentTurnResult[] = [];
    let scenarioStatus: import('./artifact-types.ts').TurnStatus = 'pass';
    const scenarioStart = Date.now();

    const referenceCandles = await this.opts.engineAdapter.fetchCandles({
      symbol: scenario.dataSet.symbol,
      date: scenario.dataSet.date,
      timeframe: scenario.dataSet.timeframe,
    });

    for (const turn of scenario.turns) {
      const turnStart = Date.now();
      const ctx: AgentTurnContext = {
        scenarioId: scenario.id,
        turnId: turn.id,
        previousTemplate: previousAgentResults[previousAgentResults.length - 1]?.template,
        previousResults: previousAgentResults,
        engineUrl: this.opts.engineUrl ?? 'http://127.0.0.1:19000',
      };

      let agentResult: AgentTurnResult;
      try {
        agentResult = await this.opts.agentAdapter.send(turn.utterance, ctx);
      } catch (e) {
        agentResult = {
          ok: false,
          route: 'error',
          message: `Agent adapter threw: ${e instanceof Error ? e.message : String(e)}`,
          capabilities: [],
          receipts: [],
        };
      }
      const durationMs = Date.now() - turnStart;
      previousAgentResults.push(agentResult);

      const evaluated = evaluateTurn({
        scenario,
        turn,
        turnResult: agentResult,
        previousResults: previousAgentResults.slice(0, -1),
        referenceCandles,
        durationMs,
      });

      turnResults.push(evaluated);
      if (evaluated.status !== 'pass' && scenarioStatus === 'pass') {
        scenarioStatus = evaluated.status;
      }
    }

    const payload: ScenarioResultPayload = {
      runId: this.opts.runId,
      timestamp: new Date().toISOString(),
      mode: this.opts.mode,
      scenarioId: scenario.id,
      repetition: 1,
      model: this.opts.model,
      engineUrl: this.opts.engineUrl,
      dataSet: scenario.dataSet,
      status: scenarioStatus,
      durationMs: Date.now() - scenarioStart,
      turns: turnResults,
      note: 'fixture-mode lab validation; not real Orion certification',
    };

    const envelope: ScenarioResultEnvelope = {
      type: 'orion.scenario_result',
      version: '1.0.0',
      payload,
    };

    fs.appendFileSync(eventsPath, JSON.stringify(envelope) + '\n');
    return envelope;
  }
}
