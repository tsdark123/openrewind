import type { MutationOperator, MutationResult, MutationContext } from './types.ts';
import type { Scenario, ExpectedFinalWorldState } from '../runner/scenario-types.ts';
import { deepClone } from './util.ts';
import { chooseSymbolPhrase } from './symbol-aliases.ts';

function makeSwitchRequired(scenario: Scenario): Scenario | undefined {
  const symbol = scenario.dataSet.symbol;
  if (symbol !== 'SYNTH') return undefined; // V1 only supports SYNTH switch variants

  const clone = deepClone(scenario);
  clone.initialWorldState.session.symbol = 'AAPL';
  clone.initialWorldState.session.date = scenario.dataSet.date;
  clone.initialWorldState.session.sessionActive = true;
  clone.initialWorldState.availableTickers = ['AAPL', 'SYNTH'];
  clone.initialWorldState.session.totalCandles = 390;
  clone.initialWorldState.session.cursor = 389;

  const firstTurn = clone.turns[0];
  const prefix = `For ${chooseSymbolPhrase(scenario.dataSet.symbol)}, `;
  firstTurn.utterance = prefix + firstTurn.utterance;
  firstTurn.expectedCapabilities = ['session.switch_symbol', ...firstTurn.expectedCapabilities];
  firstTurn.permittedActions = ['session.switch_symbol', 'analysis.*'];
  firstTurn.forbiddenActions = ['playback.*'];
  firstTurn.expectedFinalWorldState = {
    ...(firstTurn.expectedFinalWorldState as ExpectedFinalWorldState),
    symbol: 'SYNTH',
    date: scenario.dataSet.date,
    sessionActive: true,
  };
  firstTurn.expectedReceipts = [
    { capability: 'session.switch_symbol', success: true },
    ...firstTurn.expectedReceipts,
  ];

  return clone;
}

function makeNoSession(scenario: Scenario): Scenario | undefined {
  const clone = deepClone(scenario);
  clone.initialWorldState.session.symbol = '';
  clone.initialWorldState.session.date = scenario.dataSet.date;
  clone.initialWorldState.session.sessionActive = false;
  clone.initialWorldState.session.totalCandles = 0;
  clone.initialWorldState.session.cursor = 0;

  for (const turn of clone.turns) {
    turn.expectedOk = false;
    turn.expectedRoute = 'clarification';
    turn.assertExactRoute = false;
    turn.expectedCapabilities = [];
    turn.expectedReceipts = [];
    turn.numericalTruthChecks = [];
    turn.expectedContextAfter = undefined;
    turn.expectedContextUnchanged = false;
    turn.expectedFinalWorldState = undefined;
    turn.exactInvariants = {};
    turn.permittedActions = ['session.*'];
    turn.forbiddenActions = ['analysis.*', 'playback.*', 'chart.*'];
    turn.consumerResponseExpectations = undefined;
  }

  return clone;
}

export const stateVariantsOperator: MutationOperator = {
  name: 'stateVariants',
  apply(scenario: Scenario, ctx: MutationContext): MutationResult[] {
    const variants: MutationResult[] = [];

    const switchVariant = makeSwitchRequired(scenario);
    if (switchVariant) {
      variants.push({
        scenario: switchVariant,
        spec: {
          version: '1.0.0',
          generatorSeed: ctx.seed,
          sourceScenarioId: scenario.id,
          sourceScenarioHash: '',
          familyId: scenario.familyId ?? 'unknown',
          seedId: scenario.seedId,
          variantOf: scenario.variantOf ?? scenario.id,
          operators: ['stateVariants'],
          tags: ['session-state', 'switch-required'],
        },
      });
    }

    if (ctx.allowNegativeControls) {
      const noSession = makeNoSession(scenario);
      if (noSession) {
        variants.push({
          scenario: noSession,
          spec: {
            version: '1.0.0',
            generatorSeed: ctx.seed,
            sourceScenarioId: scenario.id,
            sourceScenarioHash: '',
            familyId: scenario.familyId ?? 'unknown',
            seedId: scenario.seedId,
            variantOf: scenario.variantOf ?? scenario.id,
            operators: ['stateVariants'],
            tags: ['session-state', 'no-session', 'negative-control'],
          },
        });
      }
    }

    return variants;
  },
};
