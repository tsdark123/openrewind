/**
 * Generate a deterministic, fully synthetic 1-minute US-equity session fixture.
 *
 * The values are deliberately simple so that expected reference outputs can be
 * derived by hand and verified by the independent calculator tests. This
 * fixture is committed; no real market data is used.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReferenceCandle } from './types.ts';

const SYMBOL = 'SYNTH';
const DATE = '2026-08-05';
const TIMEFRAME = 1;
const OFFSET_HOURS = -4; // EDT during August
const CANDLES = 390; // 09:30 – 16:00 ET, 1m bars

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function marketTimeFromIndex(i: number): string {
  const startMinutes = 9 * 60 + 30; // 09:30
  const totalMinutes = startMinutes + i;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function toUtcTimestamp(date: string, marketTime: string, offsetHours: number): number {
  const [h, m] = marketTime.split(':').map(Number);
  const utcMs = Date.UTC(
    Number(date.split('-')[0]),
    Number(date.split('-')[1]) - 1,
    Number(date.split('-')[2]),
    h - offsetHours,
    m,
    0,
    0,
  );
  return Math.floor(utcMs / 1000);
}

const candles: ReferenceCandle[] = [];
for (let i = 0; i < CANDLES; i++) {
  const marketTime = marketTimeFromIndex(i);
  const open = 100 + i * 0.01;
  const direction = i % 3;
  const close =
    direction === 0 ? open + 0.05 : direction === 1 ? open - 0.05 : open;
  const high = Math.max(open, close) + 0.02;
  const low = Math.min(open, close) - 0.02;
  const volume = 1000 + i * 10;
  candles.push({
    timestamp: toUtcTimestamp(DATE, marketTime, OFFSET_HOURS),
    marketTime,
    open: Number(open.toFixed(2)),
    high: Number(high.toFixed(2)),
    low: Number(low.toFixed(2)),
    close: Number(close.toFixed(2)),
    volume,
  });
}

const fixture = {
  id: 'synthetic-session-1m',
  symbol: SYMBOL,
  date: DATE,
  timeframe: TIMEFRAME,
  timezoneOffsetHours: OFFSET_HOURS,
  marketOpen: '09:30',
  marketClose: '16:00',
  candles,
};

const outPath = path.resolve(import.meta.dirname ?? '.', 'fixtures', 'synthetic-session-1m.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
console.log(`Wrote ${candles.length} candles to ${outPath}`);
