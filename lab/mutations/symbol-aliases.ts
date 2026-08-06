import type { MutationOperator, MutationResult, MutationContext } from './types.ts';
import type { Scenario, Turn } from '../runner/scenario-types.ts';
import { deepClone } from './util.ts';

export const SYMBOL_ALIASES: Record<string, string[]> = {
  SYNTH: ['SYNTH', 'Synthetic', 'the Synthetic symbol', 'the SYNTH ticker'],
  AAPL: ['AAPL', 'Apple', 'Apple stock', 'the Apple ticker'],
};

export function chooseSymbolPhrase(symbol: string): string {
  return SYMBOL_ALIASES[symbol]?.[0] ?? symbol;
}

function symbolPhraseVariants(symbol: string): Array<{ alias: string; tag: string }> {
  const aliases = SYMBOL_ALIASES[symbol] ?? [symbol];
  return aliases
    .filter((a) => a !== symbol)
    .map((a) => ({ alias: a, tag: `symbol-${a.toLowerCase().replace(/\s+/g, '-')}` }));
}

function appendSymbolPhrase(turn: Turn, symbol: string): Array<{ text: string; tag: string }> {
  const variants: Array<{ text: string; tag: string }> = [];
  const utterance = turn.utterance;
  const q = utterance.endsWith('?') ? '?' : '.';
  const base = utterance.replace(/[.!?]$/, '');
  for (const { alias, tag } of symbolPhraseVariants(symbol)) {
    variants.push({ text: `${base} for ${alias}${q}`, tag });
  }
  return variants;
}

export const symbolAliasOperator: MutationOperator = {
  name: 'symbolAlias',
  apply(scenario: Scenario, ctx: MutationContext): MutationResult[] {
    const variants: MutationResult[] = [];
    const symbol = scenario.dataSet.symbol;
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      for (const { text, tag } of appendSymbolPhrase(turn, symbol)) {
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
            operators: ['symbolAlias'],
            tags: ['symbol-alias', 'semantic-equivalent', tag],
          },
        });
      }
    }
    return variants;
  },
};
