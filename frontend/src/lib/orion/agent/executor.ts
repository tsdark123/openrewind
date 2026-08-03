// =============================================================================
// Agent plan executor — sequential, cancellation-aware, receipt-generating.
//
// Each plan has an id. A step with `dependsOn` runs only if its dependencies
// succeeded. A required step failure stops execution. Optional step failures
// are recorded and the plan continues unless a subsequent required step depends
// on them.
//
// Every step produces exactly one ExecutionReceipt. The final result always
// includes the latest WorldState.
// =============================================================================

import type {
  AgentPlan,
  AgentContext,
  CancellationToken,
  ExecutionReceipt,
  AgentExecutionResult,
} from './types';
import { isRequiredStep } from './types';
import { getCapability } from './capabilities';
import { failureReceipt } from './receipts';
import { buildWorldState } from '../worldState';
import { agentTrace } from './config';

function validatePlan(plan: AgentPlan): { ok: true } | { ok: false; error: string } {
  if (!plan.id) return { ok: false, error: 'Plan has no id.' };
  if (!plan.steps) return { ok: false, error: 'Plan has no steps array.' };
  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id) return { ok: false, error: 'Step has no id.' };
    if (!step.capability) return { ok: false, error: `Step ${step.id} has no capability.` };
    if (stepIds.has(step.id)) return { ok: false, error: `Duplicate step id ${step.id}.` };
    stepIds.add(step.id);
  }
  for (const step of plan.steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) return { ok: false, error: `Step ${step.id} depends on unknown step ${dep}.` };
      }
    }
  }
  return { ok: true };
}

function requiredStepStatus(plan: AgentPlan, stepId: string): boolean {
  const step = plan.steps.find((s) => s.id === stepId);
  return step ? isRequiredStep(step) : true;
}

export async function executeAgentPlan(
  plan: AgentPlan,
  ctx: AgentContext,
  token?: CancellationToken
): Promise<AgentExecutionResult> {
  const validation = validatePlan(plan);
  if (!validation.ok) {
    return {
      ok: false,
      planId: plan.id ?? 'invalid-plan',
      receipts: [],
      errorCode: 'INVALID_PLAN',
      errorMessage: validation.error,
      finalWorldState: buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog),
    };
  }

  agentTrace('execute start', plan.id, plan.summary, plan.steps.length);
  const receiptsById = new Map<string, ExecutionReceipt>();
  const receipts: ExecutionReceipt[] = [];

  for (const step of plan.steps) {
    // Cancellation check before the step.
    if (token?.cancelled) {
      const receipt = failureReceipt(plan.id, step, 'CANCELLED', 'Plan was cancelled.');
      receipts.push(receipt);
      receiptsById.set(step.id, receipt);
      agentTrace('step cancelled', step.id);
      continue;
    }

    // Dependency check. Any failed dependency prevents this step from running,
    // regardless of whether the dependency itself was optional.
    const depFailure = step.dependsOn?.find((depId) => {
      const depReceipt = receiptsById.get(depId);
      return !depReceipt || !depReceipt.success;
    });

    if (depFailure) {
      const depReceipt = receiptsById.get(depFailure);
      const receipt = failureReceipt(
        plan.id,
        step,
        'DEPENDENCY_FAILED',
        `Skipped because dependency ${depFailure} failed: ${depReceipt?.message ?? 'unknown'}.`
      );
      receipts.push(receipt);
      receiptsById.set(step.id, receipt);
      agentTrace('step dependency failed', step.id, depFailure);
      if (isRequiredStep(step)) {
        return {
          ok: false,
          planId: plan.id,
          receipts,
          stoppedAtStepId: step.id,
          errorCode: 'DEPENDENCY_FAILED',
          errorMessage: `Required step ${step.id} could not run because ${depFailure} failed.`,
          finalWorldState: buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog),
        };
      }
      continue;
    }

    const cap = getCapability(step.capability);
    if (!cap) {
      const receipt = failureReceipt(plan.id, step, 'UNKNOWN_CAPABILITY', `Unknown capability ${step.capability}.`);
      receipts.push(receipt);
      receiptsById.set(step.id, receipt);
      agentTrace('unknown capability', step.capability);
      if (isRequiredStep(step)) {
        return {
          ok: false,
          planId: plan.id,
          receipts,
          stoppedAtStepId: step.id,
          errorCode: 'UNKNOWN_CAPABILITY',
          errorMessage: `Unknown capability ${step.capability}.`,
          finalWorldState: buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog),
        };
      }
      continue;
    }

    let receipt: ExecutionReceipt;
    try {
      receipt = await cap.execute(plan.id, step, ctx, token);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      receipt = failureReceipt(plan.id, step, 'INTERNAL_ERROR', `Capability threw: ${err}`);
      agentTrace('capability threw', step.id, err);
    }

    // Cancellation check after awaited operation.
    if (token?.cancelled && receipt.success) {
      receipt = failureReceipt(plan.id, step, 'CANCELLED', 'Plan was cancelled after this step completed.');
    }

    receipts.push(receipt);
    receiptsById.set(step.id, receipt);

    // Post-step log.
    agentTrace('step receipt', step.id, receipt.success, receipt.message);

    if (!receipt.success && isRequiredStep(step)) {
      return {
        ok: false,
        planId: plan.id,
        receipts,
        stoppedAtStepId: step.id,
        errorCode: receipt.errorCode ?? 'INTERNAL_ERROR',
        errorMessage: receipt.message,
        finalWorldState: buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog),
      };
    }

    // Refresh state after mutating capabilities so dependent steps see the new world.
    if (cap.kind === 'mutate') {
      const _ = buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog);
      agentTrace('world state refreshed after mutate', step.id);
      void _;
    }
  }

  const after = ctx.getState();
  const success = !receipts.some(
    (r) =>
      !r.success &&
      requiredStepStatus(plan, r.stepId)
  );

  const result: AgentExecutionResult = {
    ok: success,
    planId: plan.id,
    receipts,
    finalWorldState: buildWorldState(after, ctx.chartRef, ctx.performanceLog),
  };

  if (!success) {
    result.errorCode = 'PLAN_EXECUTION_FAILED';
    result.errorMessage = 'One or more required steps failed.';
  }

  agentTrace('execute end', plan.id, success, receipts.length);
  return result;
}
