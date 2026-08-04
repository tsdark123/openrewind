import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAvailableDatesLoader } from '../availableDatesLoader';

describe('availableDatesLoader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves normally for the most recent request', async () => {
    const payload = { symbol: 'AAPL', dates: ['2026-08-04'], earliest: '2026-08-04', latest: '2026-08-04', count: 1, missing: false };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) } as unknown as Response));

    const loader = createAvailableDatesLoader('http://127.0.0.1:9000');
    const { result, isStale } = await loader.load('AAPL');
    expect(isStale).toBe(false);
    expect(result).toEqual(payload);
  });

  it('marks the older request as stale when a second request is made', async () => {
    const aapl = { symbol: 'AAPL', dates: ['2026-08-04'], earliest: '2026-08-04', latest: '2026-08-04', count: 1, missing: false };
    const abbv = { symbol: 'ABBV', dates: ['2026-08-04'], earliest: '2026-08-04', latest: '2026-08-04', count: 1, missing: false };

    let call = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      call += 1;
      const delay = call === 1 ? 50 : 5;
      const payload = call === 1 ? aapl : abbv;
      return new Promise((resolve) =>
        setTimeout(() => resolve({ ok: true, json: () => Promise.resolve(payload) } as unknown as Response), delay)
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createAvailableDatesLoader('http://127.0.0.1:9000');
    const p1 = loader.load('AAPL');
    const p2 = loader.load('ABBV');
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.isStale).toBe(true);
    expect(r2.isStale).toBe(false);
    expect(r2.result).toEqual(abbv);
  });

  it('aborts an in-flight request on cancel', async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 10);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = createAvailableDatesLoader('http://127.0.0.1:9000');
    const p = loader.load('AAPL');
    loader.cancel();
    const { isStale } = await p;
    expect(isStale).toBe(true);
  });
});
