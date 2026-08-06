import type { MutationOperator, MutationResult, MutationContext } from './types.ts';
import type { Scenario } from '../runner/scenario-types.ts';
import { deepClone, normalizeUtterance } from './util.ts';

const TYPO_RULES: Record<string, string[]> = {
  Describe: ['Descibe', 'Describbe'], // omitted letter, duplicated letter
  What: ['Wat', 'Whta'], // omitted letter, transposition
  kind: ['knd', 'kinnd'],
  candle: ['cndle', 'canddle', 'cansle'], // omitted, duplicated, adjacent-key (d->s)
  today: ['tody', 'todday', 'tocay'], // omitted, duplicated, adjacent-key (d->c)
  Compare: ['Comapre', 'Compaare'], // transposition, duplicated
  eleven: ['elevven', 'elevn'],
  thirty: ['therty', 'thirtyy'],
  that: ['tht', 'thatt'],
  this: ['ths', 'thiss'],
  with: ['wth', 'wiith'],
  happened: ['hapened', 'happend'],
};

function applyTypo(utterance: string): string[] {
  const results: Set<string> = new Set();
  const lower = utterance.toLowerCase();
  for (const [word, typos] of Object.entries(TYPO_RULES)) {
    const idx = lower.indexOf(word.toLowerCase());
    if (idx === -1) continue;
    const before = utterance.slice(0, idx);
    const after = utterance.slice(idx + word.length);
    for (const typo of typos) {
      // Preserve the casing of the original token.
      const original = utterance.slice(idx, idx + word.length);
      const cased = original[0] === original[0].toUpperCase()
        ? typo.charAt(0).toUpperCase() + typo.slice(1)
        : typo;
      results.add(before + cased + after);
    }
  }

  // Missing apostrophe variants
  if (utterance.includes("today's")) results.add(utterance.replace(/today's/gi, 'todays'));
  if (utterance.includes('today’s')) results.add(utterance.replace(/today’s/gi, 'todays'));

  return Array.from(results).filter((v) => normalizeUtterance(v) !== normalizeUtterance(utterance));
}

export const typoOperator: MutationOperator = {
  name: 'typo',
  apply(scenario: Scenario, _ctx: MutationContext): MutationResult[] {
    const variants: MutationResult[] = [];
    for (let i = 0; i < scenario.turns.length; i++) {
      for (const mutated of applyTypo(scenario.turns[i].utterance)) {
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
            operators: ['typo'],
            tags: ['typo-safe', 'semantic-equivalent'],
          },
        });
      }
    }
    return variants;
  },
};
