import type { MutationOperator, MutationResult, MutationContext } from './types.ts';
import type { Scenario } from '../runner/scenario-types.ts';
import { deepClone } from './util.ts';

function punctuationVariants(utterance: string): string[] {
  const variants = new Set<string>();
  variants.add(utterance.toLowerCase());
  variants.add(utterance.toUpperCase());

  // Remove final punctuation
  variants.add(utterance.replace(/[.!?]$/, ''));

  // Swap final punctuation
  if (utterance.endsWith('.')) {
    variants.add(utterance.slice(0, -1) + '?');
  } else if (utterance.endsWith('?')) {
    variants.add(utterance.slice(0, -1) + '.');
  }

  // Extra spaces around punctuation and words
  variants.add(utterance.replace(/([.!?])\s*/g, ' $1 ').replace(/\s+/g, ' ').trim());

  // Straight vs curly apostrophe
  variants.add(utterance.replace(/'/g, '’'));
  variants.add(utterance.replace(/'/g, '`'));

  // Add a leading/trailing space artifact
  variants.add(' ' + utterance + ' ');

  return Array.from(variants).filter((v) => v.trim() !== utterance.trim());
}

export const punctuationOperator: MutationOperator = {
  name: 'punctuation',
  apply(scenario: Scenario, _ctx: MutationContext): MutationResult[] {
    const variants: MutationResult[] = [];
    for (let i = 0; i < scenario.turns.length; i++) {
      for (const mutated of punctuationVariants(scenario.turns[i].utterance)) {
        const newTurns = [...scenario.turns];
        newTurns[i] = { ...deepClone(scenario.turns[i]), utterance: mutated };
        variants.push({
          scenario: { ...deepClone(scenario), turns: newTurns },
          spec: {
            version: '1.0.0',
            generatorSeed: _ctx.seed,
            sourceScenarioId: scenario.id,
            sourceScenarioHash: '',
            familyId: scenario.familyId ?? 'unknown',
            seedId: scenario.seedId,
            variantOf: scenario.variantOf ?? scenario.id,
            operators: ['punctuation'],
            tags: ['punctuation', 'semantic-equivalent'],
          },
        });
      }
    }
    return variants;
  },
};
