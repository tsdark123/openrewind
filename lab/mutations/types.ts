import { z } from 'zod';
import type { Scenario } from '../runner/scenario-types.ts';

export const mutationSpecSchema = z.object({
  version: z.string().default('1.0.0'),
  generatorSeed: z.number().int(),
  sourceScenarioId: z.string(),
  sourceScenarioHash: z.string(),
  familyId: z.string(),
  seedId: z.string().optional(),
  variantOf: z.string(),
  operators: z.array(z.string()),
  tags: z.array(z.string()).default([]),
});

export type MutationSpec = z.infer<typeof mutationSpecSchema>;

export interface MutationContext {
  rng: () => number;
  choose<T>(items: T[]): T | undefined;
  seed: number;
  allowNegativeControls: boolean;
}

export interface MutationResult {
  scenario: Scenario;
  spec: MutationSpec;
}

export interface MutationOperator {
  name: string;
  apply(scenario: Scenario, ctx: MutationContext): MutationResult[];
}

export const mutationConfigSchema = z.object({
  seedScenarios: z.array(z.string()), // paths
  operatorNames: z.array(z.string()).default([
    'lexical',
    'punctuation',
    'timeExpression',
    'symbolAlias',
    'contextStates',
    'stateVariants',
    'typo',
    'negativeControl',
  ]),
  maxVariantsPerFamily: z.number().int().default(15),
  includeNegativeControls: z.boolean().default(true),
  seed: z.number().int().default(42),
  outboxDir: z.string().default('./outbox/mutation-preview'),
});

export type MutationConfig = z.infer<typeof mutationConfigSchema>;

export interface MutationCoverage {
  seedFamilies: Array<{
    familyId: string;
    seedId: string;
    validVariants: number;
    negativeControls: number;
    operators: Record<string, number>;
    timeExpressionForms: Record<string, number>;
    namedWindowForms: Record<string, number>;
    symbolAliases: Record<string, number>;
    sessionStates: Record<string, number>;
    contextStates: Record<string, number>;
  }>;
  totalValid: number;
  totalNegativeControls: number;
  totalDuplicatesRemoved: number;
  totalInvalidRejected: number;
  operatorsUsed: Record<string, number>;
}
