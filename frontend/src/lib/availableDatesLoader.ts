import { fetchAvailableDates, type AvailableDatesResult } from './engine';

export interface LoadResult {
  result: AvailableDatesResult | null;
  isStale: boolean;
}

export interface AvailableDatesLoader {
  load(symbol: string): Promise<LoadResult>;
  cancel(): void;
}

/**
 * Create a loader that guards against stale available-date responses.
 *
 * Rapid symbol switching or a data_synced refresh can cause an older in-flight
 * request to return after a newer one.  This loader uses a monotonic request id
 * and per-request AbortControllers to ensure only the most recent request
 * updates state.
 */
export function createAvailableDatesLoader(
  apiBase: string,
  dataDir?: string
): AvailableDatesLoader {
  let requestId = 0;
  let currentController: AbortController | null = null;

  return {
    load: async (symbol: string): Promise<LoadResult> => {
      requestId += 1;
      const myId = requestId;

      if (currentController) {
        currentController.abort();
      }
      const controller = new AbortController();
      currentController = controller;

      try {
        const result = await fetchAvailableDates(apiBase, symbol, dataDir, {
          signal: controller.signal,
        });

        if (myId !== requestId) {
          return { result: null, isStale: true };
        }
        return { result, isStale: false };
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return { result: null, isStale: true };
        }
        if (myId !== requestId) {
          return { result: null, isStale: true };
        }
        return { result: null, isStale: false };
      }
    },

    cancel: () => {
      if (currentController) {
        currentController.abort();
        currentController = null;
      }
    },
  };
}
