import { createHash } from 'node:crypto';
import type { Scenario } from '../runner/scenario-types.ts';

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `"${k}":${stableStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

export function hashScenario(scenario: Scenario): string {
  const clone = deepClone(scenario);
  delete (clone as { meta?: unknown }).meta;
  return createHash('sha256').update(stableStringify(clone)).digest('hex').slice(0, 16);
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeUtterance(text: string): string {
  return text.trim().toLowerCase().replace(/[\s!?.,;:]+/g, ' ').trim();
}

export function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(array: T[], rng: () => number): T[] {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
