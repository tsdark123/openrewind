import { describe, it } from 'vitest';
import { makeEmptyContext, makeContextFixture, tickers } from './bakeoff-suite';
import { runOneRepetition } from './bakeoff-runner';

process.env.OLLAMA_NUM_PARALLEL = '1';

const MODEL = process.env.OLLAMA_MODEL ?? 'qwen3:8b';

interface MatrixCase {
  id: string;
  text: string;
  profile: 'active' | 'empty';
  expected: 'chart_action' | 'clarification' | 'unsupported';
  gold?: Record<string, unknown>;
}

function makePrompt(c: MatrixCase) {
  return {
    id: 0,
    text: c.text,
    profile: c.profile,
    bucket: c.expected === 'clarification' || c.expected === 'unsupported' ? ('safety' as const) : ('primary' as const),
    expected: c.expected,
    gold: c.gold as any,
    makeContext: c.profile === 'active' ? makeContextFixture : makeEmptyContext,
  };
}

const cases: MatrixCase[] = [
  // Prompt #5 variations: colloquial time and compound-command structure
  { id: '5a', text: 'Switch to AAPL, go back two sessions, set 15m and seek to quarter to three p.m.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', date: { kind: 'relative_trading', count: 2, direction: 'backward' }, timeframeMinutes: 15, seekTime: '14:45' } },
  { id: '5b', text: 'Park the replay at quarter to three p.m.', profile: 'active', expected: 'chart_action', gold: { kind: 'chart_action', seekTime: '14:45' } },
  { id: '5c', text: 'Park the replay at quarter to three in the afternoon.', profile: 'active', expected: 'chart_action', gold: { kind: 'chart_action', seekTime: '14:45' } },
  { id: '5d', text: 'Park the replay at 2:45 p.m.', profile: 'active', expected: 'chart_action', gold: { kind: 'chart_action', seekTime: '14:45' } },
  { id: '5e', text: 'Park the replay at 14:45.', profile: 'active', expected: 'chart_action', gold: { kind: 'chart_action', seekTime: '14:45' } },
  { id: '5f', text: 'Switch to AAPL and seek to quarter to three p.m.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', seekTime: '14:45' } },
  { id: '5g', text: 'Switch to AAPL, set 15m and seek to quarter to three p.m.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 15, seekTime: '14:45' } },
  { id: '5h', text: 'Switch to AAPL, go back two sessions and seek to quarter to three p.m.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', date: { kind: 'relative_trading', count: 2, direction: 'backward' }, seekTime: '14:45' } },
  { id: '5i', text: 'Go back two sessions, switch to AAPL, set 15m and seek to quarter to three p.m.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', date: { kind: 'relative_trading', count: 2, direction: 'backward' }, timeframeMinutes: 15, seekTime: '14:45' } },
  { id: '5j', text: 'Switch to AAPL, go back two trading sessions, set 15m and seek to quarter to three p.m.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', date: { kind: 'relative_trading', count: 2, direction: 'backward' }, timeframeMinutes: 15, seekTime: '14:45' } },

  // Quarter-past / half-past / noon / a.m./p.m. probes
  { id: '5k', text: 'Switch to AAPL, set 15m and seek to quarter past three p.m.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 15, seekTime: '15:15' } },
  { id: '5l', text: 'Switch to AAPL, set 15m and seek to half past three p.m.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 15, seekTime: '15:30' } },
  { id: '5m', text: 'Switch to AAPL, set 15m and seek to three p.m.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 15, seekTime: '15:00' } },
  { id: '5n', text: 'Switch to AAPL, set 15m and seek to noon.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', symbol: 'AAPL', timeframeMinutes: 15, seekTime: '12:00' } },

  // Invalid-time / #21 variations
  { id: '21a', text: 'Jump to 25:00.', profile: 'empty', expected: 'clarification' },
  { id: '21b', text: 'Jump to 24:30.', profile: 'empty', expected: 'clarification' },
  { id: '21c', text: 'Jump to 13:75.', profile: 'empty', expected: 'clarification' },
  { id: '21d', text: 'Jump to 00:00.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', seekTime: '00:00' } },
  { id: '21e', text: 'Jump to 23:59.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', seekTime: '23:59' } },
  { id: '21f', text: 'Jump to 18:00.', profile: 'empty', expected: 'chart_action', gold: { kind: 'chart_action', seekTime: '18:00' } },
  { id: '21g', text: 'Park the replay at 25:00.', profile: 'active', expected: 'clarification' },
  { id: '21h', text: 'What is the price at 25:00?', profile: 'empty', expected: 'clarification' },
];

describe('orion diagnostic matrix', () => {
  it(`runs the ${MODEL} diagnostic matrix`, async () => {
    const results: any[] = [];
    for (const c of cases) {
      const prompt = makePrompt(c);
      const r = await runOneRepetition(prompt, MODEL, 1, {
        model: MODEL,
        numCtx: 4096,
        numPredict: 160,
        temperature: 0,
        seed: 42,
      });

      const pipeline = r.pipeline;
      const kind = pipeline.finalValidatedIntent?.kind ?? pipeline.preSanitizeInput?.kind ?? 'none';
      const row = {
        id: c.id,
        text: c.text,
        expected: c.expected,
        raw: r.raw.rawText,
        rawValid: r.raw.initialValid,
        rawError: r.raw.initialError,
        repairRequired: r.raw.repairRequired,
        preSanitize: pipeline.preSanitizeInput,
        finalKind: kind,
        finalIntent: pipeline.finalValidatedIntent,
        finalError: pipeline.finalError,
        planValidation: pipeline.planValidation,
        compiledPlan: pipeline.compiledPlan?.steps.map((s: any) => s.capability),
        pipelinePass: pipeline.pipelinePass,
        safetyExecutablePlanProduced: r.safetyExecutablePlanProduced,
        safetyClassificationMatch: r.safetyClassificationMatch,
      };
      results.push(row);
    }

    for (const row of results) {
      console.log(`\n[${row.id}] ${row.text}`);
      console.log(`  expected: ${row.expected}`);
      console.log(`  raw: ${row.raw}`);
      console.log(`  rawValid: ${row.rawValid} (${row.rawError || 'none'})`);
      console.log(`  finalKind: ${row.finalKind}`);
      console.log(`  finalIntent: ${JSON.stringify(row.finalIntent)}`);
      console.log(`  compiledPlan: ${JSON.stringify(row.compiledPlan)}`);
      console.log(`  pipelinePass: ${row.pipelinePass}  classificationMatch: ${row.safetyClassificationMatch}`);
    }
  }, 900000);
});
