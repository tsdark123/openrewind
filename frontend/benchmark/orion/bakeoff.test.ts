import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { ALL_PROMPTS } from './bakeoff-suite';
import { buildExtractionMessages } from './bakeoff-stages';
import { runBakeoff } from './bakeoff-runner';
import { formatScorecard, writeResultsJson, writePromptScoresJson } from './bakeoff-report';
import { tickers } from './bakeoff-suite';

process.env.OLLAMA_NUM_PARALLEL = '1';

const MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2:latest';

describe('orion bake-off harness', () => {
  it('loads all prompts and can build extraction messages without an LLM', () => {
    for (const prompt of ALL_PROMPTS) {
      const { messages, state, requestContext } = buildExtractionMessages({
        prompt,
        makeContext: prompt.makeContext,
        availableTickers: tickers,
      });
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
      expect(state).toBeDefined();
      expect(requestContext.dimensions).toBeInstanceOf(Array);
    }
  });

  it(`runs the ${MODEL} bake-off and writes results`, async () => {
    const outDir = 'benchmark/orion/output';
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const options = {
      model: MODEL,
      numCtx: 4096,
      numPredict: 160,
      temperature: 0,
      seed: 42,
      think: false,
      format: 'json',
      numParallel: Number(process.env.OLLAMA_NUM_PARALLEL ?? '1'),
    };

    const { results, promptScores, scorecard } = await runBakeoff(options);

    const safeName = MODEL.replace(/[:/]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsPath = `${outDir}/stage1-${safeName}-${timestamp}.json`;
    const scoresPath = `${outDir}/stage1-${safeName}-${timestamp}-scores.json`;
    const reportPath = `${outDir}/stage1-${safeName}-${timestamp}.md`;

    writeFileSync(resultsPath, writeResultsJson(resultsPath, results, options));
    writeFileSync(scoresPath, writePromptScoresJson(scoresPath, promptScores));
    writeFileSync(reportPath, formatScorecard(scorecard));

    console.log(`Stage 1 results: ${resultsPath}`);
    console.log(`Stage 1 scores:  ${scoresPath}`);
    console.log(`Stage 1 report:  ${reportPath}`);
    console.log(formatScorecard(scorecard));

    expect(results.length).toBeGreaterThan(0);
  }, 1200000);
});
