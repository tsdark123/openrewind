/**
 * Windows production adapter scaffold for the Orion Scenario Lab.
 *
 * This module is intentionally non-operational. It exists only to make the
 * required contract explicit and to give the Windows-local implementer a typed
 * skeleton. It compiles without importing any production module, so it cannot
 * accidentally run real Orion in the Cloud VM.
 *
 * To make it operational on Windows:
 *  1. Copy this file to a Windows-local location (outside the committed lab tree
 *     or in lab/adapters/windows-production-adapter.impl.ts that is gitignored).
 *  2. Replace the NOT_IMPLEMENTED stubs with real production imports and wiring.
 *  3. Pass the copy to run.ts with --adapter-module <path>.
 */

import type { AgentAdapter, AgentTurnContext, AgentTurnResult } from './agent-adapter.ts';
import type { EngineAdapter } from './engine-adapter.ts';

class NotImplementedAdapter implements AgentAdapter {
  async send(_text: string, _ctx: AgentTurnContext): Promise<AgentTurnResult> {
    throw new Error(
      '[Windows production adapter] NOT_IMPLEMENTED: send() must be wired to ' +
        'OpenRewind production handleOrionMessage() in a Windows-local runtime. ' +
        'See lab/docs/WINDOWS_PRODUCTION_ADAPTER_HANDOFF.md.'
    );
  }

  async close(): Promise<void> {
    // no-op in scaffold
  }
}

class NotImplementedEngine implements EngineAdapter {
  private _url: string;

  constructor(url: string) {
    this._url = url;
  }

  async start(): Promise<void> {
    // Real implementation should verify the engine is healthy at this._url.
  }

  async stop(): Promise<void> {
    // Real implementation should not stop a process it did not start.
  }

  async fetchCandles(_opts: {
    symbol: string;
    date: string;
    timeframe: number;
  }): Promise<import('../../reference/types.ts').ReferenceCandle[]> {
    throw new Error(
      '[Windows production adapter] NOT_IMPLEMENTED: fetchCandles() must be ' +
        'wired to the OpenRewind engine /api/candles endpoint. ' +
        'See lab/docs/WINDOWS_PRODUCTION_ADAPTER_HANDOFF.md.'
    );
  }

  get url(): string {
    return this._url;
  }
}

export async function createProductionAgentAdapter(
  _engineUrl: string,
  _initialWorldState: unknown
): Promise<AgentAdapter> {
  throw new Error(
    '[Windows production adapter] NOT_IMPLEMENTED. ' +
      'Implement AgentContext + handleOrionMessage() wiring on Windows. ' +
      'See lab/docs/WINDOWS_PRODUCTION_ADAPTER_HANDOFF.md.'
  );
}

export async function createProductionEngineAdapter(
  engineUrl: string
): Promise<EngineAdapter> {
  // Returning the stub makes the contract explicit, but the first real call throws.
  return new NotImplementedEngine(engineUrl);
}

// Re-export the stub classes so the handoff document can reference them.
export { NotImplementedAdapter, NotImplementedEngine };
