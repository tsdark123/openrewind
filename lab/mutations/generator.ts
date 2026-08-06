import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Scenario } from '../runner/scenario-types.ts';
import { validateScenario } from '../runner/scenario-validator.ts';
import type { MutationConfig, MutationContext, MutationResult, MutationOperator } from './types.ts';
import { mutationConfigSchema } from './types.ts';
import { getOperator } from './registry.ts';
import { deepClone, hashScenario, mulberry32, shuffle, slug } from './util.ts';
import { negativeControlsOperator } from './negative-controls.ts';

export function createMutationContext(seed: number, allowNegativeControls: boolean): MutationContext {
  const rng = mulberry32(seed);
  return {
    rng,
    choose<T>(items: T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[Math.floor(rng() * items.length)];
    },
    seed,
    allowNegativeControls,
  };
}

export function loadSeedScenarios(paths: string[]): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const p of paths) {
    if (p.includes('holdout')) {
      throw new Error(`Refusing to load scenario from holdout directory: ${p}`);
    }
    const resolved = path.resolve(p);
    const raw = fs.readFileSync(resolved, 'utf8');
    scenarios.push(validateScenario(JSON.parse(raw)));
  }
  return scenarios;
}

function scenarioKey(scenario: Scenario): string {
  return JSON.stringify([
    scenario.turns.map((t) => t.utterance),
    scenario.initialWorldState.session.symbol,
    scenario.initialWorldState.session.date,
    scenario.initialWorldState.session.sessionActive,
    scenario.turns.map((t) => t.expectedOk ?? true),
  ]);
}

function applyOperator(scenario: Scenario, op: MutationOperator, ctx: MutationContext): MutationResult[] {
  try {
    return op.apply(scenario, ctx);
  } catch (e) {
    console.error(`Operator ${op.name} failed for ${scenario.id}:`, e);
    return [];
  }
}

function seedResult(seed: Scenario, sourceHash: string, cfgSeed: number): MutationResult {
  return {
    scenario: seed,
    spec: {
      version: '1.0.0',
      generatorSeed: cfgSeed,
      sourceScenarioId: seed.id,
      sourceScenarioHash: sourceHash,
      familyId: seed.familyId ?? 'unknown',
      seedId: seed.seedId,
      variantOf: seed.variantOf ?? seed.id,
      operators: ['seed'],
      tags: ['seed', 'same-session'],
    },
  };
}

function applySingleOperators(seed: Scenario, ctx: MutationContext, operatorNames: string[], limitPerOp = 3): MutationResult[] {
  const results: MutationResult[] = [];
  for (const name of operatorNames) {
    const op = getOperator(name);
    if (!op) continue;
    const opResults = applyOperator(seed, op, ctx);
    results.push(...opResults.slice(0, limitPerOp));
  }
  return results;
}

function applyPairwiseCombinations(seed: Scenario, ctx: MutationContext, operatorNames: string[], limitPerPair = 2): MutationResult[] {
  const results: MutationResult[] = [];
  const operators = operatorNames.map((n) => getOperator(n)).filter((o): o is MutationOperator => !!o);

  const firstTier = operators.filter((o) => ['lexical', 'timeExpression', 'punctuation'].includes(o.name));
  const secondTier = operators.filter((o) => ['punctuation', 'contextStates', 'symbolAlias', 'typo', 'timeExpression'].includes(o.name));

  for (const first of firstTier) {
    const firstResults = applyOperator(seed, first, ctx).slice(0, 2);
    for (const f of firstResults) {
      for (const second of secondTier) {
        if (second.name === first.name) continue;
        const secondResults = applyOperator(f.scenario, second, ctx).slice(0, limitPerPair);
        for (const s of secondResults) {
          results.push({
            scenario: s.scenario,
            spec: {
              ...s.spec,
              operators: [...new Set([...f.spec.operators, ...s.spec.operators])],
              tags: [...new Set([...f.spec.tags, ...s.spec.tags])],
            },
          });
        }
      }
    }
  }

  return results;
}

function applyStateVariants(scenario: Scenario, ctx: MutationContext): MutationResult[] {
  const stateOp = getOperator('stateVariants');
  if (!stateOp) return [];
  return applyOperator(scenario, stateOp, ctx);
}

function applyNegativeControls(scenario: Scenario, ctx: MutationContext): MutationResult[] {
  if (!ctx.allowNegativeControls) return [];
  return applyOperator(scenario, negativeControlsOperator, ctx);
}

function generateCandidatesForSeed(seed: Scenario, ctx: MutationContext, operatorNames: string[], cfgSeed: number): MutationResult[] {
  const sourceHash = hashScenario(seed);
  const candidates: MutationResult[] = [];

  candidates.push(seedResult(seed, sourceHash, cfgSeed));

  const baseNames = operatorNames.filter((n) => n !== 'stateVariants' && n !== 'negativeControl');
  candidates.push(...applySingleOperators(seed, ctx, baseNames, 20));
  candidates.push(...applyPairwiseCombinations(seed, ctx, baseNames, 2));

  // State variants for the seed and a sample of already generated base variants.
  const baseForState = candidates.filter((r) => !isNegativeControl(r)).slice(0, 3);
  for (const base of [seedResult(seed, sourceHash, cfgSeed), ...baseForState]) {
    const stateResults = applyStateVariants(base.scenario, ctx);
    for (const sr of stateResults) {
      candidates.push({
        scenario: sr.scenario,
        spec: {
          ...sr.spec,
          operators: [...new Set([...base.spec.operators, ...sr.spec.operators])],
          tags: [...new Set([...base.spec.tags, ...sr.spec.tags])],
        },
      });
    }
  }

  candidates.push(...applyNegativeControls(seed, ctx));

  return candidates;
}

function assignMetadata(
  result: MutationResult,
  seed: Scenario,
  sourceHash: string,
  index: number,
): MutationResult {
  const opSlug = slug(result.spec.operators.join('-')) || 'seed';
  const id = `${seed.id}-${opSlug}-${index}`;
  const tags = [...new Set([...(seed.tags ?? []), ...result.spec.tags, 'mutation'])];
  const scenario: Scenario = {
    ...deepClone(result.scenario),
    id,
    name: `${seed.name} (${result.spec.operators.join(', ')})`,
    familyId: seed.familyId,
    seedId: seed.seedId,
    variantOf: seed.variantOf ?? seed.id,
    tags,
    meta: { mutation: { ...result.spec, sourceScenarioHash: sourceHash } },
  };
  return { scenario, spec: { ...result.spec, sourceScenarioHash: sourceHash } };
}

function isNegativeControl(result: MutationResult): boolean {
  return result.spec.tags.includes('negative-control');
}

function sortResults(results: MutationResult[]): MutationResult[] {
  return results.slice().sort((a, b) => {
    const na = isNegativeControl(a) ? 1 : 0;
    const nb = isNegativeControl(b) ? 1 : 0;
    if (na !== nb) return na - nb;
    return a.scenario.id.localeCompare(b.scenario.id);
  });
}

function operatorGroupKey(result: MutationResult): string {
  // Group by sorted operators so combinations are still represented.
  return [...result.spec.operators].sort().join(',');
}

function selectDiverse(results: MutationResult[], maxValid: number, maxNegative: number, ctx: MutationContext): MutationResult[] {
  const valid = results.filter((r) => !isNegativeControl(r));
  const negative = results.filter((r) => isNegativeControl(r));

  const groups = new Map<string, MutationResult[]>();
  for (const r of valid) {
    const key = operatorGroupKey(r);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  // Deterministic order: seed first, then single operators, then combos.
  const groupOrder = ['seed', 'lexical', 'timeExpression', 'punctuation', 'symbolAlias', 'typo', 'contextStates'];
  const orderedKeys = [
    ...groupOrder.filter((k) => groups.has(k)),
    ...Array.from(groups.keys()).filter((k) => !groupOrder.includes(k)).sort(),
  ];

  const selected: MutationResult[] = [];
  const used = new Set<string>();

  // Reserve one slot each for important state/context configurations.
  const priorityTags = ['switch-required', 'context-present', 'context-absent'];
  for (const tag of priorityTags) {
    if (selected.length >= maxValid) break;
    const candidates = shuffle(valid.filter((r) => r.spec.tags.includes(tag) && !used.has(scenarioKey(r.scenario))), ctx.rng);
    if (candidates.length > 0) {
      used.add(scenarioKey(candidates[0].scenario));
      selected.push(candidates[0]);
    }
  }

  // Take up to 3 from each operator group, capped at maxValid.
  for (const key of orderedKeys) {
    if (selected.length >= maxValid) break;
    const group = shuffle(groups.get(key) ?? [], ctx.rng);
    for (const r of group.slice(0, 3)) {
      if (selected.length >= maxValid) break;
      const k = scenarioKey(r.scenario);
      if (used.has(k)) continue;
      used.add(k);
      selected.push(r);
    }
  }

  // Fill remaining slots with shuffled remaining valid results.
  if (selected.length < maxValid) {
    for (const r of shuffle(valid, ctx.rng)) {
      if (selected.length >= maxValid) break;
      const k = scenarioKey(r.scenario);
      if (used.has(k)) continue;
      used.add(k);
      selected.push(r);
    }
  }

  // Append negative controls up to maxNegative.
  for (const r of shuffle(negative, ctx.rng).slice(0, maxNegative)) {
    if (selected.length >= maxValid + maxNegative) break;
    const k = scenarioKey(r.scenario);
    if (used.has(k)) continue;
    selected.push(r);
  }

  return sortResults(selected);
}

export function generateMutationPreview(config: MutationConfig): {
  valid: MutationResult[];
  invalid: Array<{ scenario?: Scenario; error: string }>;
  duplicatesRemoved: number;
} {
  const cfg = mutationConfigSchema.parse(config);
  const ctx = createMutationContext(cfg.seed, cfg.includeNegativeControls);
  const seeds = loadSeedScenarios(cfg.seedScenarios);

  const allValid: MutationResult[] = [];
  const allInvalid: Array<{ scenario?: Scenario; error: string }> = [];
  let duplicatesRemoved = 0;

  // Group seeds by family so per-family limits and coverage are coherent.
  const byFamily = new Map<string, Scenario[]>();
  for (const seed of seeds) {
    const familyId = seed.familyId ?? 'unknown';
    const list = byFamily.get(familyId) ?? [];
    list.push(seed);
    byFamily.set(familyId, list);
  }

  for (const [_familyId, familySeeds] of byFamily.entries()) {
    const familyCandidates: MutationResult[] = [];

    for (const seed of familySeeds) {
      const sourceHash = hashScenario(seed);
      const candidates = generateCandidatesForSeed(seed, ctx, cfg.operatorNames, cfg.seed);

      const seenKeys = new Set<string>();
      for (let i = 0; i < candidates.length; i++) {
        const assigned = assignMetadata(candidates[i], seed, sourceHash, i);
        const key = scenarioKey(assigned.scenario);
        if (seenKeys.has(key)) {
          duplicatesRemoved++;
          continue;
        }
        seenKeys.add(key);

        try {
          validateScenario(assigned.scenario);
          familyCandidates.push(assigned);
        } catch (e) {
          allInvalid.push({
            scenario: assigned.scenario,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    const selected = selectDiverse(familyCandidates, cfg.maxVariantsPerFamily, 2, ctx);
    allValid.push(...selected);
  }

  return { valid: allValid, invalid: allInvalid, duplicatesRemoved };
}


