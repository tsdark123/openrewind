import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProductionCapabilityNames } from '../runner/capability-registry.ts';

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

function extractFromSource(): string[] {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const re = /name\s*:\s*['"]([^'"]+)['"]/g;
  const seen = new Set<string>();
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    if (!name.includes('.') || !/^[a-z_.]+$/.test(name)) continue;
    if (seen.has(name)) {
      throw new Error(`Duplicate capability ID in production source: ${name}`);
    }
    seen.add(name);
    names.push(name);
  }
  return names.sort();
}

describe('production capability registry drift', () => {
  it('frozen registry matches the production source exactly', () => {
    const sourceNames = extractFromSource();
    const frozenNames = Array.from(getProductionCapabilityNames()).sort();
    expect(frozenNames).toEqual(sourceNames);
  });

  it('has no duplicate capability IDs', () => {
    const names = extractFromSource();
    expect(new Set(names).size).toBe(names.length);
  });

  it('contains the expected 19 production capabilities', () => {
    const names = Array.from(getProductionCapabilityNames()).sort();
    expect(names).toHaveLength(19);
    expect(names).toContain('session.switch_symbol');
    expect(names).toContain('chart.set_timeframe');
    expect(names).toContain('playback.seek_to_time');
    expect(names).toContain('analysis.window_compare');
    expect(names).toContain('analysis.candle_shape');
  });
});
