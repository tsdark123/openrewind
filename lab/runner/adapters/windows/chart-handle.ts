/**
 * In-memory ChartHandle for the headless lab runner.
 */

import type { CandleData, LabChartHandle } from './types';

export type { LabChartHandle };

export function createLabChartHandle(initial: CandleData[] = []): LabChartHandle {
  let history: CandleData[] = initial.slice();

  return {
    setHistory(candles) {
      history = candles.slice();
    },

    resetChart() {
      history = [];
    },

    updateCandle(payload) {
      const candle: CandleData = {
        timestamp: payload.timestamp,
        open: payload.open,
        high: payload.high,
        low: payload.low,
        close: payload.close,
        volume: payload.volume,
      };

      if (payload.cursor >= history.length) {
        history.push(candle);
      } else {
        history[payload.cursor] = candle;
      }
    },

    getRecentCandles(n) {
      if (n <= 0) return [];
      const result = history.length <= n ? history.slice() : history.slice(-n);

      return result;
    },
  };
}
