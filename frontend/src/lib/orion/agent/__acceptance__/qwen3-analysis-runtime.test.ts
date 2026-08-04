import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { AppState } from '../../../../types';
import type { AgentContext } from '../types';
import type { CandleData } from '../../../../types';
import { handleOrionMessage, type OrchestratorResult } from '../orchestrator';
import { clearSessionHistory } from '../capabilities';
import { createExecutionContext } from '../executionContext';
import { fetchCandles } from '../../tools';
import { toEngineTs } from '../../planner';
import {
  computeWindowOhlc,
  computeWindowCompare,
  type ResolvedWindowMeta,
  type WindowCompareResult,
} from '../analysis';

const TEST_TIMEOUT = 600_000;
const API_BASE = 'http://127.0.0.1:9000';

interface ChartBuffer {
  candles: CandleData[];
  beforeTimestamp: number;
}

function baseAppState(): AppState & Record<string, any> {
  return {
    symbol: '',
    replayDate: '',
    sessionActive: false,
    isPlaying: false,
    speed: 1,
    timeframe: 1,
    cursor: 0,
    totalCandles: 0,
    currentPrice: 0,
    playbackDirection: 'forward',
    balance: 100000,
    equity: 100000,
    openPositions: [],
    pendingOrders: [],
    indicators: {
      ema20: false,
      sma50: false,
      bollinger: false,
      rsi: false,
      macd: false,
      atr: false,
      stochastic: false,
    },
    activeSessionTrades: [],
    tradeHistory: [],
    dataSynced: false,
    symbolError: '',
    dateError: '',
    lightMode: false,
    showIntro: false,
    view: 'menu',
    dataSource: 'managed',
    replayRate: 1,
    lastOhlc: null,
  } as unknown as AppState & Record<string, unknown>;
}

function makeCtx(): AgentContext {
  const state = baseAppState();
  const buffer: ChartBuffer = { candles: [], beforeTimestamp: 0 };

  async function loadCandles(symbol: string, date: string, timeframe: number, upToTimestamp?: number) {
    const res = await fetchCandles({ symbol, date, timeframe, limit: 5000 }, API_BASE);
    if (res.missing || res.candles.length === 0) {
      throw new Error(`No candles for ${symbol} ${date} ${timeframe}m`);
    }
    buffer.candles = res.candles;
    if (upToTimestamp !== undefined) {
      buffer.beforeTimestamp = upToTimestamp;
    } else {
      buffer.beforeTimestamp = res.candles[res.candles.length - 1].timestamp;
    }
  }

  const getRecentCandles = (n: number): CandleData[] => {
    const filtered = buffer.candles.filter((c) => c.timestamp <= buffer.beforeTimestamp);
    if (filtered.length === 0) return [];
    const count = Math.min(Math.max(0, n | 0), filtered.length);
    return filtered.slice(filtered.length - count);
  };

  const chartRef = { current: { getRecentCandles } as any };

  const dispatch = (action: { type: string; [k: string]: unknown }) => {
    if (action.type === 'SET_SYMBOL') {
      state.symbol = action.symbol as string;
      state.sessionActive = true;
    }
    if (action.type === 'SET_REPLAY_DATE') {
      state.replayDate = action.date as string;
    }
    if (action.type === 'SET_TIMEFRAME') {
      state.timeframe = action.timeframe as number;
    }
    if (action.type === 'SET_PLAYING') {
      state.isPlaying = action.isPlaying as boolean;
    }
    if (action.type === 'SET_SPEED') {
      state.speed = action.speed as number;
    }
    if (action.type === 'SESSION_STARTED') {
      const payload = action.payload as Record<string, unknown>;
      state.session_id = (payload.session_id as string) ?? '';
      state.symbol = (payload.symbol as string) ?? state.symbol;
      state.totalCandles = (payload.total_candles as number) ?? 0;
      state.start_ts = (payload.start_ts as number) ?? 0;
      state.end_ts = (payload.end_ts as number) ?? 0;
      state.cursor = (payload.start_cursor as number) ?? state.start_ts;
      state.replayDate = (payload.start_date as string) ?? state.replayDate;
      state.sessionActive = true;
    }
  };

  const send = async (payload: Record<string, unknown>) => {
    if (payload.cmd === 'seek' && typeof payload.timestamp === 'number') {
      state.cursor = payload.timestamp as number;
      buffer.beforeTimestamp = payload.timestamp as number;
      return;
    }
    if (payload.cmd === 'set_timeframe' && typeof payload.minutes === 'number') {
      state.timeframe = payload.minutes as number;
      try {
        await loadCandles(state.symbol, state.replayDate, state.timeframe, buffer.beforeTimestamp);
      } catch {
        // best-effort re-load; window fetches will fall back if chartRef is stale
      }
      return;
    }
    if (payload.cmd === 'play') state.isPlaying = true;
    if (payload.cmd === 'pause') state.isPlaying = false;
  };

  const onSwitchSymbol = async (symbol: string, targetDate?: string) => {
    const date = targetDate ?? state.replayDate;
    if (!date) throw new Error('No date for session start');
    const probe = await fetchCandles({ symbol, date, timeframe: 1, limit: 1 }, API_BASE);
    if (probe.missing) throw new Error(`No data for ${symbol} on ${date}`);
    const resolvedDate = probe.fallbackDate ?? date;
    const res = await fetch(`${API_BASE}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, starting_balance: 100000, start_date: resolvedDate }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (data.error) throw new Error(String(data.error));

    state.symbol = symbol;
    state.replayDate = (data.start_date as string) ?? resolvedDate;
    state.sessionActive = true;
    state.totalCandles = (data.total_candles as number) ?? 0;
    state.start_ts = (data.start_ts as number) ?? 0;
    state.end_ts = (data.end_ts as number) ?? 0;
    state.cursor = (data.start_cursor as number) ?? state.start_ts;
    state.timeframe = 1;
    state.dateConfirmed = true;

    await loadCandles(symbol, state.replayDate, state.timeframe, state.end_ts);
  };

  return {
    getState: () => state,
    chartRef,
    performanceLog: {},
    apiBase: API_BASE,
    dataDir: undefined,
    availableTickers: ['AAPL', 'MSFT', 'NVDA'],
    send,
    dispatch,
    onSwitchSymbol,
    executionLog: createExecutionContext(),
  };
}

function buildMeta(
  kind: ResolvedWindowMeta['kind'],
  symbol: string,
  date: string,
  timeframe: number,
  candles: CandleData[],
  fromTime?: string,
  toTime?: string
): ResolvedWindowMeta {
  return {
    kind,
    symbol,
    requestedDate: date,
    resolvedDate: date,
    sessionPolicy: 'engine_returned_candles_for_requested_date',
    timeframe,
    candleCount: candles.length,
    firstTimestamp: candles[0].timestamp,
    firstMarketTime: new Date((candles[0].timestamp - 4 * 3600) * 1000).toISOString().slice(11, 16),
    lastTimestamp: candles[candles.length - 1].timestamp,
    lastMarketTime: new Date((candles[candles.length - 1].timestamp - 4 * 3600) * 1000).toISOString().slice(11, 16),
    fromTime,
    toTime,
  };
}

function sliceRange(candles: CandleData[], fromTime: string, toTime: string, date: string) {
  const [fh, fm] = fromTime.split(':').map((n) => parseInt(n, 10));
  const [th, tm] = toTime.split(':').map((n) => parseInt(n, 10));
  const fromTs = toEngineTs(date, fh, fm);
  const toTs = toEngineTs(date, th, tm);
  return candles.filter((c) => c.timestamp >= fromTs && c.timestamp < toTs);
}

async function fetchWindow(symbol: string, date: string, fromTime: string, toTime: string) {
  const res = await fetchCandles({ symbol, date, timeframe: 1, limit: 5000 }, API_BASE);
  return sliceRange(res.candles, fromTime, toTime, res.date);
}

async function verifyFirstHourOhlc(symbol: string, date: string, receipt: Record<string, unknown>) {
  const candles = await fetchWindow(symbol, date, '09:30', '10:30');
  const meta = buildMeta('time_range', symbol, date, 1, candles, '09:30', '10:30');
  const expected = computeWindowOhlc(candles, meta);
  return {
    ok: expected.open === receipt.open && expected.high === receipt.high && expected.low === receipt.low && expected.close === receipt.close,
    expected: { open: expected.open, high: expected.high, low: expected.low, close: expected.close, candleCount: expected.candleCount },
    received: { open: receipt.open, high: receipt.high, low: receipt.low, close: receipt.close, candleCount: receipt.candleCount },
  };
}

async function verifyVolumeComparison(receipt: Record<string, unknown>) {
  const result = receipt as unknown as WindowCompareResult;
  const leftMeta = result.left;
  const rightMeta = result.right;

  function rangeFor(meta: ResolvedWindowMeta): { from: string; to: string } {
    if (meta.fromTime && meta.toTime) return { from: meta.fromTime, to: meta.toTime };
    return { from: meta.firstMarketTime, to: meta.lastMarketTime };
  }

  const lr = rangeFor(leftMeta);
  const rr = rangeFor(rightMeta);
  const left = await fetchWindow(leftMeta.symbol, leftMeta.requestedDate, lr.from, lr.to);
  const right = await fetchWindow(rightMeta.symbol, rightMeta.requestedDate, rr.from, rr.to);
  const expected = computeWindowCompare(left, leftMeta, right, rightMeta);
  return {
    ok: expected.volumeDeltaAbs === result.volumeDeltaAbs && expected.volumeDeltaPercent === result.volumeDeltaPercent,
    expected: { volumeDeltaAbs: expected.volumeDeltaAbs, volumeDeltaPercent: expected.volumeDeltaPercent },
    received: { volumeDeltaAbs: result.volumeDeltaAbs, volumeDeltaPercent: result.volumeDeltaPercent },
  };
}

async function verifyCurrentCandleShape(symbol: string, date: string, receipt: Record<string, unknown>) {
  const res = await fetchCandles({ symbol, date, timeframe: 1, limit: 5000 }, API_BASE);
  const candle = res.candles[res.candles.length - 1];
  return {
    ok: candle.close === receipt.close && candle.open === receipt.open && candle.high === receipt.high && candle.low === receipt.low && candle.volume === receipt.volume,
    expected: { open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume },
    received: { open: receipt.open, high: receipt.high, low: receipt.low, close: receipt.close, volume: receipt.volume },
  };
}

type ReportEntry = {
  label: string;
  prompt: string;
  route: string;
  ok: boolean;
  message: string;
  planSteps: { capability: string; args: Record<string, unknown> }[];
  extra?: Record<string, unknown>;
};

const runtimeReport: ReportEntry[] = [];

function record(label: string, prompt: string, result: OrchestratorResult, extra?: Record<string, unknown>) {
  const entry: ReportEntry = {
    label,
    prompt,
    route: result.route,
    ok: result.ok,
    message: result.message,
    planSteps: result.plan?.steps.map((s) => ({ capability: s.capability, args: s.args as Record<string, unknown> })) ?? [],
    extra,
  };
  runtimeReport.push(entry);
  console.log(`[runtime-trace] ${label}`, JSON.stringify({ ...entry, plan: entry.planSteps }, null, 2));
}

function writeRuntimeReport(failures: string[], ground: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const lines: string[] = [];
  lines.push('# Phase 6A.3 Runtime Acceptance Report (qwen3:8b)');
  lines.push('');
  lines.push(`**Generated:** ${timestamp}`);
  lines.push('**Model:** qwen3:8b via Ollama at http://127.0.0.1:11434');
  lines.push('**Engine:** OpenRewind local engine at http://127.0.0.1:9000');
  lines.push('**Dataset:** AAPL 2026-07-10, 1-minute candles');
  lines.push('**Overall result:** ' + (failures.length === 0 ? 'PASS' : 'FAIL'));
  lines.push('');

  lines.push('## Summary');
  lines.push('This report captures the first real-engine runtime acceptance run for the Orion 6A.3 analysis-capability prompts (A-D).');
  lines.push('The test exercises the full orchestrator, compact-intent planner, analysis capabilities, and grounding verification against the live engine and qwen3:8b.');
  lines.push('');

  lines.push('## Per-prompt Results');
  for (const r of runtimeReport) {
    lines.push(`### ${r.label}: "${r.prompt}"`);
    lines.push('');
    lines.push(`- **Route:** \`${r.route}\``);
    lines.push(`- **OK:** ${r.ok}`);
    lines.push(`- **Response:** ${r.message}`);
    if (r.planSteps.length > 0) {
      lines.push('- **Plan:**');
      for (const step of r.planSteps) {
        lines.push(`  - \`${step.capability}\` — \`${JSON.stringify(step.args)}\``);
      }
    }
    if (r.extra) {
      for (const [k, v] of Object.entries(r.extra)) {
        lines.push(`- **${k}:** \`${JSON.stringify(v)}\``);
      }
    }
    lines.push('');
  }

  lines.push('## Grounding Verification');
  lines.push('The runtime test independently recomputed selected outputs from raw engine candles to confirm the agent’s numbers are not hallucinated.');
  lines.push('');
  for (const [k, v] of Object.entries(ground)) {
    lines.push(`### ${k}`);
    lines.push('```json');
    lines.push(JSON.stringify(v, null, 2));
    lines.push('```');
    lines.push('');
  }

  lines.push('## Failures');
  if (failures.length === 0) {
    lines.push('No failures.');
  } else {
    for (const f of failures) {
      lines.push(`- ${f}`);
    }
  }
  lines.push('');

  const reportPath = path.resolve(process.cwd(), '..', 'docs', 'ORION_RUNTIME_6A3_REPORT.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  console.log('[runtime-trace] report written to', reportPath);
}

describe('Phase 6A.3 real runtime acceptance', () => {
  beforeAll(() => {
    clearSessionHistory();
  });

  it(
    'runs the full A-D suite against the real engine and qwen3:8b',
    async () => {
      const ctx = makeCtx();
      const failures: string[] = [];
      const allCandlesBySymbol: Record<string, CandleData[]> = {};

      // Establish real AAPL session
      const setup = await handleOrionMessage({
        text: 'Switch to AAPL 2026-07-10 1m.',
        ctx,
        setupReady: true,
      });
      record('setup', 'Switch to AAPL 2026-07-10 1m.', setup);
      if (!setup.ok) failures.push('setup failed');

      // Pre-fetch AAPL candles for independent verification
      const aaplRes = await fetchCandles({ symbol: 'AAPL', date: '2026-07-10', timeframe: 1, limit: 5000 }, API_BASE);
      allCandlesBySymbol.AAPL = aaplRes.candles;

      // A.1
      const a1 = await handleOrionMessage({ text: 'How did AAPL do today?', ctx, setupReady: true });
      record('A.1', 'How did AAPL do today?', a1);
      if (!a1.ok || a1.route !== 'llm-plan') failures.push('A.1 route/ok');

      // A.2
      const a2 = await handleOrionMessage({ text: 'range first hour', ctx, setupReady: true });
      record('A.2', 'range first hour', a2);
      if (!a2.ok || a2.route !== 'llm-plan') failures.push('A.2 route/ok');

      // A.3
      const a3 = await handleOrionMessage({ text: 'how much did it move up to where im at', ctx, setupReady: true });
      record('A.3', 'how much did it move up to where im at', a3);
      if (!a3.ok || a3.route !== 'llm-plan') failures.push('A.3 route/ok');

      // A.4
      const a4 = await handleOrionMessage({ text: 'what kind of candle am i on rn', ctx, setupReady: true });
      record('A.4', 'what kind of candle am i on rn', a4);
      if (!a4.ok || a4.route !== 'llm-plan') failures.push('A.4 route/ok');

      // B.5
      const b5 = await handleOrionMessage({ text: 'was mornig volum higher than near close', ctx, setupReady: true });
      record('B.5', 'was mornig volum higher than near close', b5);
      if (!b5.ok || b5.route !== 'llm-plan') failures.push('B.5 route/ok');

      // B.6
      const b6 = await handleOrionMessage({ text: 'yo compare the first 30 mins to the last 30', ctx, setupReady: true });
      record('B.6', 'yo compare the first 30 mins to the last 30', b6);
      if (!b6.ok || b6.route !== 'llm-plan') failures.push('B.6 route/ok');

      // B.7
      const b7 = await handleOrionMessage({ text: 'give me the move, total volum and candle anatomy from 10 to noon', ctx, setupReady: true });
      record('B.7', 'give me the move, total volum and candle anatomy from 10 to noon', b7);
      if (!b7.ok || b7.route !== 'llm-plan') failures.push('B.7 route/ok');

      // C.8 (context inherit)
      const beforeC8 = ctx.executionLog.latestSuccessfulAction();
      const c8 = await handleOrionMessage({ text: 'same thing but first hour', ctx, setupReady: true });
      const afterC8 = ctx.executionLog.latest();
      record('C.8', 'same thing but first hour', c8, {
        'context before': beforeC8?.template,
        'context after': afterC8?.template,
      });
      if (!c8.ok || c8.route !== 'llm-plan') failures.push('C.8 route/ok');

      // C.9
      const c9 = await handleOrionMessage({ text: 'what about volume?', ctx, setupReady: true });
      record('C.9', 'what about volume?', c9);
      if (!c9.ok || c9.route !== 'llm-plan') failures.push('C.9 route/ok');

      // C.10
      const c10 = await handleOrionMessage({ text: 'compare that with the last hour', ctx, setupReady: true });
      record('C.10', 'compare that with the last hour', c10);
      if (!c10.ok || c10.route !== 'llm-plan') failures.push('C.10 route/ok');

      // C.11
      const c11 = await handleOrionMessage({ text: 'do that analysis on NVDA', ctx, setupReady: true });
      record('C.11', 'do that analysis on NVDA', c11);
      if (!c11.ok || c11.route !== 'llm-plan') failures.push('C.11 route/ok');

      // D.12 five distinct analysis ops should clarify
      const d12 = await handleOrionMessage({
        text: 'give me the open high low close volume and change from 9:30 to 10, 10 to 11, 11 to 12, 12 to 1 and 1 to 2',
        ctx,
        setupReady: true,
      });
      record('D.12', 'give me the open high low close volume and change from 9:30 to 10, 10 to 11, 11 to 12, 12 to 1 and 1 to 2', d12);
      if (d12.ok && d12.route !== 'clarification') failures.push('D.12 should have clarified');

      // D.13 RSI/MACD unsupported
      const d13 = await handleOrionMessage({ text: 'what are the RSI and MACD', ctx, setupReady: true });
      record('D.13', 'what are the RSI and MACD', d13);
      if (d13.ok && d13.route !== 'unsupported' && d13.route !== 'clarification') failures.push('D.13 should be unsupported/clarification');
      if (d13.result?.receipts && d13.result.receipts.some((r) => r.capability.startsWith('analysis.'))) {
        failures.push('D.13 should not execute analysis');
      }

      // D.14 missing prior analysis
      const freshCtx = makeCtx();
      await handleOrionMessage({ text: 'Switch to AAPL 2026-07-10 1m.', ctx: freshCtx, setupReady: true });
      const d14 = await handleOrionMessage({ text: 'what about volume?', ctx: freshCtx, setupReady: true });
      record('D.14', 'what about volume? (fresh context)', d14);
      if (!d14.ok || d14.route !== 'clarification') failures.push('D.14 should have clarified');

      // D.15 no active session
      const noSessionCtx = makeCtx();
      const d15 = await handleOrionMessage({ text: 'how did it do?', ctx: noSessionCtx, setupReady: true });
      record('D.15', 'how did it do? (no active session)', d15);
      if (d15.ok) failures.push('D.15 should fail with no session');
      const d15Precondition = d15.result?.receipts.some(
        (r) => r.capability.startsWith('analysis.') && !r.success && r.errorCode === 'PRECONDITION_FAILED'
      );
      if (!d15Precondition) failures.push('D.15 should fail with PRECONDITION_FAILED');

      const groundings: Record<string, unknown> = {};

      // Grounding verification for A.2 first hour OHLC
      const a2OhlcStep = a2.result?.receipts.find((r) => r.capability === 'analysis.window_ohlc' && r.success);
      if (a2OhlcStep?.data) {
        const ground = await verifyFirstHourOhlc('AAPL', '2026-07-10', a2OhlcStep.data as Record<string, unknown>);
        groundings['A.2 first-hour OHLC'] = ground;
        if (!ground.ok) failures.push('A.2 grounding mismatch');
      }

      // Grounding for B.5 volume compare
      const b5Compare = b5.result?.receipts.find((r) => r.capability === 'analysis.window_compare' && r.success);
      if (b5Compare?.data) {
        const data = b5Compare.data as Record<string, unknown>;
        const ground = await verifyVolumeComparison(data);
        groundings['B.5 volume compare'] = ground;
        if (!ground.ok) failures.push('B.5 grounding mismatch');
      }

      // Grounding for A.4 candle shape
      const a4Candle = a4.result?.receipts.find((r) => r.capability === 'analysis.candle_shape' && r.success);
      if (a4Candle?.data) {
        const data = (a4Candle.data as Record<string, unknown>).candle as Record<string, unknown>;
        const ground = await verifyCurrentCandleShape('AAPL', '2026-07-10', data);
        groundings['A.4 candle shape'] = ground;
        if (!ground.ok) failures.push('A.4 grounding mismatch');
      }

      // Context behavior: C.11 should switch symbol, not inherit stale AAPL data
      if (c11.ok && ctx.getState().symbol !== 'NVDA') failures.push('C.11 did not switch to NVDA');

      // Write the runtime acceptance report
      writeRuntimeReport(failures, groundings);

      // Print pass/fail matrix
      console.log('[runtime-trace] failures:', failures);
      expect(failures).toEqual([]);
    },
    TEST_TIMEOUT
  );
});
