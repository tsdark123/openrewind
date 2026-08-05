import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { AppState } from '../../../../types';
import type { AgentContext } from '../types';
import type { CandleData } from '../../../../types';
import { handleOrionMessage, type OrchestratorResult } from '../orchestrator';
import { clearSessionHistory } from '../capabilities';
import { createExecutionContext } from '../executionContext';
import { fetchCandles } from '../../tools';

import * as client from '../../client';
import { QWEN3_BENCHMARK_PROMPTS } from '../qwen3-benchmark-prompts';

const TEST_TIMEOUT = 1_800_000;
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
        /* best-effort */
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

interface BenchmarkRow {
  prompt: string;
  requestedDimensions: string[];
  promptChars: number;
  promptEvalCount: number;
  promptEvalDurationMs: number;
  evalCount: number;
  evalDurationMs: number;
  modelDurationMs: number;
  handleDurationMs: number;
  repairAttempts: number;
  finalIntent: unknown;
  compiledPlan: string[];
  route: string;
  ok: boolean;
}

type OllamaRaw = {
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
};

function planSteps(result: OrchestratorResult): string[] {
  return (result.plan?.steps ?? []).map((s) => s.capability);
}

function requestedDimensions(result: OrchestratorResult): string[] {
  return result.plan?.steps.map((s) => s.capability) ?? [];
}

function finalIntent(result: OrchestratorResult): unknown {
  if (!result.plan) return null;
  const intent: Record<string, unknown> = {};
  for (const step of result.plan.steps) {
    if (step.capability === 'analysis.window_summary') intent.windowSummary = step.args;
    if (step.capability === 'analysis.window_ohlc') intent.windowOhlc = step.args;
    if (step.capability === 'analysis.window_volume') intent.windowVolume = step.args;
    if (step.capability === 'analysis.window_change') intent.windowChange = step.args;
    if (step.capability === 'analysis.window_compare') intent.windowCompare = step.args;
    if (step.capability === 'analysis.candle_shape') intent.candleShape = step.args;
    if (step.capability === 'session.switch_symbol') intent.switchSymbol = step.args;
    if (step.capability === 'chart.set_timeframe') intent.setTimeframe = step.args;
    if (step.capability === 'chart.seek') intent.seek = step.args;
    if (step.capability === 'chart.playback') intent.playback = step.args;
  }
  return intent;
}

function toMs(ns?: number): number {
  return typeof ns === 'number' ? Math.round(ns / 1_000_000) : 0;
}

const PROMPTS = [...QWEN3_BENCHMARK_PROMPTS];

const originalOrionChat = client.orionChat;

describe('qwen3:8b semantic-intent benchmark', () => {
  it(
    'runs the fixed prompt set and records metrics',
    async () => {
      clearSessionHistory();
      const ctx = makeCtx();
      const setup = await handleOrionMessage({
        text: 'Switch to AAPL 2026-07-10 1m.',
        ctx,
        setupReady: true,
      });
      if (!setup.ok) {
        console.warn('[benchmark] setup did not succeed:', setup.message);
      }

      const rows: BenchmarkRow[] = [];
      const reportFile = path.join(
        (globalThis as any).process?.env?.TEMP ?? 'C:\\Users\\logja\\AppData\\Local\\Temp',
        `qwen3-intent-baseline-${Date.now()}.json`
      );

      for (const prompt of PROMPTS) {
        // Capture raw Ollama responses and the real system prompt length.
        const raws: OllamaRaw[] = [];
        let actualPromptChars = 0;
        const spy = vi.spyOn(client, 'orionChat').mockImplementation(async (opts) => {
          const system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
          actualPromptChars = system.length;
          const res = await originalOrionChat(opts);
          if (res.raw) raws.push(res.raw as OllamaRaw);
          return res;
        });

        const start = Date.now();
        const result = await handleOrionMessage({ text: prompt, ctx, setupReady: true });
        const handleDurationMs = Date.now() - start;
        spy.mockRestore();

        // Ollama may be called multiple times only if the first response fails
        // JSON validation and a repair is attempted.
        const combined: OllamaRaw = {
          total_duration: raws.reduce((sum, r) => sum + (r.total_duration ?? 0), 0),
          load_duration: raws.reduce((sum, r) => sum + (r.load_duration ?? 0), 0),
          prompt_eval_duration: raws.reduce((sum, r) => sum + (r.prompt_eval_duration ?? 0), 0),
          eval_duration: raws.reduce((sum, r) => sum + (r.eval_duration ?? 0), 0),
          prompt_eval_count: raws.reduce((sum, r) => sum + (r.prompt_eval_count ?? 0), 0),
          eval_count: raws.reduce((sum, r) => sum + (r.eval_count ?? 0), 0),
        };

        const row: BenchmarkRow = {
          prompt,
          requestedDimensions: requestedDimensions(result),
          promptChars: actualPromptChars,
          promptEvalCount: combined.prompt_eval_count ?? 0,
          promptEvalDurationMs: toMs(combined.prompt_eval_duration),
          evalCount: combined.eval_count ?? 0,
          evalDurationMs: toMs(combined.eval_duration),
          modelDurationMs: toMs(combined.total_duration),
          handleDurationMs,
          repairAttempts: Math.max(0, raws.length - 1),
          finalIntent: finalIntent(result),
          compiledPlan: planSteps(result),
          route: result.route,
          ok: result.ok,
        };
        rows.push(row);
        fs.writeFileSync(reportFile, JSON.stringify(rows, null, 2), 'utf-8');

        console.log('[benchmark-row]', JSON.stringify(row));
      }

      console.log('[benchmark-report]', reportFile);

      // The benchmark records data; it does not gate correctness on model outputs.
      expect(rows.length).toBe(PROMPTS.length);
      expect(rows.some((r) => r.promptEvalCount > 0)).toBe(true);
    },
    TEST_TIMEOUT
  );
});
