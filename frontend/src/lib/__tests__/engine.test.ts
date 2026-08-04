import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { engineUrl, fetchAvailableDates, sessionStartBody } from '../engine';

describe('engine helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('engineUrl', () => {
    it('omits data_dir in managed mode', () => {
      const url = engineUrl('http://127.0.0.1:9000', '/api/tickers');
      expect(url).toBe('http://127.0.0.1:9000/api/tickers');
    });

    it('includes data_dir and query params in local mode', () => {
      const url = engineUrl(
        'http://127.0.0.1:9000',
        '/api/available_dates',
        { symbol: 'AAPL' },
        'C:/OpenRewind/data'
      );
      expect(url).toContain('/api/available_dates?');
      expect(url).toContain('symbol=AAPL');
      expect(decodeURIComponent(url)).toContain('data_dir=C:/OpenRewind/data');
    });
  });

  describe('sessionStartBody', () => {
    it('includes data_dir only in local mode', () => {
      const managed = sessionStartBody({ symbol: 'AAPL', starting_balance: 100000, start_date: '2026-08-04' });
      expect(managed).not.toHaveProperty('data_dir');

      const local = sessionStartBody(
        { symbol: 'AAPL', starting_balance: 100000, start_date: '2026-08-04' },
        'C:/OpenRewind/data'
      );
      expect(local.data_dir).toBe('C:/OpenRewind/data');
    });
  });

  describe('fetchAvailableDates', () => {
    it('returns parsed available dates from the engine', async () => {
      const payload = {
        symbol: 'AAPL',
        dates: ['2026-07-06', '2026-08-04'],
        earliest: '2026-07-06',
        latest: '2026-08-04',
        count: 2,
        missing: false,
      };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payload),
      } as unknown as Response);
      vi.stubGlobal('fetch', fetchMock);

      const result = await fetchAvailableDates('http://127.0.0.1:9000', 'AAPL');
      expect(result).toEqual(payload);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain('/api/available_dates');
      expect(calledUrl).toContain('symbol=AAPL');
    });

    it('throws when the engine returns an error status', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as unknown as Response);
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchAvailableDates('http://127.0.0.1:9000', 'AAPL')).rejects.toThrow('Engine returned 500');
    });
  });
});
