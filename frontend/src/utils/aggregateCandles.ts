import type { CandleData } from '../types';

/**
 * Aggregates 1-minute candles into higher timeframe OHLCV bars.
 *
 * Groups raw candles by flooring their timestamp to the nearest
 * `tfMinutes` boundary, then merges each group into a single bar
 * with correct OHLCV semantics.
 *
 * @param raw       - Array of 1-minute CandleData (sorted by timestamp asc)
 * @param tfMinutes - Target timeframe in minutes (1, 5, 15, 60, 240, 1440)
 * @returns         - Aggregated CandleData array
 */
export function aggregateCandles(
  raw: CandleData[],
  tfMinutes: number
): CandleData[] {
  if (tfMinutes <= 1 || raw.length === 0) {
    return raw;
  }

  const tfSeconds = tfMinutes * 60;
  const result: CandleData[] = [];

  let bucket: CandleData | null = null;
  let bucketKey = -1;

  for (const c of raw) {
    const key = Math.floor(c.timestamp / tfSeconds);

    if (key !== bucketKey) {
      // Flush previous bucket
      if (bucket) {
        result.push(bucket);
      }
      // Start new bucket
      bucketKey = key;
      bucket = {
        timestamp: key * tfSeconds,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else if (bucket) {
      // Merge into current bucket
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
  }

  // Flush last bucket
  if (bucket) {
    result.push(bucket);
  }

  return result;
}
