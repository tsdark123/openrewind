// =============================================================================
// Receipt builders — small, type-safe helpers so every capability returns the
// same ExecutionReceipt shape without copy/pasting object literals.
// =============================================================================

import type { AgentStep, ExecutionReceipt, StateChange, AgentErrorCode } from './types';

export function successReceipt<T = unknown>(
  planId: string,
  step: AgentStep,
  message: string,
  data?: T,
  stateChanges?: StateChange[]
): ExecutionReceipt<T> {
  return {
    planId,
    stepId: step.id,
    capability: step.capability,
    success: true,
    message,
    data,
    stateChanges,
    finalizedAt: Date.now(),
  };
}

export function failureReceipt(
  planId: string,
  step: AgentStep,
  errorCode: AgentErrorCode,
  message: string,
  data?: Record<string, unknown>
): ExecutionReceipt<Record<string, unknown>> {
  return {
    planId,
    stepId: step.id,
    capability: step.capability,
    success: false,
    errorCode,
    message,
    data,
    finalizedAt: Date.now(),
  };
}
