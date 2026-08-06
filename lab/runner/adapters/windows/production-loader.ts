/**
 * Dynamic loader for the real production Orion modules.
 *
 * Using dynamic imports with non-literal specifiers keeps the production
 * TypeScript source out of the lab package's type-checking program, while still
 * letting tsx load and execute the real modules at runtime. The lab's
 * tsconfig.json `paths` entries for `react-dom` and `@tauri-apps/plugin-http`
 * ensure those production imports resolve to no-op shims in Node.
 */

const ORCHESTRATOR_PATH = '../../../../frontend/src/lib/orion/agent/orchestrator.ts';
const EXECUTION_CONTEXT_PATH = '../../../../frontend/src/lib/orion/agent/executionContext.ts';
const WORLDSTATE_PATH = '../../../../frontend/src/lib/orion/worldState.ts';
const ENGINE_PATH = '../../../../frontend/src/lib/engine.ts';

export interface ProductionModules {
  handleOrionMessage: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  createExecutionContext: () => Record<string, unknown>;
  buildWorldState: (state: unknown, chartRef: unknown, performanceLog: unknown, options?: unknown) => unknown;
  engineUrl: (apiBase: string, path: string, params?: Record<string, string | number | undefined>, dataDir?: string) => string;
  sessionStartBody: (params: { symbol: string; starting_balance: number; start_date?: string }, dataDir?: string) => Record<string, unknown>;
}

export async function loadProductionModules(): Promise<ProductionModules> {
  const resolve = (p: string) => new URL(p, import.meta.url).href;
  const [orchestrator, executionContext, worldState, engine] = await Promise.all([
    import(resolve(ORCHESTRATOR_PATH)),
    import(resolve(EXECUTION_CONTEXT_PATH)),
    import(resolve(WORLDSTATE_PATH)),
    import(resolve(ENGINE_PATH)),
  ]);

  return {
    handleOrionMessage: orchestrator.handleOrionMessage as (opts: Record<string, unknown>) => Promise<Record<string, unknown>>,
    createExecutionContext: executionContext.createExecutionContext as () => Record<string, unknown>,
    buildWorldState: worldState.buildWorldState as (state: unknown, chartRef: unknown, performanceLog: unknown, options?: unknown) => unknown,
    engineUrl: engine.engineUrl as (apiBase: string, path: string, params?: Record<string, string | number | undefined>, dataDir?: string) => string,
    sessionStartBody: engine.sessionStartBody as (params: { symbol: string; starting_balance: number; start_date?: string }, dataDir?: string) => Record<string, unknown>,
  };
}
