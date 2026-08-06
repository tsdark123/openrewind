import type { AgentPlan } from '../scenario-types.ts';

/**
 * Lab-specific representation of a single Orion turn result.
 *
 * This shape intentionally does not import production OrchestratorResult so
 * that fixture and production adapters can both implement the same interface
 * without dragging in React/Tauri types.
 */
export interface AgentTurnResult {
  ok: boolean;
  route?:
    | 'llm-plan'
    | 'deterministic'
    | 'clarification'
    | 'unsupported'
    | 'chat'
    | 'error'
    | 'resolve'
    | 'recent-action-summary'
    | 'unrecognized'
    | 'aborted'
    | 'ui-action';
  message: string;
  plan?: AgentPlan;
  /** Capability names extracted from plan.steps, or an empty list. */
  capabilities: string[];
  /** Receipts produced by the executor, if any. */
  receipts: Record<string, unknown>[];
  /** The replayable action template after context resolution, if any. */
  template?: Record<string, unknown>;
  /** Snapshot of the session state after the turn, if available. */
  finalWorldState?: Record<string, unknown>;
  /** Candles returned to the user during the turn, if any. */
  returnedCandles?: Record<string, unknown>[];
  /** Latency measured by the caller. */
  durationMs?: number;
}

export interface AgentTurnContext {
  scenarioId: string;
  turnId: string;
  previousTemplate?: Record<string, unknown>;
  previousResults?: AgentTurnResult[];
  engineUrl: string;
}

export interface AgentAdapter {
  send(text: string, ctx: AgentTurnContext): Promise<AgentTurnResult>;
  close?(): Promise<void>;
}
