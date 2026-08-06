import type { AgentAdapter, AgentTurnContext, AgentTurnResult } from './agent-adapter.ts';
import type { AgentPlan } from '../scenario-types.ts';

export interface ProductionAgentDeps {
  /** The real handleOrionMessage function from the production agent. */
  handleOrionMessage: (opts: {
    text: string;
    ctx: unknown;
    setupReady: boolean;
    signal?: AbortSignal;
  }) => Promise<{
    ok: boolean;
    message: string;
    wasChat: boolean;
    plan?: AgentPlan;
    result?: {
      ok: boolean;
      receipts: Record<string, unknown>[];
      finalWorldState?: unknown;
      errorCode?: string;
      errorMessage?: string;
    };
    route: string;
  }>;
  /** Builds an AgentContext for the production pipeline. */
  buildAgentContext: (turnCtx: AgentTurnContext, executionLog: unknown) => unknown;
  /** Creates a fresh production execution-context store. */
  createExecutionContext: () => unknown;
}

/**
 * Adapter that runs the real Orion handleOrionMessage pipeline.
 *
 * This file does not import production modules directly; the caller injects
 * the production functions at runtime. This keeps the lab package
 * type-checkable without requiring React / Tauri / browser globals in the
 * runner test environment.
 */
export class ProductionAgentAdapter implements AgentAdapter {
  private executionLog: unknown;

  constructor(private deps: ProductionAgentDeps) {
    this.executionLog = deps.createExecutionContext();
  }

  async send(text: string, ctx: AgentTurnContext): Promise<AgentTurnResult> {
    const agentCtx = this.deps.buildAgentContext(ctx, this.executionLog);
    const result = await this.deps.handleOrionMessage({
      text,
      ctx: agentCtx,
      setupReady: true,
    });

    const capabilities = result.plan?.steps.map((s) => s.capability) ?? [];
    const receipts = (result.result?.receipts as Record<string, unknown>[]) ?? [];

    return {
      ok: result.ok,
      route: result.route as AgentTurnResult['route'],
      message: result.message,
      plan: result.plan,
      capabilities,
      receipts,
      finalWorldState: result.result?.finalWorldState as Record<string, unknown> | undefined,
    };
  }

  async close(): Promise<void> {
    // no-op
  }
}
