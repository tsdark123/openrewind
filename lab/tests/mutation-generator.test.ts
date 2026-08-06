import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMutationPreview } from '../mutations/generator.ts';
import { findMetamorphicViolations } from '../mutations/metamorphic.ts';
import { computeCoverage } from '../mutations/coverage.ts';
import { listProductionCapabilityNames } from '../runner/capability-registry.ts';
import { validateScenario } from '../runner/scenario-validator.ts';
import type { Scenario } from '../runner/scenario-types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const seedScenarios = [
  path.resolve(__dirname, '../scenarios/regression/explicit-time-candle-1130.json'),
  path.resolve(__dirname, '../scenarios/regression/spoken-time-candle-1130.json'),
  path.resolve(__dirname, '../scenarios/regression/first-hour-vs-last-hour.json'),
  path.resolve(__dirname, '../scenarios/regression/describe-whole-session.json'),
  path.resolve(__dirname, '../scenarios/regression/candle-anatomy-follow-up-unsupported.json'),
];

const run = () => generateMutationPreview({
  seedScenarios,
  operatorNames: ['lexical', 'punctuation', 'timeExpression', 'symbolAlias', 'contextStates', 'stateVariants', 'typo'],
  maxVariantsPerFamily: 15,
  includeNegativeControls: true,
  seed: 42,
  outboxDir: 'outbox/mutation-preview',
});

let result: ReturnType<typeof run>;

beforeAll(() => {
  result = run();
});

describe('mutation generator', () => {
  it('is deterministic from the same seed', () => {
    const second = run();
    expect(second.valid.map((r) => r.scenario.id)).toEqual(result.valid.map((r) => r.scenario.id));
    expect(second.duplicatesRemoved).toBe(result.duplicatesRemoved);
    expect(second.invalid.length).toBe(result.invalid.length);
  });

  it('produces controlled differences with a different seed', () => {
    const different = generateMutationPreview({
      seedScenarios,
      operatorNames: ['lexical', 'punctuation', 'timeExpression', 'symbolAlias', 'contextStates', 'stateVariants', 'typo'],
      maxVariantsPerFamily: 15,
      includeNegativeControls: true,
      seed: 43,
      outboxDir: 'outbox/mutation-preview',
    });
    // Same set size but different IDs are expected because per-operator ordering is deterministic.
    expect(different.valid.length).toBe(result.valid.length);
    expect(different.valid.map((r) => r.scenario.id)).not.toEqual(result.valid.map((r) => r.scenario.id));
  });

  it('has no duplicate scenario IDs', () => {
    const ids = result.valid.map((r) => r.scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate utterance + initial-state combinations', () => {
    const keys = result.valid.map((r) => JSON.stringify([
      r.scenario.turns.map((t) => t.utterance),
      r.scenario.initialWorldState.session.symbol,
      r.scenario.initialWorldState.session.date,
      r.scenario.initialWorldState.session.sessionActive,
    ]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('preserves familyId, seedId, and variantOf integrity', () => {
    for (const { scenario, spec } of result.valid) {
      expect(scenario.familyId).toBe(spec.familyId);
      expect(scenario.seedId).toBe(spec.seedId);
      expect(scenario.variantOf).toBe(spec.variantOf);
      const mutation = scenario.meta?.mutation as { sourceScenarioHash?: string } | undefined;
      expect(mutation).toBeDefined();
      expect(mutation?.sourceScenarioHash).toBeTruthy();
    }
  });

  it('validates every generated scenario against the schema', () => {
    for (const { scenario } of result.valid) {
      expect(() => validateScenario(scenario)).not.toThrow();
    }
  });

  it('only uses production capability names', () => {
    const allowed = new Set(listProductionCapabilityNames());
    for (const { scenario } of result.valid) {
      for (const turn of scenario.turns) {
        for (const cap of turn.expectedCapabilities ?? []) {
          expect(allowed.has(cap)).toBe(true);
        }
        for (const cap of turn.forbiddenActions ?? []) {
          expect(allowed.has(cap) || cap.includes('*')).toBe(true);
        }
        for (const cap of turn.permittedActions ?? []) {
          expect(allowed.has(cap) || cap.includes('*')).toBe(true);
        }
      }
    }
  });

  it('finds no metamorphic violations among semantically equivalent variants', () => {
    const scenarios = result.valid
      .filter((r) => !r.spec.tags.includes('negative-control'))
      .map((r) => r.scenario);
    const violations = findMetamorphicViolations(scenarios);
    expect(violations).toEqual([]);
  });

  it('classifies ambiguous or invalid mutations as negative controls', () => {
    const negative = result.valid.filter((r) => r.spec.tags.includes('negative-control'));
    expect(negative.length).toBeGreaterThan(0);
    for (const { scenario } of negative) {
      expect(scenario.tags).toContain('negative-control');
    }
  });

  it('rejects holdout scenarios as mutation input', () => {
    expect(() => generateMutationPreview({
      seedScenarios: [path.resolve(__dirname, '../holdout/permanent/example.json')],
      operatorNames: ['lexical'],
      maxVariantsPerFamily: 15,
      includeNegativeControls: true,
      seed: 42,
      outboxDir: 'outbox/mutation-preview',
    })).toThrow(/holdout/);
  });

  it('produces a correct coverage report', () => {
    const coverage = computeCoverage(result.valid);
    expect(coverage.totalValid).toBeGreaterThanOrEqual(60);
    expect(coverage.totalNegativeControls).toBeGreaterThan(0);
    expect(Object.keys(coverage.operatorsUsed).length).toBeGreaterThan(0);
  });

  it('keeps generated counts within configured family limits', () => {
    const byFamily = new Map<string, Scenario[]>();
    for (const { scenario } of result.valid) {
      const list = byFamily.get(scenario.familyId ?? 'unknown') ?? [];
      list.push(scenario);
      byFamily.set(scenario.familyId ?? 'unknown', list);
    }
    for (const [_familyId, list] of byFamily.entries()) {
      expect(list.length).toBeLessThanOrEqual(17); // 15 valid + 2 negative max per family
      expect(list.length).toBeGreaterThanOrEqual(10);
    }
  });

  it('does not import production source files', () => {
    // Lab-only mutation code must not reach outside lab/.
    const files = [
      'generator.ts',
      'lexical.ts',
      'punctuation.ts',
      'time-expressions.ts',
      'symbol-aliases.ts',
      'context-states.ts',
      'state-variants.ts',
      'typo.ts',
      'negative-controls.ts',
      'metamorphic.ts',
      'coverage.ts',
      'registry.ts',
      'types.ts',
      'util.ts',
    ];
    const labRoot = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allowedPackages = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    for (const file of files) {
      const text = fs.readFileSync(path.resolve(__dirname, '../mutations', file), 'utf8');
      const importPaths = [...text.matchAll(/from ['"]([^'"]+)['"];?/g)].map((m) => m[1]);
      for (const p of importPaths) {
        // Node built-ins and lab dependencies are allowed; relative imports must stay inside lab/.
        if (p.startsWith('node:') || p.startsWith('npm:')) continue;
        if (allowedPackages.has(p.split('/')[0])) continue;
        expect(p.startsWith('../') || p.startsWith('./')).toBe(true);
        const resolved = path.resolve(__dirname, '../mutations', p);
        expect(resolved.startsWith(labRoot + path.sep)).toBe(true);
      }
    }
  });

  it('does not fabricate fixture or production results', () => {
    for (const { scenario } of result.valid) {
      expect(scenario.meta?.mutation).toBeDefined();
      expect(scenario.meta).not.toHaveProperty('result');
      expect(scenario.meta).not.toHaveProperty('fixture');
      expect(scenario.meta).not.toHaveProperty('execution');
    }
  });
});
