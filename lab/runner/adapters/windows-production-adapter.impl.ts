/**
 * Windows-local production adapter entry point for the Orion Scenario Lab.
 *
 * Exports the two functions required by lab/runner/run.ts in production mode:
 *   - createProductionAgentAdapter
 *   - createProductionEngineAdapter
 *
 * The real implementation lives in lab/runner/adapters/windows/ so it can be
 * split into focused, type-checkable modules without crowding a single file.
 */

import type { AgentAdapter } from './agent-adapter';
import type { EngineAdapter } from './engine-adapter';
import { createProductionAgentAdapter as createAgent } from './windows/agent-adapter.impl';
import { createProductionEngineAdapter as createEngine } from './windows/engine-adapter.impl';

export async function createProductionAgentAdapter(
  engineUrl: string,
  initialWorldState: unknown,
): Promise<AgentAdapter> {
  return createAgent(engineUrl, initialWorldState);
}

export async function createProductionEngineAdapter(
  engineUrl: string,
): Promise<EngineAdapter> {
  return createEngine(engineUrl);
}
