import type { MutationResult, MutationCoverage } from './types.ts';

function sessionStateTag(result: MutationResult): string {
  if (result.spec.tags.includes('no-session')) return 'no-session';
  if (result.spec.tags.includes('switch-required')) return 'switch-required';
  return 'same-session';
}

function contextStateTag(result: MutationResult): string {
  if (result.spec.tags.includes('context-absent')) return 'context-absent';
  if (result.spec.tags.includes('context-present')) return 'context-present';
  return 'none';
}

export function computeCoverage(results: MutationResult[]): MutationCoverage {
  const byFamily = new Map<string, MutationResult[]>();
  for (const r of results) {
    const familyId = r.spec.familyId;
    const list = byFamily.get(familyId) ?? [];
    list.push(r);
    byFamily.set(familyId, list);
  }

  const seedFamilies: MutationCoverage['seedFamilies'] = [];
  const operatorsUsed: Record<string, number> = {};

  for (const [familyId, list] of byFamily.entries()) {
    const valid = list.filter((r) => !r.spec.tags.includes('negative-control'));
    const negative = list.filter((r) => r.spec.tags.includes('negative-control'));
    const operators: Record<string, number> = {};
    const timeForms: Record<string, number> = {};
    const namedWindowForms: Record<string, number> = {};
    const symbolAliases: Record<string, number> = {};
    const sessionStates: Record<string, number> = {};
    const contextStates: Record<string, number> = {};

    for (const r of list) {
      for (const op of r.spec.operators) {
        operators[op] = (operators[op] ?? 0) + 1;
        operatorsUsed[op] = (operatorsUsed[op] ?? 0) + 1;
      }
      for (const tag of r.spec.tags) {
        if (tag.startsWith('time-')) {
          timeForms[tag.slice(5)] = (timeForms[tag.slice(5)] ?? 0) + 1;
        }
        if (tag.startsWith('named-')) {
          namedWindowForms[tag.slice(6)] = (namedWindowForms[tag.slice(6)] ?? 0) + 1;
        }
        if (tag.startsWith('symbol-')) {
          symbolAliases[tag.slice(7)] = (symbolAliases[tag.slice(7)] ?? 0) + 1;
        }
      }
      sessionStates[sessionStateTag(r)] = (sessionStates[sessionStateTag(r)] ?? 0) + 1;
      contextStates[contextStateTag(r)] = (contextStates[contextStateTag(r)] ?? 0) + 1;
    }

    seedFamilies.push({
      familyId,
      seedId: list[0]?.spec.seedId ?? 'unknown',
      validVariants: valid.length,
      negativeControls: negative.length,
      operators,
      timeExpressionForms: timeForms,
      namedWindowForms,
      symbolAliases,
      sessionStates,
      contextStates,
    });
  }

  const totalValid = results.filter((r) => !r.spec.tags.includes('negative-control')).length;
  const totalNegativeControls = results.filter((r) => r.spec.tags.includes('negative-control')).length;

  return {
    seedFamilies,
    totalValid,
    totalNegativeControls,
    totalDuplicatesRemoved: 0,
    totalInvalidRejected: 0,
    operatorsUsed,
  };
}

export function coverageToMarkdown(coverage: MutationCoverage): string {
  const lines: string[] = [
    '# Orion Scenario Lab — Mutation Preview Coverage',
    '',
    '> MUTATION PREVIEW — NOT REAL ORION EXECUTION',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total valid variants | ${coverage.totalValid} |`,
    `| Total negative controls | ${coverage.totalNegativeControls} |`,
    `| Total scenarios (valid + negative) | ${coverage.totalValid + coverage.totalNegativeControls} |`,
    `| Duplicates removed | ${coverage.totalDuplicatesRemoved} |`,
    `| Invalid rejected | ${coverage.totalInvalidRejected} |`,
    '',
    '## Operators used',
    '',
    ...Object.entries(coverage.operatorsUsed).map(([op, count]) => `- ${op}: ${count}`),
    '',
    '## Seed family coverage',
    '',
  ];

  for (const family of coverage.seedFamilies) {
    lines.push(`### ${family.familyId}`);
    lines.push('');
    lines.push(`- Seed: ${family.seedId}`);
    lines.push(`- Valid variants: ${family.validVariants}`);
    lines.push(`- Negative controls: ${family.negativeControls}`);
    lines.push(`- Operators: ${Object.entries(family.operators).map(([k, v]) => `${k}=${v}`).join(', ') || 'seed only'}`);
    lines.push(`- Time forms: ${Object.entries(family.timeExpressionForms).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
    lines.push(`- Named windows: ${Object.entries(family.namedWindowForms).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
    lines.push(`- Symbol aliases: ${Object.entries(family.symbolAliases).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
    lines.push(`- Session states: ${Object.entries(family.sessionStates).map(([k, v]) => `${k}=${v}`).join(', ') || 'same-session only'}`);
    lines.push(`- Context states: ${Object.entries(family.contextStates).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
    lines.push('');
  }

  return lines.join('\n');
}
