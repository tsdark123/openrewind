# Windows Production Adapter Handoff

> This document is read-only reference for the Windows-local Devin session that will run the Orion Scenario Lab against real `qwen3:8b`, the OpenRewind engine, and Tauri.

## 1. Exact adapter exports required

The lab runner (`lab/runner/run.ts`) dynamically loads a module path supplied by `--adapter-module` (or `ORION_LAB_PRODUCTION_ADAPTER_MODULE`). That module must export:

```ts
export async function createProductionAgentAdapter(
  engineUrl: string,
  initialWorldState: unknown,
): Promise<AgentAdapter>;

export async function createProductionEngineAdapter(
  engineUrl: string,
): Promise<EngineAdapter>;
```

The `AgentAdapter` and `EngineAdapter` interfaces are the lab contracts in `lab/runner/adapters/agent-adapter.ts` and `lab/runner/adapters/engine-adapter.ts`.

A non-operational typed scaffold is committed at `lab/runner/adapters/windows-production-adapter.ts`. It compiles but every real method throws `NOT_IMPLEMENTED`. Copy that file to a Windows-local location, replace the stubs with the wiring below, and pass the copy to `orchestrator.ps1` via `-AdapterModule`.

## 2. Exact input and return types

The production entry point is `frontend/src/lib/orion/agent/orchestrator.ts`:

```ts
export interface OrchestratorOptions {
  setupReady: boolean; // true when qwen3:8b is verified warm
  text: string;
  ctx: AgentContext;
  signal?: AbortSignal;
}

export interface OrchestratorResult {
  ok: boolean;
  message: string;
  wasChat: boolean;
  plan?: AgentPlan;
  result?: AgentExecutionResult;
  route: 'chat' | 'deterministic' | 'resolve' | 'llm-plan' | 'clarification' | 'unsupported' | 'unrecognized' | 'recent-action-summary' | 'error' | 'aborted';
}

export async function handleOrionMessage(opts: OrchestratorOptions): Promise<OrchestratorResult>;
```

`AgentExecutionResult` is in `frontend/src/lib/orion/agent/types.ts`:

```ts
export interface AgentExecutionResult {
  planId: string;
  ok: boolean;
  receipts: ExecutionReceipt[];
  stoppedAtStepId?: string;
  finalWorldState?: unknown;
  errorCode?: string;
  errorMessage?: string;
}
```

`ExecutionReceipt` shape:

```ts
interface ExecutionReceiptSuccess<TData = unknown> {
  planId: string;
  stepId: string;
  capability: string;
  success: true;
  message: string;
  data?: TData;
  stateChanges?: StateChange<TData>[];
  finalizedAt: number;
}

interface ExecutionReceiptFailure { /* same fields plus errorCode */ }
```

## 3. Exact production imports to reuse

The real adapter should import these from the production source tree (not from the lab):

```ts
import { handleOrionMessage } from '../frontend/src/lib/orion/agent/orchestrator';
import { createExecutionContext } from '../frontend/src/lib/orion/agent/executionContext';
import { buildWorldState, type WorldState } from '../frontend/src/lib/orion/worldState';
import { engineUrl } from '../frontend/src/lib/engine';
import type { AppState, AppAction, PerformanceLog, CandleData } from '../frontend/src/types';
import type { AgentContext, AgentPlan, AgentExecutionResult, ExecutionContextStore, ExecutionContextEntry } from '../frontend/src/lib/orion/agent/types';
```

If the Windows runner cannot bundle React/Tauri modules, re-implement `AgentContext` and `ExecutionContextStore` in plain Node and call `handleOrionMessage` from a compiled frontend bundle (Vite `lib` build) instead of importing source directly. Do not copy production logic into the lab except via this adapter module.

## 4. State that must persist across turns in one scenario

Within one scenario, the adapter must preserve:

- `executionLog: ExecutionContextStore` — call `createExecutionContext()` once per scenario and pass the same object to every `handleOrionMessage` call. This is the only context inheritance mechanism.
- The live `AppState` object returned by `getState()` and mutated by `dispatch()`.
- The WebSocket connection to the engine, so that `send()` and event-driven `dispatch()` stay consistent.
- `performanceLog` (empty `{}` is acceptable for lab runs; populated only if you want journal/account metrics).
- `chartRef.current` history buffer, updated from engine `session_state` / `candle_update` events.
- `lastResult` (`AgentExecutionResult | undefined`) from the previous turn.
- `availableTickers` list (populated from `/api/tickers` once per scenario).

## 5. State that must reset between scenarios

For each new scenario:

- Create a fresh `ExecutionContextStore` (`createExecutionContext()` or equivalent).
- Reset `AppState` to the scenario's `initialWorldState`.
- Reset `lastResult` to `undefined`.
- Reset `performanceLog` to `{}`.
- Stop and restart the engine session to the scenario's symbol/date/timeframe, or call `/api/session/stop` followed by a fresh start.

Do not reuse `executionLog`, `AppState`, or `chartRef` history between scenarios, or multi-turn context tests will be contaminated.

## 6. How the engine should be started on an isolated port

The engine is `openrewind-engine.exe` (or `openrewind-engine` if built for WSL). It reads environment variables, not CLI flags:

```powershell
$env:OPENREWIND_PORT = "19000"
$env:OPENREWIND_DATA_DIR = "$PWD\lab\data"
# Optional:
# $env:OPENREWIND_LOCAL_DATA_DIR = "$PWD\lab\local-data"

& .\engine\build\Release\openrewind-engine.exe
```

The orchestrator (`lab/orchestrator.ps1`) discovers the executable in this order:

1. `$env:ORION_ENGINE_PATH`
2. `engine/build/**/openrewind-engine.exe`
3. `engine/out/**/openrewind-engine.exe`
4. `src-tauri/binaries/openrewind-engine*.exe`

After starting, wait for HTTP readiness by polling `GET http://127.0.0.1:<PORT>/api/session/state` until it returns `200` (or `400` with `No active session`). The orchestrator uses a 30-second timeout.

The frontend `apiBase` should be `http://127.0.0.1:<PORT>` (not empty, because the runner is outside the Vite dev proxy).

## 7. How readiness should be verified before scenarios begin

Before the first scenario:

1. Verify Ollama at `http://127.0.0.1:11434/api/tags` contains `qwen3:8b`.
2. Verify `GET http://127.0.0.1:<PORT>/api/tickers` returns `{ tickers: [...] }` and contains the scenario symbol.
3. Optionally warm the model with a single `/api/chat` request to `qwen3:8b` (same body Orion uses). The orchestrator does not require this; `setupReady` should be `true` when model and engine are both reachable.

Do not call `ollama pull` or `ollama run` automatically. If the model is missing, fail fast with:

```
Model qwen3:8b not found. Run: ollama pull qwen3:8b
```

## 8. How the adapter obtains final WorldState, capabilities, receipts, context template, route and message

For each turn, call `handleOrionMessage({ text, ctx, setupReady: true, signal })`. Then build the lab `AgentTurnResult`:

```ts
const outcome = await handleOrionMessage({ text, ctx, setupReady: true });

const capabilities = outcome.plan?.steps.map((s) => s.capability) ?? [];
const receipts = (outcome.result?.receipts ?? []) as Record<string, unknown>[];
const message = outcome.message;
const route = outcome.route;
const plan = outcome.plan;

// finalWorldState can come from the executor or be rebuilt explicitly
const finalWorldState =
  (outcome.result?.finalWorldState as Record<string, unknown>) ??
  (buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog) as unknown as Record<string, unknown>);

// template is stored in the execution log by finalizeTurn()
const latest = ctx.executionLog.latestSuccessfulAction();
const template = latest?.template as Record<string, unknown> | undefined;

return {
  ok: outcome.ok,
  route,
  message,
  plan,
  capabilities,
  receipts,
  template,
  finalWorldState,
  durationMs, // measure wall-clock in the adapter
};
```

`handleOrionMessage` itself records `before`/`after` snapshots and `template` into `ctx.executionLog` via `finalizeTurn()`, so `executionLog.latestSuccessfulAction()` is authoritative for context inheritance.

## 9. How process/model ownership is tracked

Rules from `orchestrator.ps1`:

- The orchestrator starts only the engine process (`openrewind-engine.exe`).
- It never starts or stops Ollama in V1.
- It never unloads `qwen3:8b` unless both `-ReleaseModelAfterRun` is set **and** `$env:ORION_LAB_OWNS_OLLAMA_LIFECYCLE -eq "1"`.
- The adapter must not stop the engine process it did not start.
- If the adapter needs to release the model, guard it the same way:

```powershell
if ($ReleaseModelAfterRun -and $env:ORION_LAB_OWNS_OLLAMA_LIFECYCLE -eq "1") {
  # POST to Ollama /api/generate with { model: "qwen3:8b", keep_alive: 0 }
}
```

The default is to leave `qwen3:8b` resident so it does not disrupt other OpenRewind sessions.

## 10. Required Windows commands and environment variables

Environment variables consumed by production:

- `OPENREWIND_PORT` — engine HTTP/WebSocket port.
- `OPENREWIND_DATA_DIR` — engine default data directory.
- `OPENREWIND_LOCAL_DATA_DIR` — optional extra local data root.
- `OLLAMA_BASE_URL` — Ollama endpoint (default `http://127.0.0.1:11434`).
- `ORION_CHAT_TIMEOUT_MS` — chat timeout (default `60000`).
- `ORION_AGENT_MODEL` — optional override; leave unset to keep production default `qwen3:8b`.
- `VITE_ORION_AGENT_MODEL` — browser dev override; irrelevant for Node runner.
- `ORION_LAB_OWNS_OLLAMA_LIFECYCLE=1` — required before the orchestrator will unload the model.
- `ORION_LAB_PRODUCTION_ADAPTER_MODULE` — optional fallback adapter path.

Command sequence:

```powershell
# 1. Ensure qwen3:8b is present.
Invoke-RestMethod http://127.0.0.1:11434/api/tags -Method GET

# 2. Ensure data directory has CSVs.
#    Expected layout: lab/data/SYNTH/SYNTH_history.csv
#    Columns:        YYYY-MM-DD HH:MM:SS,open,high,low,close,volume

# 3. Run from repo root.
pwsh lab/orchestrator.ps1 `
  -Port 19000 `
  -DataDir "$PWD\lab\data" `
  -Model qwen3:8b `
  -AdapterModule "$PWD\lab\runner\adapters\windows-production-adapter.impl.ts"
```

## 11. Failure behavior when any dependency is unavailable

The adapter and orchestrator must fail closed:

- Ollama not reachable or `qwen3:8b` missing → throw before starting engine.
- Engine executable not found → throw before starting scenarios.
- Engine HTTP not healthy after 30 seconds → throw.
- `--adapter-module` not supplied for `--mode production` → `run.ts` throws.
- `handleOrionMessage` returns `ok: false` and `route: 'error'` → still return the `AgentTurnResult`; the lab oracle decides if the scenario fails.
- WebSocket error or disconnect → throw; do not silently switch to deterministic-only mode.
- Any unexpected exception during a turn → throw; the runner records the failure envelope.

Never fall back to `FixtureAgentAdapter` in production mode. Fixture mode is selected only by `--mode fixture`.

## 12. Step-by-step implementation checklist

1. Build the OpenRewind engine on Windows or locate `openrewind-engine.exe`.
2. Prepare `lab/data/<SYMBOL>/<SYMBOL>_history.csv` for every symbol used by the scenario manifest.
3. Ensure `qwen3:8b` is pulled and Ollama is already running.
4. Copy `lab/runner/adapters/windows-production-adapter.ts` to a local implementation file.
5. In the copy, import `handleOrionMessage`, `createExecutionContext`, and `buildWorldState` from the production source tree or from a built frontend bundle.
6. Implement `createProductionEngineAdapter`:
   - `start()` should poll `GET {engineUrl}/api/session/state` until healthy.
   - `fetchCandles()` should call `GET {engineUrl}/api/candles?symbol=...&date=...&timeframe=...&limit=5000&data_dir=...`.
   - `stop()` should be a no-op (the orchestrator owns the process).
7. Implement `createProductionAgentAdapter`:
   - Build an in-memory `AppState` from `initialWorldState`.
   - Open a WebSocket to `ws://127.0.0.1:<PORT>/ws`.
   - Map incoming WS events to `AppAction` dispatches (see `frontend/src/types/index.ts` and `frontend/src/App.tsx` for action shapes).
   - Implement `send(payload)` to write JSON commands to the WebSocket.
   - Implement `onSwitchSymbol(symbol, date)` by sending `{ cmd: 'set_symbol', symbol, start_date, starting_balance, data_dir }` or by `POST /api/session/start`.
   - Implement `getState()`, `chartRef`, `availableTickers`, `performanceLog`, `apiBase`, `dataDir`, `dispatch`, `executionLog`, and `lastResult`.
8. On every `send(text, ctx)`, call `handleOrionMessage({ text, ctx, setupReady: true })` and map the `OrchestratorResult` to `AgentTurnResult`.
9. Before each scenario, reset `executionLog`, `AppState`, `chartRef` history, and `lastResult`.
10. After all scenarios, the orchestrator stops the engine. Do not stop Ollama or unload the model unless ownership is confirmed.

---

## Appendix A — Engine endpoints used by the agent

- `GET /api/tickers?data_dir=...` — returns `{ tickers: string[] }`
- `POST /api/session/start` — body `{ symbol, starting_balance, start_date?, data_dir? }`, returns `{ session_id, symbol, total_candles, start_ts, end_ts, start_date, start_cursor }`
- `GET /api/session/state` — returns full state JSON or `{ error: 'No active session' }`
- `POST /api/session/stop` — stops active session
- `GET /api/candles?symbol=...&date=...&timeframe=...&limit=...&data_dir=...` — returns `{ candles: CandleData[], missing?, reason?, fallbackUsed?, fallbackDate? }`
- `GET /api/available_dates?symbol=...&data_dir=...` — returns available date range
- `POST /api/data_refreshed` — notification endpoint; not needed for lab runs
- WebSocket `ws://host:port/ws` — receives `session_state`, `candle_update`, `account_snapshot`, `order_filled`, `position_closed`, `session_started`
- WebSocket commands sent by `ctx.send()`: `set_symbol`, `seek`, `play`, `pause`, `set_speed`, `set_direction`, `set_timeframe`, `place_order`, `cancel_order`, `close_position`, `update_position_sltp`, `reset_session`, `next_candle`, `rewind`

## Appendix B — WebSocket event to dispatch mapping

The adapter must convert engine events into the same actions `App.tsx` uses:

- `session_started` → `dispatch({ type: 'SESSION_STARTED', payload })`
- `session_state` → `dispatch({ type: 'SESSION_STATE', payload })`
- `candle_update` → `dispatch({ type: 'CANDLE_UPDATE', payload })`
- `account_snapshot` → `dispatch({ type: 'ACCOUNT_SNAPSHOT', payload })`
- `order_filled` → `dispatch({ type: 'ORDER_FILLED', payload })`
- `position_closed` → `dispatch({ type: 'POSITION_CLOSED', payload })`

`AppState` must be updated before `handleOrionMessage` reads `ctx.getState()`.

## Appendix C — Selecting `qwen3:8b` without changing production defaults

`frontend/src/lib/orion/certifiedModels.ts` already hard-codes `qwen3:8b` as the certified default. Do **not** set `ORION_AGENT_MODEL` or `VITE_ORION_AGENT_MODEL` unless you intentionally want an uncertified override. The adapter should simply pass `setupReady: true` after verifying the model exists at `OLLAMA_BASE_URL`.

## Appendix D — Cancellation and timeout

- `handleOrionMessage` accepts an `AbortSignal`. The adapter should create a fresh `AbortController` per turn and abort if the turn exceeds the configured timeout.
- Do not reuse the same `AbortController` across turns.
- The orchestrator does not have a global run timeout in V1; add one in the adapter if desired.

## Appendix E — Cleanup requirements after a run

- Stop the engine process only if the orchestrator started it.
- Leave Ollama and `qwen3:8b` loaded unless `-ReleaseModelAfterRun` and `ORION_LAB_OWNS_OLLAMA_LIFECYCLE=1`.
- Preserve `lab/outbox/<runId>/events.jsonl`, `summary.json`, and `report.md`.
- Do not modify `lab/reference/fixtures/` or committed scenarios.
