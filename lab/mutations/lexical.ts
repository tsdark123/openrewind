import type { MutationOperator, MutationResult, MutationContext } from './types.ts';
import type { Scenario, Turn } from '../runner/scenario-types.ts';
import { deepClone, normalizeUtterance } from './util.ts';

type LexicalRule = {
  pattern: RegExp;
  variants: string[];
  build: (original: string, match: RegExpMatchArray, variant: string) => string;
};

const rules: LexicalRule[] = [
  {
    // candle at explicit or spoken time
    pattern: /^(What kind of candle was|Describe|Tell me about|Show me|What did the candle look like (?:for|at)|How did the candle behave (?:for|at)) the (.+) candle\??$/i,
    variants: [
      'What kind of candle was',
      'Describe',
      'Tell me about',
      'Show me',
      'What did the candle look like for',
      'How did the candle behave for',
    ],
    build: (_original, match, variant) => {
      const time = match[2];
      const q = _original.endsWith('?') ? '?' : '';
      return `${variant} the ${time} candle${q}`;
    },
  },
  {
    // candle at time using "at" instead of "the ... candle"
    pattern: /^(Describe|Tell me about|Show me|What did the candle look like at|How did the candle behave at) (.+?)\.?$/i,
    variants: [
      'Describe the candle at',
      'Tell me about the candle at',
      'Show me the candle at',
      'What did the candle look like at',
      'How did the candle behave at',
    ],
    build: (_original, match, variant) => {
      const tail = match[2];
      const q = _original.endsWith('?') ? '?' : '.';
      return `${variant} ${tail}${q}`;
    },
  },
  {
    // session summary
    pattern: /^(Describe|Tell me about|What happened with|Show me|Summarize) (what happened today|today['']s session|today['']s activity|this session)\.?$/i,
    variants: [
      'Describe what happened today',
      'Tell me about what happened today',
      'What happened with this session',
      'Show me today\'s session summary',
      'Summarize today\'s activity',
    ],
    build: (_original, _match, variant) => {
      const q = _original.endsWith('?') ? '?' : '.';
      return `${variant}${q}`;
    },
  },
  {
    // first hour range request
    pattern: /^(first hour range|range of the first hour|first 60 minute range|opening hour range)\??$/i,
    variants: [
      'first hour range',
      'range of the first hour',
      'first 60 minute range',
      'opening hour range',
    ],
    build: (_original, __match, variant) => {
      const q = _original.endsWith('?') ? '?' : '';
      return `${variant}${q}`;
    },
  },
  {
    // compare that with the last hour
    pattern: /^Compare (that|it) (with|to|against) (the |the final |the last |the last 60 minutes of )?(last hour|final hour|last 60 minutes)\.?$/i,
    variants: [
      'Compare $1 $2 $3$4',
      'Compare $1 $2 the final $4',
      'Compare $1 $2 the last 60 minutes',
      'Now compare $1 $2 $3$4',
      'Do the same comparison $2 $3$4',
    ],
    build: (_original, match, variant) => {
      const pronoun = match[1];
      const prep = match[2];
      const modifier = match[3] ?? '';
      const window = match[4];
      return variant
        .replace(/\$1/g, pronoun)
        .replace(/\$2/g, prep)
        .replace(/\$3/g, modifier)
        .replace(/\$4/g, window) + '.';
    },
  },
  {
    // unsupported follow-up
    pattern: /^(What can we do with|What can you do with|What should we do with|Can we act on|How do we trade) (that|this)\??$/i,
    variants: [
      'What can we do with $2',
      'What can you do with $2',
      'What should we do with $2',
      'Can we act on $2',
      'How do we trade $2',
    ],
    build: (_original, match, variant) => {
      const pronoun = match[2];
      const q = _original.endsWith('?') ? '?' : '.';
      return variant.replace(/\$2/g, pronoun) + q;
    },
  },
];

function lexicalVariantsForTurn(turn: Turn, _ctx: MutationContext): Turn[] {
  const results: Turn[] = [];
  const norm = normalizeUtterance(turn.utterance);
  for (const rule of rules) {
    const match = turn.utterance.match(rule.pattern);
    if (!match) continue;
    for (const variant of rule.variants) {
      const built = rule.build(turn.utterance, match, variant)
        .replace(/\$\d/g, ''); // remove any unmatched placeholders
      if (normalizeUtterance(built) === norm) continue;
      results.push({ ...deepClone(turn), utterance: built });
    }
  }
  return results;
}

export const lexicalOperator: MutationOperator = {
  name: 'lexical',
  apply(scenario: Scenario, ctx: MutationContext): MutationResult[] {
    const variants: MutationResult[] = [];
    for (let i = 0; i < scenario.turns.length; i++) {
      const mutatedTurns = lexicalVariantsForTurn(scenario.turns[i], ctx);
      for (const mutatedTurn of mutatedTurns) {
        const newTurns = [...scenario.turns];
        newTurns[i] = mutatedTurn;
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
            operators: ['lexical'],
            tags: ['lexical', 'semantic-equivalent'],
          },
        });
      }
    }
    return variants;
  },
};
