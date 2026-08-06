import * as fs from 'node:fs';
import {
  scenarioSchema,
  type Scenario,
  type Turn,
} from './scenario-types.ts';
import { artifactEnvelopeSchema } from './artifact-types.ts';

export function validateScenario(input: unknown): Scenario {
  const parsed = scenarioSchema.parse(input);
  return normalizeScenario(parsed);
}

export function validateArtifact(input: unknown) {
  return artifactEnvelopeSchema.parse(input);
}

export function loadScenario(path: string): Scenario {
  const raw = fs.readFileSync(path, 'utf8');
  return validateScenario(JSON.parse(raw));
}

function normalizeScenario(scenario: Scenario): Scenario {
  const normalizedTurns: Turn[] = scenario.turns.map((turn) => {
    const normalized: Turn = {
      ...turn,
      permittedActions: mergeActionLists(scenario.permittedActions, turn.permittedActions),
      forbiddenActions: mergeActionLists(scenario.forbiddenActions, turn.forbiddenActions),
    };
    return normalized;
  });
  return { ...scenario, turns: normalizedTurns };
}

function mergeActionLists(
  base: string[] | undefined,
  override: string[] | undefined,
): string[] {
  if (override !== undefined) return override;
  return base ?? [];
}

export function scenarioToJson(scenario: Scenario): string {
  return JSON.stringify(scenario, null, 2);
}
