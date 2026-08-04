import { readFileSync } from 'fs';
import { join } from 'path';

const outDir = 'frontend/benchmark/orion/output';

const resultFiles = [
  'stage1-qwen3_8b-2026-08-04T03-09-30-585Z.json',
];

const prompts = {
  5: {
    text: 'Switch to AAPL, go back two sessions, set 15m and seek to quarter to three p.m.',
    expected: {
      kind: 'chart_action',
      symbol: 'AAPL',
      date: { kind: 'relative_trading', count: 2, direction: 'backward' },
      timeframeMinutes: 15,
      seekTime: '14:45',
      finalQuery: 'current_candle',
    },
    expectedPlan: ['session.resolve_symbol', 'session.switch_symbol', 'chart.get_current_candle'],
  },
  21: {
    text: 'Jump to 25:00.',
    expected: 'clarification',
    expectedPlan: null,
  },
};

function describeDiff(initial, expected) {
  const diffs = [];
  for (const [k, v] of Object.entries(expected)) {
    if (JSON.stringify(initial[k]) !== JSON.stringify(v)) {
      diffs.push(`  ${k}: got ${JSON.stringify(initial[k])} expected ${JSON.stringify(v)}`);
    }
  }
  return diffs.join('\n') || '  (no field differences)';
}

for (const f of resultFiles) {
  const data = JSON.parse(readFileSync(join(outDir, f), 'utf8'));
  console.log(`\n=== Forensics from ${f} ===`);

  for (const [pid, meta] of Object.entries(prompts)) {
    const pidNum = Number(pid);
    const reps = data.results.filter((r) => r.promptId === pidNum);
    console.log(`\n--- Prompt #${pid}: "${meta.text}" ---`);
    console.log(`Expected final intent: ${JSON.stringify(meta.expected)}`);
    console.log(`Expected plan: ${meta.expectedPlan ? JSON.stringify(meta.expectedPlan) : 'none (non-executable)'}`);

    for (const r of reps) {
      console.log(`\n  Repetition ${r.repetition}`);
      console.log(`  rawText: ${r.raw.rawText}`);
      if (r.raw.repairRawText) {
        console.log(`  repairText: ${r.raw.repairRawText}`);
      } else {
        console.log(`  repairText: none`);
      }
      console.log(`  initialParsed: ${JSON.stringify(r.raw.initialParsed)}`);
      console.log(`  initialValid: ${r.raw.initialValid}`);
      console.log(`  initialError: ${r.raw.initialError || 'none'}`);
      console.log(`  repairRequired: ${r.raw.repairRequired}`);
      console.log(`  repairParsed: ${JSON.stringify(r.raw.repairParsed)}`);
      console.log(`  repairValid: ${r.raw.repairValid}`);
      console.log(`  preSanitizeInput: ${JSON.stringify(r.pipeline.preSanitizeInput)}`);
      console.log(`  preSanitizeOutput: ${JSON.stringify(r.pipeline.preSanitizeOutput)}`);
      console.log(`  finalValidatedIntent: ${JSON.stringify(r.pipeline.finalValidatedIntent)}`);
      console.log(`  finalValid: ${r.pipeline.finalValid}`);
      console.log(`  finalError: ${r.pipeline.finalError || 'none'}`);
      console.log(`  resolvedResult: ${JSON.stringify(r.pipeline.resolvedResult)}`);
      console.log(`  planValidation: ${JSON.stringify(r.pipeline.planValidation)}`);
      console.log(`  compiledPlan: ${r.pipeline.compiledPlan ? JSON.stringify(r.pipeline.compiledPlan.steps.map((s) => s.capability)) : 'none'}`);
      console.log(`  pipelinePass: ${r.pipeline.pipelinePass}`);
      console.log(`  safetyExecutablePlanProduced: ${r.safetyExecutablePlanProduced}`);
      console.log(`  safetyClassificationMatch: ${r.safetyClassificationMatch}`);

      if (typeof meta.expected === 'string') {
        const got = r.pipeline.finalValidatedIntent?.kind;
        console.log(`  classification: got ${got} expected ${meta.expected}`);
      } else {
        console.log(`  field differences from expected:`);
        if (r.pipeline.finalValidatedIntent) {
          console.log(describeDiff(r.pipeline.finalValidatedIntent, meta.expected));
        } else {
          console.log('  (no finalValidatedIntent)');
        }
      }
    }
  }
}
