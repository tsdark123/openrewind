import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReferenceCandle } from '../../reference/types.ts';

export interface EngineAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  fetchCandles(opts: {
    symbol: string;
    date: string;
    timeframe: number;
  }): Promise<ReferenceCandle[]>;
}

export interface FixtureEngineAdapterOptions {
  /** Directory containing fixture JSON files named `<symbol>-<date>-<timeframe>m.json`. */
  fixtureDir?: string;
}

/**
 * Loads candles from committed synthetic fixtures. Used in dry-run mode.
 */
export class FixtureEngineAdapter implements EngineAdapter {
  private fixtureDir: string;

  constructor(opts: FixtureEngineAdapterOptions = {}) {
    this.fixtureDir =
      opts.fixtureDir ??
      path.resolve(import.meta.dirname ?? '.', '..', '..', 'reference', 'fixtures');
  }

  async start(): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    // no-op
  }

  async fetchCandles(opts: {
    symbol: string;
    date: string;
    timeframe: number;
  }): Promise<ReferenceCandle[]> {
    const fileName = `${opts.symbol.toLowerCase()}-${opts.date}-${opts.timeframe}m.json`;
    const filePath = path.join(this.fixtureDir, fileName);

    if (fs.existsSync(filePath)) {
      return this.loadFixture(filePath);
    }

    // Fallback: scan the fixture directory for a file whose metadata matches.
    const entries = fs.readdirSync(this.fixtureDir).filter((f) => f.endsWith('.json'));
    for (const entry of entries) {
      const candidate = path.join(this.fixtureDir, entry);
      const parsed = this.readFixtureMeta(candidate);
      if (
        parsed &&
        String(parsed.symbol).toLowerCase() === opts.symbol.toLowerCase() &&
        parsed.date === opts.date &&
        parsed.timeframe === opts.timeframe
      ) {
        return this.loadFixture(candidate);
      }
    }

    throw new Error(`Fixture not found for ${opts.symbol} ${opts.date} ${opts.timeframe}m in ${this.fixtureDir}`);
  }

  private readFixtureMeta(filePath: string): { symbol: string; date: string; timeframe: number; candles: unknown } | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.candles)) {
        return parsed as { symbol: string; date: string; timeframe: number; candles: unknown };
      }
      return null;
    } catch {
      return null;
    }
  }

  private loadFixture(filePath: string): ReferenceCandle[] {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.candles)) {
      throw new Error(`Invalid fixture: ${filePath}`);
    }
    return parsed.candles as ReferenceCandle[];
  }
}

export interface ProductionEngineAdapterOptions {
  baseUrl: string;
  dataDir?: string;
  timeoutMs?: number;
}

/**
 * Fetches candles from a running OpenRewind engine via `/api/candles`.
 *
 * This adapter does not start the engine process; the orchestrator is expected
 * to do that. It also does not modify production files.
 */
export class ProductionEngineAdapter implements EngineAdapter {
  constructor(private opts: ProductionEngineAdapterOptions) {}

  async start(): Promise<void> {
    // no-op: the orchestrator owns the engine process lifecycle
  }

  async stop(): Promise<void> {
    // no-op
  }

  async fetchCandles(opts: {
    symbol: string;
    date: string;
    timeframe: number;
  }): Promise<ReferenceCandle[]> {
    const url = new URL(`${this.opts.baseUrl}/api/candles`);
    url.searchParams.set('symbol', opts.symbol);
    url.searchParams.set('date', opts.date);
    url.searchParams.set('timeframe', String(opts.timeframe));
    url.searchParams.set('limit', '5000');
    if (this.opts.dataDir) {
      url.searchParams.set('data_dir', this.opts.dataDir);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Engine returned ${response.status}: ${await response.text()}`);
      }
      const data = (await response.json()) as {
        candles: ReferenceCandle[];
        missing?: boolean;
        reason?: string;
      };
      if (data.missing) {
        throw new Error(`Engine reported missing data: ${data.reason ?? 'unknown'}`);
      }
      return data.candles;
    } finally {
      clearTimeout(timer);
    }
  }
}
