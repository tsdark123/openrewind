/**
 * Statically extract the production Orion capability names from the
 * production registry without executing production code.
 *
 * This is a frozen, read-only snapshot used only for capability-name
 * validation in the lab. It does not import any production numerical logic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const sourcePath = path.join(
  repoRoot,
  'frontend',
  'src',
  'lib',
  'orion',
  'agent',
  'capabilities.ts',
);
const outPath = path.join(__dirname, '..', 'runner', 'production-capability-names.json');

function main() {
  if (!fs.existsSync(sourcePath)) {
    console.warn(`Production capability source not found: ${sourcePath}`);
    process.exit(1);
  }

  const source = fs.readFileSync(sourcePath, 'utf8');

  // Extract every string assigned to the `name` property inside a capability
  // definition object: `name: 'analysis.candle_shape',` or `name: "..."`.
  const re = /name\s*:\s*['"]([^'"]+)['"]/g;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    // Filter out obvious non-capability strings (e.g., property keys or unrelated lines).
    if (name.includes('.') && /^[a-z_.]+$/.test(name)) {
      if (!names.includes(name)) names.push(name);
    }
  }

  names.sort();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ names }, null, 2));
  console.log(`Extracted ${names.length} capability names to ${outPath}`);
  for (const name of names) {
    console.log(`  ${name}`);
  }
}

main();
