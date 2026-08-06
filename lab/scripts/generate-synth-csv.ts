/**
 * Convert the committed synthetic-session-1m.json fixture into the
 * OpenRewind engine's expected CSV format.
 *
 * Output: lab/data/SYNTH/SYNTH_history.csv
 * Columns: YYYY-MM-DD HH:MM:SS,open,high,low,close,volume
 * Timestamps are US Eastern local wall-clock time (the engine shifts to UTC).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface FixtureCandle {
  timestamp: number;
  marketTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Fixture {
  id: string;
  symbol: string;
  date: string;
  timeframe: number;
  timezoneOffsetHours: number;
  marketOpen: string;
  marketClose: string;
  candles: FixtureCandle[];
}

const fixturePath = path.resolve(import.meta.dirname ?? '.', '..', 'reference', 'fixtures', 'synthetic-session-1m.json');
const outPath = path.resolve(import.meta.dirname ?? '.', '..', 'data', 'SYNTH', 'SYNTH_history.csv');

const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatEasternLocal(_timestamp: number, marketTime: string, date: string): string {
  // The fixture JSON records marketTime and date in Eastern local time.
  // The CSV must use the same wall-clock representation so the engine's
  // CsvLoader::parse_timestamp can shift it to UTC with the correct DST offset.
  const [h, m] = marketTime.split(':').map(Number);
  return `${date} ${pad2(h)}:${pad2(m)}:${pad2(0)}`;
}

const lines: string[] = fixture.candles.map((c) => {
  const ts = formatEasternLocal(c.timestamp, c.marketTime, fixture.date);
  return [ts, c.open, c.high, c.low, c.close, c.volume].join(',');
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n') + '\n');

console.log(`Wrote ${lines.length} candles to ${outPath}`);
