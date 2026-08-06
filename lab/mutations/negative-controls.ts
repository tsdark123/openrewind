import type { MutationOperator, MutationResult, MutationContext } from './types.ts';
import type { Scenario, Turn } from '../runner/scenario-types.ts';
import { deepClone } from './util.ts';

function stripTurnExpectations(turn: Turn): Turn {
  return {
    ...turn,
    expectedOk: false,
    expectedRoute: 'unsupported',
    assertExactRoute: false,
    expectedCapabilities: [],
    expectedReceipts: [],
    numericalTruthChecks: [],
    expectedContextAfter: undefined,
    expectedContextUnchanged: false,
    expectedFinalWorldState: undefined,
    exactInvariants: {},
    permittedActions: ['session.*'],
    forbiddenActions: ['analysis.*', 'playback.*', 'chart.*'],
    consumerResponseExpectations: undefined,
  };
}

function invalidTimeVariant(scenario: Scenario, ctx: MutationContext): MutationResult | undefined {
  const clone = deepClone(scenario);
  let mutated = false;
  for (let i = 0; i < clone.turns.length; i++) {
    const turn = clone.turns[i];
    if (turn.exactInvariants?.marketTime === '11:30') {
      clone.turns[i] = {
        ...stripTurnExpectations(turn),
        utterance: turn.utterance.replace(/11:30|eleven thirty/gi, 'eleven seventy'),
      };
      mutated = true;
    } else if (turn.exactInvariants?.window?.kind === 'time_range') {
      clone.turns[i] = {
        ...stripTurnExpectations(turn),
        utterance: turn.utterance.replace(/first hour|last hour/gi, 'invalid hour'),
      };
      mutated = true;
    }
  }
  if (!mutated) return undefined;
  return {
    scenario: clone,
    spec: {
      version: '1.0.0',
      generatorSeed: ctx.seed,
      sourceScenarioId: scenario.id,
      sourceScenarioHash: '',
      familyId: scenario.familyId ?? 'unknown',
      seedId: scenario.seedId,
      variantOf: scenario.variantOf ?? scenario.id,
      operators: ['negativeControl'],
      tags: ['negative-control', 'invalid-time'],
    },
  };
}

function unknownSymbolVariant(scenario: Scenario, ctx: MutationContext): MutationResult | undefined {
  if (scenario.turns.length === 0) return undefined;
  const clone = deepClone(scenario);
  const first = clone.turns[0];
  const q = first.utterance.endsWith('?') ? '?' : '.';
  const base = first.utterance.replace(/[.!?]$/, '');
  clone.turns[0] = {
    ...stripTurnExpectations(first),
    utterance: `${base} for UNKNOWN${q}`,
  };
  clone.initialWorldState.availableTickers = ['SYNTH'];
  return {
    scenario: clone,
    spec: {
      version: '1.0.0',
      generatorSeed: ctx.seed,
      sourceScenarioId: scenario.id,
      sourceScenarioHash: '',
      familyId: scenario.familyId ?? 'unknown',
      seedId: scenario.seedId,
      variantOf: scenario.variantOf ?? scenario.id,
      operators: ['negativeControl'],
      tags: ['negative-control', 'unknown-symbol'],
    },
  };
}

export const negativeControlsOperator: MutationOperator = {
  name: 'negativeControl',
  apply(scenario: Scenario, ctx: MutationContext): MutationResult[] {
    if (!ctx.allowNegativeControls) return [];
    const variants: MutationResult[] = [];
    const invalidTime = invalidTimeVariant(scenario, ctx);
    if (invalidTime) variants.push(invalidTime);
    const unknownSymbol = unknownSymbolVariant(scenario, ctx);
    if (unknownSymbol) variants.push(unknownSymbol);
    return variants;
  },
};
