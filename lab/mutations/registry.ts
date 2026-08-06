import type { MutationOperator } from './types.ts';
import { lexicalOperator } from './lexical.ts';
import { punctuationOperator } from './punctuation.ts';
import { timeExpressionOperator } from './time-expressions.ts';
import { symbolAliasOperator } from './symbol-aliases.ts';
import { contextStatesOperator } from './context-states.ts';
import { stateVariantsOperator } from './state-variants.ts';
import { typoOperator } from './typo.ts';
import { negativeControlsOperator } from './negative-controls.ts';

const operators: MutationOperator[] = [
  lexicalOperator,
  punctuationOperator,
  timeExpressionOperator,
  symbolAliasOperator,
  contextStatesOperator,
  stateVariantsOperator,
  typoOperator,
  negativeControlsOperator,
];

const registry = new Map<string, MutationOperator>();
for (const op of operators) {
  registry.set(op.name, op);
}

export function getOperator(name: string): MutationOperator | undefined {
  return registry.get(name);
}

export function listOperators(): string[] {
  return Array.from(registry.keys());
}

export function getAllOperators(): MutationOperator[] {
  return operators.slice();
}
