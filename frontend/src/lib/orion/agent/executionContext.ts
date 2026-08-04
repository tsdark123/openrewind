// =============================================================================
// executionContext — bounded, verified runtime memory for Orion.
//
// This is *not* chat history and not a general memory system. It is a compact,
// append-only log of what Orion actually did, with the normalized intent that
// produced it, the receipts that proved it, and any candles it returned.
//
// It is created in App.tsx and passed into the terminal/orchestrator so it
// survives the Orion side panel being closed and reopened.
// =============================================================================

import type {
  ExecutionContextStore,
  ExecutionContextEntry,
  CompactStateSnapshot,
  CandleSnapshot,
} from './types';
import type { AppState, CandleData } from '../../../types';
import type { ChartHandle } from '../../../components/Chart';
import { toEtTime, formatTime } from '../planner';

const MAX_ENTRIES = 15;

function currentCandleFromChart(chartRef: { current: ChartHandle | null } | null): CandleData | undefined {
  return chartRef?.current?.getRecentCandles(1)[0];
}

export function buildCompactStateSnapshot(
  state: AppState,
  chartRef: { current: ChartHandle | null } | null
): CompactStateSnapshot {
  const candle = currentCandleFromChart(chartRef);
  const replayTimestamp = candle?.timestamp;
  const replayTime = replayTimestamp && state.replayDate
    ? formatTime(toEtTime(replayTimestamp, state.replayDate))
    : undefined;

  return {
    symbol: state.symbol,
    date: state.replayDate,
    timeframe: state.timeframe,
    replayTimestamp,
    replayTime,
    isPlaying: state.isPlaying,
    speed: state.speed,
    direction: state.playbackDirection,
    cursor: state.cursor,
    currentPrice: state.currentPrice,
  };
}

export function buildCandleSnapshot(
  snapshotId: number,
  state: { symbol: string; date: string; timeframe: number },
  candle: CandleData,
  source: CandleSnapshot['source']
): CandleSnapshot {
  const symbol = state.symbol;
  const date = state.date;
  const timeframe = state.timeframe;
  const marketTime = date ? formatTime(toEtTime(candle.timestamp, date)) : '';

  return {
    snapshotId,
    symbol,
    date,
    timeframe,
    timestamp: candle.timestamp,
    marketTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    source,
  };
}

export function createExecutionContext(): ExecutionContextStore {
  const entries: ExecutionContextEntry[] = [];
  let nextSequenceId = 1;

  function record(entry: ExecutionContextEntry): void {
    const id = nextSequenceId++;
    entry.sequenceId = id;
    for (const c of entry.returnedCandles) {
      c.snapshotId = id;
    }
    entries.push(entry);
    while (entries.length > MAX_ENTRIES) {
      entries.shift();
    }
  }

  function reset(): void {
    entries.length = 0;
    nextSequenceId = 1;
  }

  function getEntries(): readonly ExecutionContextEntry[] {
    return entries;
  }

  function latest(): ExecutionContextEntry | undefined {
    return entries[entries.length - 1];
  }

  function latestSuccessfulAction(): ExecutionContextEntry | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.template && e.ok === true) return e;
    }
    return undefined;
  }

  function latestFailedAction(): ExecutionContextEntry | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.template && e.ok === false) return e;
    }
    return undefined;
  }

  function latestReturnedCandle(): CandleSnapshot | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.returnedCandles.length > 0) {
        return e.returnedCandles[e.returnedCandles.length - 1];
      }
    }
    return undefined;
  }

  function previousReturnedCandle(): CandleSnapshot | undefined {
    let foundLatest = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.returnedCandles.length > 0) {
        if (!foundLatest) {
          foundLatest = true;
          continue;
        }
        return e.returnedCandles[e.returnedCandles.length - 1];
      }
    }
    return undefined;
  }

  function findCandleByMarketTime(opts: {
    symbol?: string;
    date?: string;
    timeframe?: number;
    marketTime: string;
  }): CandleSnapshot | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      for (let j = e.returnedCandles.length - 1; j >= 0; j--) {
        const c = e.returnedCandles[j];
        if (c.marketTime !== opts.marketTime) continue;
        if (opts.symbol && c.symbol !== opts.symbol) continue;
        if (opts.date && c.date !== opts.date) continue;
        if (opts.timeframe !== undefined && c.timeframe !== opts.timeframe) continue;
        return c;
      }
    }
    return undefined;
  }

  function latestMatchingCandle(opts: {
    symbol?: string;
    date?: string;
    timeframe?: number;
  }): CandleSnapshot | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      for (let j = e.returnedCandles.length - 1; j >= 0; j--) {
        const c = e.returnedCandles[j];
        if (opts.symbol && c.symbol !== opts.symbol) continue;
        if (opts.date && c.date !== opts.date) continue;
        if (opts.timeframe !== undefined && c.timeframe !== opts.timeframe) continue;
        return c;
      }
    }
    return undefined;
  }

  function findCandle(opts: {
    snapshotId?: number;
    symbol: string;
    date: string;
    timeframe: number;
    timestamp: number;
  }): CandleSnapshot | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      for (let j = e.returnedCandles.length - 1; j >= 0; j--) {
        const c = e.returnedCandles[j];
        if (opts.snapshotId !== undefined && c.snapshotId === opts.snapshotId) {
          return c;
        }
        if (
          c.symbol === opts.symbol &&
          c.date === opts.date &&
          c.timeframe === opts.timeframe &&
          c.timestamp === opts.timestamp
        ) {
          return c;
        }
      }
    }
    return undefined;
  }

  function latestMatchingAction(
    predicate: (e: ExecutionContextEntry) => boolean
  ): ExecutionContextEntry | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (predicate(e)) return e;
    }
    return undefined;
  }

  function renderForPrompt(opts: { maxActions?: number; includeCandles?: boolean } = {}): string {
    const { maxActions = 3, includeCandles = true } = opts;
    const recent = entries.slice(-maxActions);
    if (recent.length === 0) return 'No prior actions in this session.';

    const lines: string[] = [];
    for (const e of recent) {
      const status = e.ok === true ? 'success' : e.ok === false ? 'failed' : 'no-action';
      const parts: string[] = [`[${e.sequenceId}]`];
      parts.push(`"${e.originalRequest}"`);
      parts.push(`route:${e.route}`);
      parts.push(`status:${status}`);
      if (e.planSummary) parts.push(`plan:${e.planSummary}`);
      if (e.template?.symbol) parts.push(`symbol:${e.template.symbol}`);
      if (e.template?.timeframeMinutes) parts.push(`tf:${e.template.timeframeMinutes}m`);
      if (e.template?.seekTime) parts.push(`time:${e.template.seekTime}`);
      if (e.template?.relativeSeekMinutes !== undefined) {
        parts.push(`seek:${e.template.relativeSeekMinutes}m`);
      }
      if (e.template?.finalQuery) parts.push(`query:${e.template.finalQuery}`);
      if (e.template?.analysisRequests) {
        const names = e.template.analysisRequests.map((r) => r.kind.replace(/^window_/, '')).join(',');
        parts.push(`analysis:${names}`);
      }
      if (e.after?.symbol) parts.push(`after:${e.after.symbol} ${e.after.date ?? ''} ${e.after.timeframe ?? ''}m`);
      if (e.after?.replayTime) parts.push(`@ ${e.after.replayTime}`);
      if (includeCandles && e.returnedCandles.length > 0) {
        const c = e.returnedCandles[e.returnedCandles.length - 1];
        parts.push(`candle:${c.symbol} ${c.close} @ ${c.marketTime}`);
      }
      const analysisReceipt = e.receipts.find((r) => r.success && r.capability.startsWith('analysis.'));
      if (analysisReceipt) {
        parts.push(`result:${analysisReceipt.message}`);
      }
      lines.push(parts.join(' '));
    }
    return lines.join('\n');
  }

  return {
    record,
    reset,
    getEntries,
    latest,
    latestSuccessfulAction,
    latestFailedAction,
    latestReturnedCandle,
    previousReturnedCandle,
    latestMatchingCandle,
    findCandle,
    findCandleByMarketTime,
    latestMatchingAction,
    renderForPrompt,
  };
}
