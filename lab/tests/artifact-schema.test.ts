import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArtifact } from '../runner/scenario-validator.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('artifact schema', () => {
  it('has generated schema files', () => {
    const scenarioSchema = path.resolve(__dirname, '..', 'schemas', 'orion-scenario-v2.schema.json');
    const artifactSchema = path.resolve(__dirname, '..', 'schemas', 'artifact-v1.schema.json');
    expect(fs.existsSync(scenarioSchema)).toBe(true);
    expect(fs.existsSync(artifactSchema)).toBe(true);
  });

  it('validates a scenario result envelope', () => {
    const envelope = {
      type: 'orion.scenario_result',
      version: '1.0.0',
      payload: {
        runId: 'r1',
        timestamp: '2026-08-05T12:00:00.000Z',
        mode: 'fixture',
        scenarioId: 'whole-session-summary',
        repetition: 1,
        dataSet: { symbol: 'SYNTH', date: '2026-08-05', timeframe: 1 },
        status: 'pass',
        durationMs: 0,
        turns: [],
      },
    };
    const parsed = validateArtifact(envelope);
    expect(parsed).toBeDefined();
  });

  it('validates a run summary envelope', () => {
    const envelope = {
      type: 'orion.run_summary',
      version: '1.0.0',
      payload: {
        runId: 'r1',
        mode: 'fixture',
        timestamp: '2026-08-05T12:00:00.000Z',
        startTime: '2026-08-05T11:59:00.000Z',
        endTime: '2026-08-05T12:00:00.000Z',
        scenarioCount: 1,
        passCount: 1,
        failCount: 0,
        timeoutCount: 0,
        skipCount: 0,
      },
    };
    const parsed = validateArtifact(envelope);
    expect(parsed).toBeDefined();
  });
});
