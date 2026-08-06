/**
 * Map a production OrchestratorResult into the lab's AgentTurnResult.
 */

import type { AgentTurnResult } from '../agent-adapter';
import type { LabChartHandle, AppState, PerformanceLog } from './types';

function normalizeDate(state: AppState): Record<string, unknown> | undefined {
  if (!state.replayDate) return undefined;
  return { kind: 'absolute', value: state.replayDate };
}

function dateParts(date: string): { year?: number; month?: number; day?: number } | undefined {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
  };
}

function enrichTemplate(
  template: Record<string, unknown> | undefined,
  state: AppState,
  plan?: AgentTurnResult['plan'],
): Record<string, unknown> | undefined {
  if (!template) return undefined;
  if (template.kind !== 'chart_action') return template;

  const enriched: Record<string, unknown> = { ...template };
  if (enriched.symbol === undefined) {
    enriched.symbol = state.symbol;
  }
  if (enriched.date === undefined && state.replayDate) {
    enriched.date = normalizeDate(state);
  }
  if (enriched.timeframeMinutes === undefined && state.timeframe !== undefined) {
    enriched.timeframeMinutes = state.timeframe;
  }

  const analysisRequests = enriched.analysisRequests;
  if (Array.isArray(analysisRequests) && plan?.steps) {
    enriched.analysisRequests = analysisRequests.map((req, idx) => {
      if (!req || typeof req !== 'object') return req;
      const request = req as Record<string, unknown>;
      if (request.window !== undefined) return request;
      const step = plan.steps[idx];
      if (step?.args?.window && typeof step.args.window === 'object') {
        return { ...request, window: step.args.window };
      }
      return request;
    });
  }

  return enriched;
}

function findPlanStep(
  plan: AgentTurnResult['plan'] | undefined,
  stepId: string | undefined,
) {
  if (!plan || !Array.isArray(plan.steps) || !stepId) return undefined;
  return plan.steps.find((s) => (s as { id?: string }).id === stepId || (s as { stepId?: string }).stepId === stepId);
}

function enrichReceipts(
  receipts: Record<string, unknown>[],
  state: AppState,
  plan?: AgentTurnResult['plan'],
): Record<string, unknown>[] {
  return receipts.map((r) => {
    const capability = String(r.capability ?? '');
    const data = typeof r.data === 'object' && r.data !== null ? (r.data as Record<string, unknown>) : {};

    if (capability === 'playback.seek_to_time' && data.cursor === undefined) {
      return { ...r, data: { ...data, cursor: state.cursor } };
    }

    if (capability === 'playback.seek_relative') {
      const enriched = { ...data };
      if (enriched.cursor === undefined) {
        enriched.cursor = state.cursor;
      }
      if (enriched.minutes === undefined) {
        const step = findPlanStep(plan, String(r.stepId ?? ''));
        const stepMinutes = step && typeof step.args === 'object' ? (step.args as { minutes?: number }).minutes : undefined;
        if (typeof stepMinutes === 'number') {
          enriched.minutes = stepMinutes;
        }
      }
      return { ...r, data: enriched };
    }

    if (capability === 'session.switch_symbol') {
      const enriched: Record<string, unknown> = { ...data, sessionActive: state.sessionActive };
      const date = typeof enriched.date === 'string' ? enriched.date : state.replayDate;
      const parts = date ? dateParts(date) : undefined;
      if (parts) {
        enriched.year = parts.year;
        enriched.month = parts.month;
        enriched.day = parts.day;
      }
      return { ...r, data: enriched };
    }

    if (capability === 'session.resolve_trading_date') {
      const enriched: Record<string, unknown> = { ...data };
      const date = typeof enriched.date === 'string' ? enriched.date : (typeof enriched.requestedDate === 'string' ? enriched.requestedDate : undefined);
      const parts = date ? dateParts(date) : undefined;
      if (parts) {
        enriched.year = parts.year;
        enriched.month = parts.month;
        enriched.day = parts.day;
      }
      return { ...r, data: enriched };
    }

    if (capability.startsWith('analysis.')) {
      const enriched: Record<string, unknown> = { ...data };
      const date = state.replayDate;
      const parts = date ? dateParts(date) : undefined;
      if (parts) {
        enriched.date = date;
        enriched.year = parts.year;
        enriched.month = parts.month;
        enriched.day = parts.day;
      }
      return { ...r, data: enriched };
    }

    return r;
  });
}

function flattenWorldState(world: Record<string, unknown>): Record<string, unknown> {
  const { session, ...rest } = world;
  if (session && typeof session === 'object') {
    return { ...rest, ...(session as Record<string, unknown>) };
  }
  return rest;
}

export function mapOrchestratorResultToTurnResult(
  outcome: Record<string, unknown>,
  state: AppState,
  chartHandle: LabChartHandle,
  performanceLog: PerformanceLog,
  executionLog: Record<string, unknown>,
  buildWorldState: (
    state: AppState,
    chartRef: { current: Record<string, unknown> | null },
    performanceLog: PerformanceLog,
  ) => Record<string, unknown>,
  durationMs: number,
): AgentTurnResult {
  const plan = (outcome.plan as AgentTurnResult['plan']) ?? undefined;
  const planSteps = plan?.steps as Array<{ capability: string }> | undefined;
  const capabilities = planSteps?.map((s) => s.capability) ?? [];
  const result = (outcome.result as Record<string, unknown> | undefined) ?? {};
  const rawReceipts = (result.receipts as Record<string, unknown>[] | undefined) ?? [];
  const message = typeof outcome.message === 'string' ? outcome.message : '';
  const route = typeof outcome.route === 'string' ? outcome.route : 'error';

  const world = buildWorldState(state, { current: chartHandle as unknown as Record<string, unknown> }, performanceLog);
  const finalWorldState = flattenWorldState(world as Record<string, unknown>);

  const latest = (executionLog as { latestSuccessfulAction?: () => { template?: Record<string, unknown> } | undefined }).latestSuccessfulAction?.();
  const template = enrichTemplate(latest?.template ?? (outcome.template as Record<string, unknown> | undefined), state, plan);

  return {
    ok: outcome.ok === true,
    route: route as AgentTurnResult['route'],
    message,
    plan,
    capabilities,
    receipts: enrichReceipts(rawReceipts, state, plan),
    template,
    finalWorldState,
    durationMs,
  };
}
