import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateMutationPreview } from '../mutations/generator.ts';
import { computeCoverage, coverageToMarkdown } from '../mutations/coverage.ts';

const seedScenarios = [
  'scenarios/regression/explicit-time-candle-1130.json',
  'scenarios/regression/spoken-time-candle-1130.json',
  'scenarios/regression/first-hour-vs-last-hour.json',
  'scenarios/regression/describe-whole-session.json',
  'scenarios/regression/candle-anatomy-follow-up-unsupported.json',
];

const outboxDir = 'outbox/mutation-preview';
const scenariosDir = path.join(outboxDir, 'scenarios');

async function main() {
  const resolvedSeeds = seedScenarios.map((p) => path.resolve(p));

  const { valid, invalid, duplicatesRemoved } = generateMutationPreview({
    seedScenarios: resolvedSeeds,
    operatorNames: ['lexical', 'punctuation', 'timeExpression', 'symbolAlias', 'contextStates', 'stateVariants', 'typo'],
    maxVariantsPerFamily: 15,
    includeNegativeControls: true,
    seed: 42,
    outboxDir,
  });

  fs.mkdirSync(scenariosDir, { recursive: true });

  const scenarioPaths: string[] = [];
  const jsonlLines: string[] = [];

  for (const result of valid) {
    const fileName = `${result.scenario.id}.json`;
    const filePath = path.join(scenariosDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(result.scenario, null, 2));
    scenarioPaths.push(filePath);
    jsonlLines.push(JSON.stringify({ scenario: result.scenario, mutation: result.spec }));
  }

  fs.writeFileSync(path.join(outboxDir, 'scenarios.jsonl'), jsonlLines.join('\n'));
  fs.writeFileSync(
    path.join(outboxDir, 'manifest.json'),
    JSON.stringify({ scenarios: scenarioPaths }, null, 2),
  );

  const coverage = computeCoverage(valid);
  coverage.totalInvalidRejected = invalid.length;
  coverage.totalDuplicatesRemoved = duplicatesRemoved;

  fs.writeFileSync(path.join(outboxDir, 'coverage.json'), JSON.stringify(coverage, null, 2));
  fs.writeFileSync(path.join(outboxDir, 'coverage.md'), coverageToMarkdown(coverage));

  if (invalid.length > 0) {
    fs.writeFileSync(path.join(outboxDir, 'invalid.json'), JSON.stringify(invalid, null, 2));
  }

  const validCount = valid.filter((r) => !r.spec.tags.includes('negative-control')).length;
  const negativeCount = valid.filter((r) => r.spec.tags.includes('negative-control')).length;

  console.log('Mutation preview generated.');
  console.log(`  Scenarios: ${scenarioPaths.length}`);
  console.log(`  Valid: ${validCount}`);
  console.log(`  Negative controls: ${negativeCount}`);
  console.log(`  Invalid: ${invalid.length}`);
  console.log(`  Duplicates removed: ${duplicatesRemoved}`);
  console.log(`  Outbox: ${path.resolve(outboxDir)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
