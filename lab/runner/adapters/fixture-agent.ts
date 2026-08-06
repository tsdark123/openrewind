import * as fs from 'node:fs';
import type { AgentAdapter, AgentTurnContext, AgentTurnResult } from './agent-adapter.ts';

export interface FixtureAgentOptions {
  /** Path to a JSON file keyed by "scenarioId:turnId". */
  fixturePath?: string;
  /** Inline map of responses. Takes precedence over fixturePath. */
  responses?: Record<string, AgentTurnResult>;
}

/**
 * Agent adapter that replays explicit fixture responses.
 *
 * This is intended only for dry-run / lab-machinery validation. It does not
 * invoke Ollama or the engine, and it does not fabricate passing model outputs
 * for real regression seeds.
 */
export class FixtureAgentAdapter implements AgentAdapter {
  private responses: Record<string, AgentTurnResult> = {};

  constructor(opts: FixtureAgentOptions = {}) {
    if (opts.responses) {
      this.responses = opts.responses;
    } else if (opts.fixturePath) {
      const raw = fs.readFileSync(opts.fixturePath, 'utf8');
      this.responses = JSON.parse(raw);
    }
  }

  async send(_text: string, ctx: AgentTurnContext): Promise<AgentTurnResult> {
    const key = `${ctx.scenarioId}:${ctx.turnId}`;
    const result = this.responses[key];
    if (!result) {
      return {
        ok: true,
        route: 'unsupported',
        message: 'No fixture response defined for this turn.',
        capabilities: [],
        receipts: [],
      };
    }
    return result;
  }

  async close(): Promise<void> {
    // no-op
  }
}
