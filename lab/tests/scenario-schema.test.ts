import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScenario, loadScenario } from '../runner/scenario-validator.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.resolve(__dirname, '..', 'scenarios');

describe('scenario schema validation', () => {
  it('validates all regression scenarios', () => {
    const dir = path.join(scenariosDir, 'regression');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const scenario = loadScenario(path.join(dir, file));
      expect(scenario.id).toBeDefined();
      expect(scenario.turns.length).toBeGreaterThan(0);
    }
  });

  it('validates all smoke scenarios', () => {
    const dir = path.join(scenariosDir, 'smoke');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const scenario = loadScenario(path.join(dir, file));
      expect(scenario.id).toBeDefined();
    }
  });

  it('rejects a scenario with an invalid date', () => {
    const bad = {
      id: 'bad',
      name: 'bad',
      dataSet: { symbol: 'X', date: 'not-a-date', timeframe: 1 },
      initialWorldState: {
        session: {
          symbol: 'X',
          date: 'not-a-date',
          timeframe: 1,
          cursor: 0,
          totalCandles: 1,
          isPlaying: false,
          speed: 1,
          direction: 'forward',
          currentPrice: 1,
          sessionActive: true,
        },
        availableTickers: [],
        recentCandles: [],
      },
      turns: [{ id: 't1', utterance: 'test' }],
    };
    expect(() => validateScenario(bad)).toThrow();
  });
});
