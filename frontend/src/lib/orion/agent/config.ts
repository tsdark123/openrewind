/// <reference types="vite/client" />

// =============================================================================
// Agent runtime configuration.
//
// Diagnostics and detailed traces are gated behind the dev flag so production
// builds do not spam the console. Use this helper before any agent trace log.
// =============================================================================

export const ORION_AGENT_DEBUG =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env !== 'undefined' &&
  import.meta.env.DEV === true;

export function agentTrace(label: string, ...args: unknown[]): void {
  if (!ORION_AGENT_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`[agent-trace] ${label}`, ...args);
}
