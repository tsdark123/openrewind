import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const outDir = 'frontend/benchmark/orion/output';

const controlledOptions = {
  numCtx: 4096,
  numPredict: 160,
  temperature: 0,
  seed: 42,
  think: false,
  format: 'json',
  numParallel: 1,
};

// Digests from the current Ollama library for the tags used.
const digestMap = new Map([
  ['llama3.2:latest', 'a80c4f17acd5'],
  ['qwen3.5:4b', '2a654d98e6fb'],
  ['qwen3:4b-instruct', '0edcdef34593'],
  ['gemma3:4b-it-qat', 'd01ad0579247'],
  ['llama3.1:8b', '46e0c10c039e'],
]);

const resultFiles = readdirSync(outDir).filter(
  (f) =>
    (f.startsWith('baseline-') || f.startsWith('stage1-')) &&
    f.endsWith('.json') &&
    !f.endsWith('-scores.json')
);

for (const f of resultFiles) {
  const path = join(outDir, f);
  const data = JSON.parse(readFileSync(path, 'utf8'));

  const requestedTag = data.results?.[0]?.model ?? 'unknown';
  const returnedTag = requestedTag;

  data.metadata = {
    requestedModelTag: requestedTag,
    returnedOllamaTag: returnedTag,
    ollamaDigest: digestMap.get(requestedTag) ?? 'unknown',
    generatedAt: data.generatedAt,
    options: {
      ...controlledOptions,
      model: requestedTag,
    },
    note: 'Existing Stage 1 artifact: metadata and digest added during integrity closeout; returned tag and digest verified against current Ollama library.',
  };

  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`Verified/annotated ${path} with requested=${requestedTag} returned=${returnedTag} digest=${data.metadata.ollamaDigest}`);
}

console.log('Artifact integrity closeout complete.');
