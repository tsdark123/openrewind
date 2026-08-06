import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario } from '../runner/scenario-validator.ts';
import { ScenarioRunner } from '../runner/scenario-runner.ts';
import { FixtureEngineAdapter } from '../runner/adapters/engine-adapter.ts';
import { FixtureAgentAdapter } from '../runner/adapters/fixture-agent.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.resolve(__dirname, '..', 'scenarios', 'regression');
const fixturesDir = path.resolve(__dirname, 'fixtures');
const outboxDir = path.resolve(__dirname, '..', 'outbox', 'regression-test');

async function runScenarioWithFixture(scenarioPath: string, fixture: string, runId: string) {
  const scenario = loadScenario(scenarioPath);
  const runner = new ScenarioRunner({
    runId,
    mode: 'fixture',
    agentAdapter: new FixtureAgentAdapter({ fixturePath: path.join(fixturesDir, fixture) }),
    engineAdapter: new FixtureEngineAdapter(),
    outboxDir: path.join(outboxDir, runId),
  });
  const result = await runner.runScenarios([scenario]);
  return result.scenarioEnvelopes[0];
}

describe('regression seed pass artifacts', () => {
  it('A: first hour then compare with last hour passes', async () => {
    const p = path.join(scenariosDir, 'first-hour-vs-last-hour.json');
    const result = await runScenarioWithFixture(p, 'regression-pass-responses.json', 'regression-pass-a');
    expect(result.payload.status).toBe('pass');
  });

  it('B: exact 11:30 candle shape passes', async () => {
    const p = path.join(scenariosDir, 'explicit-time-candle-1130.json');
    const result = await runScenarioWithFixture(p, 'regression-pass-responses.json', 'regression-pass-b');
    expect(result.payload.status).toBe('pass');
  });

  it('C: spoken eleven-thirty candle shape passes', async () => {
    const p = path.join(scenariosDir, 'spoken-time-candle-1130.json');
    const result = await runScenarioWithFixture(p, 'regression-pass-responses.json', 'regression-pass-c');
    expect(result.payload.status).toBe('pass');
  });

  it('D: describe whole active session passes', async () => {
    const p = path.join(scenariosDir, 'describe-whole-session.json');
    const result = await runScenarioWithFixture(p, 'regression-pass-responses.json', 'regression-pass-d');
    expect(result.payload.status).toBe('pass');
  });

  it('E: candle anatomy then unsupported follow-up passes', async () => {
    const p = path.join(scenariosDir, 'candle-anatomy-follow-up-unsupported.json');
    const result = await runScenarioWithFixture(p, 'regression-pass-responses.json', 'regression-pass-e');
    expect(result.payload.status).toBe('pass');
  });
});

describe('regression seed failure artifacts', () => {
  it('A: wrong compare window is rejected', async () => {
    const p = path.join(scenariosDir, 'first-hour-vs-last-hour.json');
    const result = await runScenarioWithFixture(p, 'regression-fail-responses.json', 'regression-fail-a');
    expect(result.payload.status).toBe('fail');
    const t2 = result.payload.turns.find((t) => t.turnId === 't2');
    expect(t2).toBeDefined();
    expect(t2!.status).toBe('fail');
    expect(t2!.violations.some((v) => v.stage === 'context' || v.stage === 'numeric')).toBe(true);
  });

  it('B: wrong candle time (11:49) is rejected', async () => {
    const p = path.join(scenariosDir, 'explicit-time-candle-1130.json');
    const result = await runScenarioWithFixture(p, 'regression-fail-responses.json', 'regression-fail-b');
    expect(result.payload.status).toBe('fail');
    const t1 = result.payload.turns[0];
    expect(t1.violations.some((v) => v.stage === 'grounding' || v.stage === 'context')).toBe(true);
  });

  it('C: spoken time routed to clarification is rejected', async () => {
    const p = path.join(scenariosDir, 'spoken-time-candle-1130.json');
    const result = await runScenarioWithFixture(p, 'regression-fail-responses.json', 'regression-fail-c');
    expect(result.payload.status).toBe('fail');
    const t1 = result.payload.turns[0];
    expect(t1.violations.some((v) => v.stage === 'required-capability' || v.stage === 'forbidden' || v.stage === 'consumer')).toBe(true);
  });

  it('D: "Describe" resolving a symbol is rejected', async () => {
    const p = path.join(scenariosDir, 'describe-whole-session.json');
    const result = await runScenarioWithFixture(p, 'regression-fail-responses.json', 'regression-fail-d');
    expect(result.payload.status).toBe('fail');
    const t1 = result.payload.turns[0];
    expect(t1.violations.some((v) => v.stage === 'forbidden' || v.stage === 'required-capability')).toBe(true);
  });

  it('E: unsupported follow-up executing new analysis is rejected', async () => {
    const p = path.join(scenariosDir, 'candle-anatomy-follow-up-unsupported.json');
    const result = await runScenarioWithFixture(p, 'regression-fail-responses.json', 'regression-fail-e');
    expect(result.payload.status).toBe('fail');
    const t2 = result.payload.turns.find((t) => t.turnId === 't2');
    expect(t2).toBeDefined();
    expect(t2!.status).toBe('fail');
    expect(t2!.violations.some((v) => v.stage === 'forbidden' || v.stage === 'context')).toBe(true);
  });
});
