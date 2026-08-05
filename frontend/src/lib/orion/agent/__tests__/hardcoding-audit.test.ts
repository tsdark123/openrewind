import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EXAMPLE_LIBRARY } from '../intent';
import { QWEN3_BENCHMARK_PROMPTS } from '../qwen3-benchmark-prompts';
import { parseChartCommand } from '../../planner';
import { getRequestedDimensions } from '../dimensions';
import { SYMBOL_ALIASES } from '../../symbolAliases';

const REPORT_PATH = path.join('benchmark', 'orion', 'output', 'qwen3-hardcoding-audit.md');
const BASE_DATE = '2026-07-10';
const BENCHMARK_TICKERS = ['AAPL', 'MSFT', 'NVDA'];

function usesLlm(text: string): boolean {
  const cmd = parseChartCommand(text, BENCHMARK_TICKERS, SYMBOL_ALIASES, BASE_DATE);
  const requested = getRequestedDimensions(text, cmd, BASE_DATE);

  const parserCovered = new Set<string>();
  if (cmd.symbol) parserCovered.add('symbol');
  if (cmd.date || cmd.dateInput) parserCovered.add('date');
  if (cmd.timeframe !== undefined) parserCovered.add('timeframe');
  if (cmd.startTime || cmd.endTime) parserCovered.add('absoluteTime');
  if (cmd.relativeMinutes !== undefined) parserCovered.add('relativeSeek');
  if (
    cmd.speed !== undefined ||
    ['play', 'pause', 'rewind', 'fast_forward', 'set_speed', 'seek'].includes(cmd.intent)
  ) {
    parserCovered.add('playbackControl');
  }
  if (cmd.intent === 'candle_query') parserCovered.add('candleQuery');

  for (const dim of requested) {
    if (!parserCovered.has(dim)) return true;
  }

  return false;
}

function normalize(text: string): string[] {
  const lowered = text.toLowerCase();
  // Strip punctuation, collapse whitespace.
  const clean = lowered
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.split(' ').filter((t) => t.length > 0);
}

function bigrams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    out.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

function dice(a: string[], b: string[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const denom = (a.length - 1) + (b.length - 1);
  return denom === 0 ? 0 : (2 * inter) / denom;
}

function isContained(smaller: string[], larger: string[]): boolean {
  if (smaller.length < 3) return false;
  const s = smaller.join(' ');
  const l = larger.join(' ');
  if (s.length === 0 || l.length === 0) return false;
  const ratio = s.length / l.length;
  // "Substantially containing" means the shorter string is at least half the
  // length of the longer and appears as a contiguous token run inside it.
  if (ratio < 0.5) return false;
  return l.includes(s);
}

interface Overlap {
  prompt: string;
  exampleText: string;
  exampleJson: string;
  reason: 'exact' | 'contained' | 'near-verbatim';
  detail: string;
}

function detectContamination(): { overlaps: Overlap[]; rows: string[] } {
  const overlaps: Overlap[] = [];
  const rows: string[] = [];

  for (const prompt of QWEN3_BENCHMARK_PROMPTS) {
    const llm = usesLlm(prompt);
    const promptType = llm ? 'LLM' : 'deterministic';
    rows.push(`| "${prompt.replace(/\|/g, '\\|')}" | ${promptType} |`);

    if (!llm) continue;

    const promptTokens = normalize(prompt);

    for (const ex of EXAMPLE_LIBRARY) {
      const exTokens = normalize(ex.text);

      // Normalized exact match.
      if (promptTokens.join(' ') === exTokens.join(' ')) {
        overlaps.push({
          prompt,
          exampleText: ex.text,
          exampleJson: ex.json,
          reason: 'exact',
          detail: 'normalized exact match',
        });
        continue;
      }

      // Substantial containment.
      const lenA = promptTokens.length;
      const lenB = exTokens.length;
      const shorter = lenA <= lenB ? promptTokens : exTokens;
      const longer = lenA <= lenB ? exTokens : promptTokens;
      if (isContained(shorter, longer)) {
        overlaps.push({
          prompt,
          exampleText: ex.text,
          exampleJson: ex.json,
          reason: 'contained',
          detail: `substantial token containment (${shorter.length} tokens inside ${longer.length} tokens)`,
        });
        continue;
      }

      // Near-verbatim (token bigram Dice >= 0.8 after normalization).
      const d = dice(promptTokens, exTokens);
      if (d >= 0.8) {
        overlaps.push({
          prompt,
          exampleText: ex.text,
          exampleJson: ex.json,
          reason: 'near-verbatim',
          detail: `token bigram Dice coefficient ${(d * 100).toFixed(1)}%`,
        });
      }
    }
  }

  return { overlaps, rows };
}

function writeReport(overlaps: Overlap[], promptRows: string[]): void {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });

  const lines: string[] = [
    '# qwen3:8b benchmark hardcoding audit',
    '',
    '## Scope',
    '',
    'This audit checks the 12 fixed qwen3:8b benchmark prompts against the',
    'EXAMPLE_LIBRARY few-shot examples used by the LLM intent extractor.',
    'Only benchmark prompts that route through the LLM are checked; deterministic',
    'parser prompts are listed for completeness but excluded from the contamination',
    'count.',
    '',
    '## Benchmark prompts',
    '',
    '| Prompt | Route |',
    '|--------|-------|',
    ...promptRows,
    '',
    '## Detection rules',
    '',
    '1. Normalized exact match (punctuation and casing removed, whitespace collapsed).',
    '2. One string substantially contains the other (contiguous token run; shorter is',
    '   at least half the length of the longer).',
    '3. Near-verbatim wording: token bigram Sørensen-Dice coefficient ≥ 0.8 after',
    '   normalization.',
    '',
    '## Overlap findings',
    '',
  ];

  if (overlaps.length === 0) {
    lines.push('No blocking overlap detected between LLM-routed benchmark prompts and EXAMPLE_LIBRARY.');
  } else {
    lines.push(`**${overlaps.length} blocking overlap(s) detected.**`);
    lines.push('');
    for (const o of overlaps) {
      lines.push(`- **Benchmark prompt:** "${o.prompt}"`);
      lines.push(`  - **Example text:** "${o.exampleText}"`);
      lines.push(`  - **Example JSON:** \`${o.exampleJson}\``);
      lines.push(`  - **Reason:** ${o.reason}`);
      lines.push(`  - **Detail:** ${o.detail}`);
      lines.push('');
    }
  }

  lines.push('## Conclusion');
  lines.push('');
  lines.push(
    overlaps.length === 0
      ? 'PASS — no LLM-routed benchmark prompt overlaps with an EXAMPLE_LIBRARY entry.'
      : 'FAIL — one or more LLM-routed benchmark prompts are contaminated by EXAMPLE_LIBRARY few-shot examples.'
  );

  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf-8');
}

describe('hardcoding audit', () => {
  it('generates qwen3-hardcoding-audit.md and flags example/benchmark prompt overlap', () => {
    const { overlaps, rows } = detectContamination();

    writeReport(overlaps, rows);

    // The report must exist and show no blocking overlap before we can pass.
    expect(fs.existsSync(REPORT_PATH), `report not written to ${REPORT_PATH}`).toBe(true);

    if (overlaps.length > 0) {
      const summary = overlaps
        .map((o) => `Overlap: prompt "${o.prompt}" ↔ example "${o.exampleText}" (${o.reason})`)
        .join('\n');
      expect.fail(`Benchmark/example contamination detected:\n${summary}\nSee ${REPORT_PATH}`);
    }
  });
});
