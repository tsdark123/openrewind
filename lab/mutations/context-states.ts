import type { MutationOperator, MutationResult, MutationContext } from './types.ts';
import type { Scenario, Turn, AnalysisWindow } from '../runner/scenario-types.ts';
import { deepClone } from './util.ts';

function windowToPhrase(window: AnalysisWindow): string | undefined {
  if (window.kind === 'time_range') {
    return `${window.fromTime} to ${window.toTime}`;
  }
  if (window.kind === 'whole_session') return 'whole session';
  if (window.kind === 'up_to_cursor') return 'range up to cursor';
  return undefined;
}

function anaphoricVariants(turn: Turn): string[] {
  const u = turn.utterance;
  const variants = new Set<string>();
  variants.add(u.replace(/\bthat\b/gi, 'it'));
  variants.add(u.replace(/\bthat\b/gi, 'this'));
  variants.add(u.replace(/\bwith\b/gi, 'to'));
  variants.add(u.replace(/\bwith\b/gi, 'against'));
  variants.add(u.replace(/last hour\b/gi, 'final hour'));
  variants.add(u.replace(/last hour\b/gi, 'last 60 minutes'));
  return Array.from(variants).filter((v) => v !== u);
}

function explicitVariant(scenario: Scenario, turnIndex: number): string | undefined {
  if (turnIndex !== 1 || scenario.turns.length < 2) return undefined;
  const previousTurn = scenario.turns[0];
  const currentTurn = scenario.turns[1];

  // first-hour-vs-last-hour: turn 0 defines left window, turn 1 defines right window in expectedContextAfter
  if (previousTurn.exactInvariants?.window?.kind === 'time_range') {
    const left = windowToPhrase(previousTurn.exactInvariants.window);
    const compareRequest = currentTurn.expectedContextAfter?.analysisRequests?.[0] as
      | { kind: 'window_compare'; left?: AnalysisWindow; right?: AnalysisWindow }
      | undefined;
    const right = compareRequest?.right ? windowToPhrase(compareRequest.right) : undefined;
    if (left && right) {
      return `Compare the ${left} range with the ${right} range.`;
    }
    if (left) {
      return `Compare the ${left} range with the last hour.`;
    }
  }

  // candle-anatomy follow-up: turn 0 defines marketTime
  const marketTime = previousTurn.exactInvariants?.marketTime;
  if (marketTime) {
    return `What can we do with the ${marketTime} candle?`;
  }

  return undefined;
}

export const contextStatesOperator: MutationOperator = {
  name: 'contextStates',
  apply(scenario: Scenario, ctx: MutationContext): MutationResult[] {
    const variants: MutationResult[] = [];
    for (let i = 1; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      for (const mutated of anaphoricVariants(turn)) {
        const newTurns = [...scenario.turns];
        newTurns[i] = { ...deepClone(turn), utterance: mutated };
        variants.push({
          scenario: { ...deepClone(scenario), turns: newTurns },
          spec: {
            version: '1.0.0',
            generatorSeed: ctx.seed,
            sourceScenarioId: scenario.id,
            sourceScenarioHash: '',
            familyId: scenario.familyId ?? 'unknown',
            seedId: scenario.seedId,
            variantOf: scenario.variantOf ?? scenario.id,
            operators: ['contextStates'],
            tags: ['context-reference', 'context-present', 'anaphoric', 'semantic-equivalent'],
          },
        });
      }
      const explicit = explicitVariant(scenario, i);
      if (explicit) {
        const newTurns = [...scenario.turns];
        newTurns[i] = { ...deepClone(turn), utterance: explicit };
        variants.push({
          scenario: { ...deepClone(scenario), turns: newTurns },
          spec: {
            version: '1.0.0',
            generatorSeed: ctx.seed,
            sourceScenarioId: scenario.id,
            sourceScenarioHash: '',
            familyId: scenario.familyId ?? 'unknown',
            seedId: scenario.seedId,
            variantOf: scenario.variantOf ?? scenario.id,
            operators: ['contextStates'],
            tags: ['context-reference', 'context-absent', 'explicit', 'semantic-equivalent'],
          },
        });
      }
    }
    return variants;
  },
};
