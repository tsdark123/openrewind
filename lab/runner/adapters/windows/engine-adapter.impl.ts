/**
 * Windows production engine adapter for the Orion Scenario Lab.
 *
 * The orchestrator owns the engine process, so this adapter does not start or
 * stop it. It only verifies HTTP readiness and fetches candles through the real
 * /api/candles endpoint, preserving exact timestamps and OHLCV values.
 */

import type { ReferenceCandle } from '../../../reference/types';
import type { EngineAdapter } from '../engine-adapter';

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function marketTimeFromIndex(index: number, minutesPerBar: number): string {
  const startMinutes = 9 * 60 + 30; // 09:30
  const totalMinutes = startMinutes + index * minutesPerBar;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function addMarketTime(candles: ReferenceCandle[], timeframe: number): ReferenceCandle[] {
  if (candles.length === 0) return candles;
  const startTs = candles[0].timestamp;
  return candles.map((c) => {
    const index = Math.round((c.timestamp - startTs) / (timeframe * 60));
    return { ...c, marketTime: marketTimeFromIndex(index, timeframe) };
  });
}

export interface ProductionEngineAdapterOptions {
  /** Engine REST base URL, e.g. http://127.0.0.1:19000 */
  baseUrl: string;
  /** Optional data directory override for /api/candles. */
  dataDir?: string;
  /** How long to wait for the engine to become healthy. */
  healthTimeoutMs?: number;
  /** HTTP request timeout for candle fetches. */
  fetchTimeoutMs?: number;
}

class WindowsProductionEngineAdapter implements EngineAdapter {
  constructor(private opts: ProductionEngineAdapterOptions) {}

  async start(): Promise<void> {
    const deadline = Date.now() + (this.opts.healthTimeoutMs ?? 30000);
    const url = `${this.opts.baseUrl}/api/session/state`;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok || res.status === 400) {
          const body = (await res.json()) as Record<string, unknown>;
          if (res.ok || body.error === 'No active session') {
            return;
          }
        }
      } catch {
        // Engine not yet reachable; keep polling.
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    throw new Error(`Engine did not become healthy at ${this.opts.baseUrl} within ${this.opts.healthTimeoutMs ?? 30000}ms`);
  }

  async stop(): Promise<void> {
    // The orchestrator started the engine and is responsible for stopping it.
    // Do not stop a process this adapter did not start.
  }

  async fetchCandles(opts: { symbol: string; date: string; timeframe: number }): Promise<ReferenceCandle[]> {
    const url = new URL(`${this.opts.baseUrl}/api/candles`);
    url.searchParams.set('symbol', opts.symbol);
    url.searchParams.set('date', opts.date);
    url.searchParams.set('timeframe', String(opts.timeframe));
    url.searchParams.set('limit', '5000');
    if (this.opts.dataDir) {
      url.searchParams.set('data_dir', this.opts.dataDir);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs ?? 30000);

    try {
      const res = await fetch(url.toString(), { signal: controller.signal });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Engine /api/candles returned ${res.status}: ${text}`);
      }

      const data = (await res.json()) as {
        candles: ReferenceCandle[];
        missing?: boolean;
        reason?: string;
      };

      if (data.missing) {
        throw new Error(`Engine reported missing candles: ${data.reason ?? 'unknown'}`);
      }

      if (!Array.isArray(data.candles)) {
        throw new Error('Engine /api/candles response did not contain a candles array');
      }

      return addMarketTime(data.candles, opts.timeframe);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function createProductionEngineAdapter(
  engineUrl: string,
  opts: Omit<ProductionEngineAdapterOptions, 'baseUrl'> = {},
): Promise<EngineAdapter> {
  const dataDir = process.env.OPENREWIND_DATA_DIR;
  return new WindowsProductionEngineAdapter({
    baseUrl: engineUrl,
    dataDir: opts.dataDir ?? dataDir,
    healthTimeoutMs: opts.healthTimeoutMs,
    fetchTimeoutMs: opts.fetchTimeoutMs,
  });
}
