import { createExecutionContext } from '../../src/lib/orion/agent/executionContext';
import type {
  ExecutionContextStore,
  ExecutionContextEntry,
  ChartActionIntent,
} from '../../src/lib/orion/agent/types';
import type { BakeoffPrompt } from './types';

const tickers = ['AAPL', 'MSFT', 'NVDA'];

const baseCandle = (snapshotId: number, marketTime: string, close: number) => ({
  snapshotId,
  symbol: 'NVDA',
  date: '2026-07-31',
  timeframe: 15,
  timestamp: 0,
  marketTime,
  open: close - 0.5,
  high: close + 0.5,
  low: close - 0.5,
  close,
  volume: 1000,
  source: 'current_candle' as const,
});

function makeContextEntry(
  i: number,
  seekTime: string,
  close: number
): ExecutionContextEntry {
  const template: ChartActionIntent = {
    kind: 'chart_action',
    symbol: 'NVDA',
    date: { kind: 'absolute', value: '2026-07-31' },
    timeframeMinutes: 15,
    seekTime,
    finalQuery: 'current_candle',
  };
  const candle = baseCandle(i, seekTime, close);
  return {
    sequenceId: 0,
    timestamp: Date.now(),
    originalRequest: `Switch to NVDA 2026-07-31, use 15m, park at ${seekTime}`,
    route: 'llm-plan',
    planSummary: `Switch to NVDA on 2026-07-31 at ${seekTime} 15m`,
    planId: `plan-${i}`,
    ok: true,
    receipts: [],
    template,
    before: { symbol: '', date: '', timeframe: 1, isPlaying: false, speed: 1 },
    after: { symbol: 'NVDA', date: '2026-07-31', timeframe: 15, isPlaying: false, speed: 1, replayTime: seekTime },
    returnedCandles: [candle],
  };
}

export function makeEmptyContext(): { store: ExecutionContextStore } {
  return { store: createExecutionContext() };
}

export function makeActiveContext(): { store: ExecutionContextStore; stateSymbol: string } {
  const store = createExecutionContext();
  // Active session does not pre-seed the execution log; that's a separate fixture.
  return { store, stateSymbol: 'AAPL' };
}

export function makeContextFixture(): { store: ExecutionContextStore; stateSymbol: string } {
  const store = createExecutionContext();
  store.record(makeContextEntry(1, '11:00', 100.0));
  store.record(makeContextEntry(2, '11:30', 101.0));
  store.record(makeContextEntry(3, '11:15', 100.5));
  return { store, stateSymbol: 'NVDA' };
}

const ctxFixture = () => makeContextFixture();
const emptyCtx = () => makeEmptyContext();

export const PRIMARY_PROMPTS: BakeoffPrompt[] = [
  {
    id: 1,
    text: 'Could you set me up on Nvidia for the prior trading session, use fifteen-minute bars, park the replay at quarter past eleven and tell me what candle I am on?',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      symbol: 'NVDA',
      date: { kind: 'relative_trading', count: 1, direction: 'backward' },
      timeframeMinutes: 15,
      seekTime: '11:15',
      finalQuery: 'current_candle',
    },
    makeContext: emptyCtx,
  },
  {
    id: 2,
    text: 'Set me up on AAPL for the prior session, use 5m, park at 10:30 and give me the candle.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      symbol: 'AAPL',
      date: { kind: 'relative_trading', count: 1, direction: 'backward' },
      timeframeMinutes: 5,
      seekTime: '10:30',
      finalQuery: 'current_candle',
    },
    makeContext: emptyCtx,
  },
  {
    id: 3,
    text: 'Set me up on MSFT for the prior trading session, use 60m bars, park at half past nine and show the candle.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      symbol: 'MSFT',
      date: { kind: 'relative_trading', count: 1, direction: 'backward' },
      timeframeMinutes: 60,
      seekTime: '09:30',
      finalQuery: 'current_candle',
    },
    makeContext: emptyCtx,
  },
  {
    id: 4,
    text: 'Pull up the bar at 11:15 for NVDA on 2026-07-31.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      symbol: 'NVDA',
      date: { kind: 'absolute', value: '2026-07-31' },
      queryTime: '11:15',
      finalQuery: 'candle_at_time',
    },
    makeContext: emptyCtx,
  },
  {
    id: 5,
    text: 'Switch to AAPL, go back two sessions, set 15m and seek to quarter to three p.m.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      symbol: 'AAPL',
      date: { kind: 'relative_trading', count: 2, direction: 'backward' },
      timeframeMinutes: 15,
      seekTime: '14:45',
      finalQuery: 'current_candle',
    },
    makeContext: emptyCtx,
  },
  {
    id: 6,
    text: 'Move the replay half an hour earlier and give me the bar I land on.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      relativeSeekMinutes: -30,
      finalQuery: 'current_candle',
    },
    makeContext: ctxFixture,
  },
  {
    id: 7,
    text: 'Skip the replay forward 15 minutes.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      relativeSeekMinutes: 15,
    },
    makeContext: ctxFixture,
  },
  {
    id: 8,
    text: 'Play from here until 3:45pm at 4x.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      playback: { action: 'play_until', untilTime: '15:45', speed: 4, direction: 'forward' },
    },
    makeContext: ctxFixture,
  },
  {
    id: 11,
    text: 'Park the replay at quarter to three in the afternoon.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      seekTime: '14:45',
      finalQuery: 'current_candle',
    },
    makeContext: ctxFixture,
  },
  {
    id: 13,
    text: 'Take me back to the previous stock.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      previousSymbol: true,
    },
    makeContext: ctxFixture,
  },
  {
    id: 14,
    text: 'Do that again on AAPL.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      symbol: 'AAPL',
      contextReference: { source: 'latest_successful_action', mode: 'repeat' },
    },
    goldResolved: {
      kind: 'chart_action',
      symbol: 'AAPL',
      date: { kind: 'absolute', value: '2026-07-31' },
      timeframeMinutes: 15,
      seekTime: '11:15',
      finalQuery: 'current_candle',
    },
    makeContext: ctxFixture,
  },
  {
    id: 15,
    text: 'Use the same timeframe but go to the prior trading session.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      contextReference: { source: 'latest_successful_action', mode: 'inherit', inherit: ['timeframe'] },
      date: { kind: 'relative_trading', count: 1, direction: 'backward' },
    },
    goldResolved: {
      kind: 'chart_action',
      symbol: 'NVDA',
      date: { kind: 'relative_trading', count: 1, direction: 'backward' },
      timeframeMinutes: 15,
    },
    makeContext: ctxFixture,
  },
  {
    id: 16,
    text: 'Go back to the candle we were discussing.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      contextReference: { source: 'latest_returned_candle', mode: 'use_as_target' },
    },
    goldResolved: {
      kind: 'chart_action',
      seekTime: '11:15',
    },
    makeContext: ctxFixture,
  },
  {
    id: 17,
    text: 'Compare this candle with the previous candle you reported.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      finalQuery: 'compare_candles',
      compare: {
        left: { source: 'latest_returned_candle' },
        right: { source: 'previous_returned_candle' },
      },
    },
    makeContext: ctxFixture,
  },
  {
    id: 18,
    text: 'One session before that.',
    profile: 'active',
    bucket: 'primary',
    expected: 'chart_action',
    gold: {
      kind: 'chart_action',
      contextReference: { source: 'latest_successful_action', mode: 'anchor_relative_date' },
      date: { kind: 'relative_trading', count: 1, direction: 'backward' },
    },
    goldResolved: {
      kind: 'chart_action',
      symbol: 'NVDA',
      date: { kind: 'relative_trading', count: 1, direction: 'backward' },
    },
    makeContext: ctxFixture,
  },
];

export const DETERMINISTIC_PROMPTS: BakeoffPrompt[] = [
  {
    id: 9,
    text: 'Use five-minute bars.',
    profile: 'active',
    bucket: 'deterministic',
    expected: 'chart_action',
    makeContext: emptyCtx,
  },
  {
    id: 10,
    text: 'Switch to AAPL 2026-07-31, use 15m and play at 2x until 10:30.',
    profile: 'active',
    bucket: 'deterministic',
    expected: 'chart_action',
    makeContext: emptyCtx,
  },
];

export const PRECONDITION_PROMPTS: BakeoffPrompt[] = [
  {
    id: 12,
    text: 'Give me the candle at noon for AAPL.',
    profile: 'empty',
    bucket: 'diagnostic',
    expected: 'clarification',
    makeContext: emptyCtx,
  },
];

export const SAFETY_PROMPTS: BakeoffPrompt[] = [
  {
    id: 19,
    text: 'Move it over there.',
    profile: 'empty',
    bucket: 'safety',
    expected: 'clarification',
    makeContext: emptyCtx,
  },
  {
    id: 20,
    text: 'Add VWAP and backtest a crossover.',
    profile: 'empty',
    bucket: 'safety',
    expected: 'unsupported',
    makeContext: emptyCtx,
  },
  {
    id: 21,
    text: 'Jump to 25:00.',
    profile: 'empty',
    bucket: 'safety',
    expected: 'clarification',
    makeContext: emptyCtx,
  },
  {
    id: 22,
    text: 'Check the price of Bitcoin.',
    profile: 'empty',
    bucket: 'safety',
    expected: 'unsupported',
    makeContext: emptyCtx,
  },
];

export const ALL_PROMPTS: BakeoffPrompt[] = [
  ...PRIMARY_PROMPTS,
  ...DETERMINISTIC_PROMPTS,
  ...PRECONDITION_PROMPTS,
  ...SAFETY_PROMPTS,
].sort((a, b) => a.id - b.id);

export function getPromptById(id: number): BakeoffPrompt | undefined {
  return ALL_PROMPTS.find((p) => p.id === id);
}

export { tickers };
