import * as fs from 'node:fs';
import {
  scenarioSchema,
  type Scenario,
  type Turn,
} from './scenario-types.ts';
import { artifactEnvelopeSchema } from './artifact-types.ts';
import {
  getProductionCapabilityNames,
  validateCapabilityName,
} from './capability-registry.ts';

export function validateScenario(input: unknown): Scenario {
  const parsed = scenarioSchema.parse(input);
  const normalized = normalizeScenario(parsed);
  const errors = validateCapabilities(normalized);
  if (errors.length > 0) {
    throw new Error(`Scenario capability validation failed:\n${errors.join('\n')}`);
  }
  return normalized;
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

function validateCapabilities(scenario: Scenario): string[] {
  const errors: string[] = [];

  function check(name: string, context: string) {
    if (!name) return;
    if (name.includes('*')) {
      if (!globMatchesProductionCapability(name)) {
        errors.push(`${context}: glob "${name}" does not match any production capability.`);
      }
      return;
    }
    errors.push(...validateCapabilityName(name, context));
  }

  scenario.expectedCapabilities?.forEach((c) => check(c, `scenario ${scenario.id} expectedCapabilities`));
  scenario.permittedActions?.forEach((c) => check(c, `scenario ${scenario.id} permittedActions`));
  scenario.forbiddenActions?.forEach((c) => check(c, `scenario ${scenario.id} forbiddenActions`));

  for (const turn of scenario.turns) {
    turn.expectedCapabilities?.forEach((c) => check(c, `scenario ${scenario.id} turn ${turn.id} expectedCapabilities`));
    turn.permittedActions?.forEach((c) => check(c, `scenario ${scenario.id} turn ${turn.id} permittedActions`));
    turn.forbiddenActions?.forEach((c) => check(c, `scenario ${scenario.id} turn ${turn.id} forbiddenActions`));

    for (const checkItem of turn.expectedReceipts ?? []) {
      check(checkItem.capability, `scenario ${scenario.id} turn ${turn.id} expectedReceipts`);
    }
    for (const checkItem of turn.numericalTruthChecks ?? []) {
      check(checkItem.receiptCapability, `scenario ${scenario.id} turn ${turn.id} numericalTruthChecks`);
    }
  }

  return errors;
}

function globMatchesProductionCapability(glob: string): boolean {
  const names = getProductionCapabilityNames();
  const re = new RegExp('^' + glob.replace(/\*\*/g, '.*').replace(/\*/g, '[^.]*') + '$');
  for (const name of names) {
    if (re.test(name)) return true;
  }
  return false;
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
