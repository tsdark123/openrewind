/**
 * Scenario and session lifecycle helpers for the Windows production adapter.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScenarioInitialWorldState, LoadedScenario, ScenarioRuntime, CandleData } from './types';
import { createDefaultAppState, appStateFromInitialWorldState } from './app-state';
import { createLabChartHandle } from './chart-handle';

export function findScenarioById(scenarioId: string): LoadedScenario | undefined {
  const scenariosRoot = path.resolve(import.meta.dirname ?? '.', '..', '..', '..', 'scenarios');
  if (!fs.existsSync(scenariosRoot)) return undefined;

  function scan(dir: string): LoadedScenario | undefined {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = scan(fullPath);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const parsed = JSON.parse(raw) as { id: string; dataSet: unknown; initialWorldState: unknown };
          if (parsed.id === scenarioId) {
            return {
              id: parsed.id,
              dataSet: parsed.dataSet as LoadedScenario['dataSet'],
              initialWorldState: parsed.initialWorldState as ScenarioInitialWorldState,
            };
          }
        } catch {
          // ignore malformed scenario files
        }
      }
    }
    return undefined;
  }

  return scan(scenariosRoot);
}

export function resetScenarioRuntime(
  initial: ScenarioInitialWorldState,
  createExecutionContext: () => Record<string, unknown>,
): ScenarioRuntime {
  const appState = appStateFromInitialWorldState(initial);
  const recentCandles = Array.isArray(initial.recentCandles) ? (initial.recentCandles as CandleData[]) : [];
  const chartHandle = createLabChartHandle(recentCandles);

  return {
    appState,
    chartHandle,
    performanceLog: {},
    lastResult: undefined,
    executionLog: createExecutionContext(),
    availableTickers: Array.isArray(initial.availableTickers) ? initial.availableTickers : [],
  };
}

export function resetDefaultRuntime(
  createExecutionContext: () => Record<string, unknown>,
): ScenarioRuntime {
  return {
    appState: createDefaultAppState(),
    chartHandle: createLabChartHandle(),
    performanceLog: {},
    lastResult: undefined,
    executionLog: createExecutionContext(),
    availableTickers: [],
  };
}

export async function stopEngineSession(apiBase: string): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/api/session/stop`, { method: 'POST' });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Engine session stop failed: ${res.status} ${text}`);
    }
  } catch (e) {
    if (e instanceof Error && !/fetch failed|ECONNREFUSED/i.test(e.message)) {
      throw e;
    }
  }
}
