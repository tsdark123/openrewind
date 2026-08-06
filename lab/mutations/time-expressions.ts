import type { MutationOperator, MutationResult, MutationContext } from './types.ts';
import type { Scenario } from '../runner/scenario-types.ts';
import { deepClone } from './util.ts';

interface EquivalenceGroup {
  canonical: string;
  forms: { text: string; tag: string }[];
}

const TIME_GROUPS: EquivalenceGroup[] = [
  {
    canonical: '11:30',
    forms: [
      { text: '11:30', tag: 'time-11:30' },
      { text: '11:30 AM', tag: 'time-11:30-am' },
      { text: 'eleven thirty', tag: 'time-eleven-thirty' },
      { text: 'half past eleven', tag: 'time-half-past-eleven' },
    ],
  },
  {
    canonical: '11:45',
    forms: [
      { text: '11:45', tag: 'time-11:45' },
      { text: 'quarter to noon', tag: 'time-quarter-to-noon' },
      { text: 'eleven forty-five', tag: 'time-eleven-forty-five' },
    ],
  },
];

const NAMED_WINDOW_GROUPS: EquivalenceGroup[] = [
  {
    canonical: 'first hour',
    forms: [
      { text: 'first hour', tag: 'named-first-hour' },
      { text: 'first-hour', tag: 'named-first-hour-hyphen' },
      { text: 'opening hour', tag: 'named-opening-hour' },
      { text: 'first 60 minutes', tag: 'named-first-60-minutes' },
    ],
  },
  {
    canonical: 'last hour',
    forms: [
      { text: 'last hour', tag: 'named-last-hour' },
      { text: 'final hour', tag: 'named-final-hour' },
      { text: 'last 60 minutes', tag: 'named-last-60-minutes' },
    ],
  },
];

function replaceToken(
  utterance: string,
  group: EquivalenceGroup,
): Array<{ text: string; tags: string[] }> {
  const results: Array<{ text: string; tags: string[] }> = [];
  const lower = utterance.toLowerCase();
  const idx = lower.indexOf(group.canonical);
  if (idx === -1) return [];
  const before = utterance.slice(0, idx);
  const after = utterance.slice(idx + group.canonical.length);
  for (const form of group.forms) {
    if (form.text.toLowerCase() === group.canonical) continue;
    const candidate = before + form.text + after;
    if (candidate !== utterance) {
      results.push({ text: candidate, tags: [form.tag] });
    }
  }
  return results;
}

function timeAndWindowVariants(utterance: string): Array<{ text: string; tags: string[] }> {
  const results: Array<{ text: string; tags: string[] }> = [];
  for (const group of TIME_GROUPS) {
    results.push(...replaceToken(utterance, group));
  }
  for (const group of NAMED_WINDOW_GROUPS) {
    results.push(...replaceToken(utterance, group));
  }
  return results;
}

export const timeExpressionOperator: MutationOperator = {
  name: 'timeExpression',
  apply(scenario: Scenario, ctx: MutationContext): MutationResult[] {
    const variants: MutationResult[] = [];
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      const unique = new Map<string, { text: string; tags: string[] }>();
      for (const item of timeAndWindowVariants(turn.utterance)) {
        if (!unique.has(item.text)) unique.set(item.text, item);
      }
      for (const { text, tags } of unique.values()) {
        const newTurns = [...scenario.turns];
        newTurns[i] = { ...deepClone(turn), utterance: text };
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
            operators: ['timeExpression'],
            tags: ['time-expression', 'semantic-equivalent', ...tags],
          },
        });
      }
    }
    return variants;
  },
};
