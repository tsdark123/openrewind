/**
 * Frozen production capability-name registry.
 *
 * The names are extracted from `frontend/src/lib/orion/agent/capabilities.ts`
 * by `scripts/extract-capabilities.ts` and committed as
 * `runner/production-capability-names.json`.
 *
 * The lab uses these names only for validation; numerical truth remains
 * independent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(__dirname, 'production-capability-names.json');

let _names: Set<string> | undefined;

export function getProductionCapabilityNames(): Set<string> {
  if (!_names) {
    const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { names: string[] };
    _names = new Set(raw.names);
  }
  return _names;
}

export function isProductionCapability(name: string): boolean {
  return getProductionCapabilityNames().has(name);
}

export function validateCapabilityName(name: string, context: string): string[] {
  const errors: string[] = [];
  if (!isProductionCapability(name)) {
    errors.push(`${context}: unknown capability "${name}". Allowed names are the 19 production capabilities in runner/production-capability-names.json.`);
  }
  return errors;
}

export function listProductionCapabilityNames(): string[] {
  return Array.from(getProductionCapabilityNames()).sort();
}
