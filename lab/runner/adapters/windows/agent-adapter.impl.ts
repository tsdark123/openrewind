/**
 * Windows production agent adapter for the Orion Scenario Lab.
 */

import type { AgentAdapter, AgentTurnContext, AgentTurnResult } from '../agent-adapter';
import type { ScenarioRuntime, AppState, AppAction, CandleData } from './types';
import { findScenarioById, resetScenarioRuntime, resetDefaultRuntime, stopEngineSession } from './lifecycle';
import { buildAgentContext, startEngineSession } from './agent-context';
import { appReducer } from './app-state';
import { createEngineWebSocketClient, type EngineWebSocketClient } from './websocket-client';
import { mapOrchestratorResultToTurnResult } from './result-mapper';
import { loadProductionModules } from './production-loader';

const DEFAULT_TURN_TIMEOUT_MS = 60000;

function createMutableGetState(runtime: ScenarioRuntime): () => AppState {
  return () => runtime.appState;
}

function createMutableDispatch(runtime: ScenarioRuntime): (action: AppAction) => void {
  return (action) => {
    runtime.appState = appReducer(runtime.appState, action);
  };
}

function createSend(ws: EngineWebSocketClient): (payload: Record<string, unknown>) => void {
  return (payload) => ws.send(payload);
}

class WindowsProductionAgentAdapter implements AgentAdapter {
  private engineUrl: string;
  private dataDir: string | undefined;
  private turnTimeoutMs: number;
  private ws!: EngineWebSocketClient;
  private production: Awaited<ReturnType<typeof loadProductionModules>>;

  private currentScenarioId: string | undefined;
  private runtime: ScenarioRuntime;

  constructor(
    engineUrl: string,
    dataDir: string | undefined,
    turnTimeoutMs: number,
    production: Awaited<ReturnType<typeof loadProductionModules>>,
  ) {
    this.engineUrl = engineUrl;
    this.dataDir = dataDir;
    this.turnTimeoutMs = turnTimeoutMs;
    this.production = production;
    this.runtime = resetDefaultRuntime(this.production.createExecutionContext);
  }

  setWebSocket(ws: EngineWebSocketClient): void {
    this.ws = ws;
  }

  setRuntime(runtime: ScenarioRuntime): void {
    this.runtime = runtime;
  }

  handleWsAction(action: AppAction): void {
    this.runtime.appState = appReducer(this.runtime.appState, action);
    if (action.type === 'SESSION_STATE' && Array.isArray((action.payload as { candles?: unknown }).candles)) {
      this.runtime.chartHandle.setHistory((action.payload as { candles: CandleData[] }).candles);
    }
    if (action.type === 'SESSION_STARTED') {
      this.runtime.chartHandle.resetChart();
    }
    if (action.type === 'CANDLE_UPDATE') {
      this.runtime.chartHandle.updateCandle(action.payload as import('./types').CandleUpdatePayload);
    }
  }

  handleSessionHistory(candles: CandleData[]): void {
    this.runtime.chartHandle.setHistory(candles);
  }

  handleCandleUpdate(payload: import('./types').CandleUpdatePayload): void {
    this.runtime.chartHandle.updateCandle(payload);
  }

  async send(text: string, ctx: AgentTurnContext): Promise<AgentTurnResult> {
    const isNewScenario = ctx.scenarioId !== this.currentScenarioId;

    if (isNewScenario) {
      this.currentScenarioId = ctx.scenarioId;
      await stopEngineSession(this.engineUrl);

      const scenario = findScenarioById(ctx.scenarioId);
      if (scenario) {
        this.setRuntime(resetScenarioRuntime(scenario.initialWorldState, this.production.createExecutionContext));
      } else {
        this.setRuntime(resetDefaultRuntime(this.production.createExecutionContext));
      }

      const initialCursor = this.runtime.appState.cursor;

      if (this.runtime.appState.sessionActive) {
        try {
          const sessionInfo = await startEngineSession({
            apiBase: this.engineUrl,
            symbol: this.runtime.appState.symbol,
            startDate: this.runtime.appState.replayDate,
            dataDir: this.dataDir,
            startingBalance: 100000,
          });

          if (typeof sessionInfo.start_ts === 'number') {
            this.runtime.appState.startTimestamp = sessionInfo.start_ts;
          }

          if (initialCursor > 0 && this.ws && this.ws.connected() && this.runtime.appState.startTimestamp > 0) {
            const target = this.runtime.appState.startTimestamp + initialCursor * 60;
            this.ws.send({ cmd: 'seek', timestamp: target });
            const waitStart = Date.now();
            while (Date.now() - waitStart < 3000) {
              if (this.runtime.appState.cursor === initialCursor) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            ok: false,
            route: 'error',
            message: `Pre-start failed for scenario ${ctx.scenarioId}: ${msg}`,
            capabilities: [],
            receipts: [],
          };
        }
      }
    }

    const getState = createMutableGetState(this.runtime);
    const dispatch = createMutableDispatch(this.runtime);
    const chartHandle = this.runtime.chartHandle;
    const performanceLog = this.runtime.performanceLog;
    const executionLog = this.runtime.executionLog;

    const agentCtx = buildAgentContext({
      getState,
      chartHandle,
      performanceLog,
      apiBase: this.engineUrl,
      dataDir: this.dataDir,
      availableTickers: this.runtime.availableTickers,
      send: createSend(this.ws),
      dispatch,
      onSwitchSymbol: this.createOnSwitchSymbol(dispatch, chartHandle),
      lastResult: this.runtime.lastResult,
      executionLog,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.turnTimeoutMs);
    const start = Date.now();

    try {
      const outcome = await this.production.handleOrionMessage({
        text,
        ctx: agentCtx,
        setupReady: true,
        signal: controller.signal,
      });

      const durationMs = Date.now() - start;

      if (outcome.result) {
        this.runtime.lastResult = outcome.result as Record<string, unknown>;
      }

      const result = mapOrchestratorResultToTurnResult(
        outcome,
        getState(),
        chartHandle,
        performanceLog,
        executionLog,
        (s, ref, log) => this.production.buildWorldState(s, ref, log) as Record<string, unknown>,
        durationMs,
      );

      return result;
    } catch (e) {
      const durationMs = Date.now() - start;
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        route: 'error',
        message: `handleOrionMessage threw: ${msg}`,
        capabilities: [],
        receipts: [],
        durationMs,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private createOnSwitchSymbol(
    dispatch: (action: AppAction) => void,
    chartHandle: import('./types').LabChartHandle,
  ): (symbol: string, date?: string) => Promise<void> {
    return async (symbol, date) => {
      if (!symbol) return;

      dispatch({ type: 'SESSION_STOPPED' });
      chartHandle.resetChart();

      const res = await startEngineSession({
        apiBase: this.engineUrl,
        symbol,
        startDate: date ?? '',
        dataDir: this.dataDir,
        startingBalance: 100000,
      });

      if ('error' in res && res.error) {
        throw new Error(`Engine refused session start: ${JSON.stringify(res.error)}`);
      }
    };
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

export async function createProductionAgentAdapter(
  engineUrl: string,
  initialWorldState: unknown,
): Promise<AgentAdapter> {
  const dataDir = process.env.OPENREWIND_DATA_DIR;
  const turnTimeoutMs = process.env.ORION_CHAT_TIMEOUT_MS
    ? Number(process.env.ORION_CHAT_TIMEOUT_MS)
    : DEFAULT_TURN_TIMEOUT_MS;

  const wsUrl = engineUrl.replace(/^http/, 'ws') + '/ws';
  const production = await loadProductionModules();

  const adapter = new WindowsProductionAgentAdapter(engineUrl, dataDir, turnTimeoutMs, production);
  const runtime = resetScenarioRuntime(
    (initialWorldState ?? {}) as import('./types').ScenarioInitialWorldState,
    production.createExecutionContext,
  );
  adapter.setRuntime(runtime);

  const ws = createEngineWebSocketClient({
    url: wsUrl,
    dispatch: (action) => adapter.handleWsAction(action),
    onSessionHistory: (candles) => adapter.handleSessionHistory(candles),
    onCandleUpdate: (payload) => adapter.handleCandleUpdate(payload),
  });

  adapter.setWebSocket(ws);

  const wsWaitStart = Date.now();
  while (Date.now() - wsWaitStart < 5000) {
    if (ws.connected()) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  return adapter;
}
