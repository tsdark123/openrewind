import type { AppState, AppAction, PerformanceLog } from '../../../types';
import type { ChartHandle } from '../../../components/Chart';

// =============================================================================
// Orion Agent Interface V1 — shared types
//
// These types describe the structured plan/receipt protocol shared by the
// deterministic planner adapter and the LLM planner. Neither the executor
// nor the UI orchestrator lives here — this file is intentionally free of
// runtime dependencies so it can be imported anywhere (including tests).
//
// Design decisions:
//   - `capability` is a plain string namespaced by dot (e.g. `session.switch_symbol`).
//     Individual capabilities validate their own `args` shape at execution time.
//   - `AgentPlan.kind` records the semantic mode so the composer can pick the
//     right response style (chat vs. action vs. query).
//   - `ExecutionReceipt` always carries `success`, and on failure carries a
//     stable `errorCode` from `AgentErrorCode`.
//   - Cancellation is a plan-level concern: a plan has an `id`, and any
//     receipt or executor context carries the same id. An executor may drop
//     late-arriving receipts whose plan id is not the active one.
// =============================================================================

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

export type PlanKind = 'chat' | 'query' | 'action' | 'mixed';

/**
 * The canonical set of V1 capabilities. Each entry maps to exactly one
 * executor implementation in the capability registry. The list is a string
 * union — not an enum — so external code (LLM output, JSON transport) can
 * check membership at runtime with a plain `includes` call.
 */
export const V1_CAPABILITIES = [
  'system.get_world_state',
  'session.resolve_symbol',
  'session.switch_symbol',
  'session.switch_to_previous_symbol',
  'session.resolve_trading_date',
  'chart.set_timeframe',
  'playback.seek_relative',
  'playback.seek_to_time',
  'playback.play_until',
  'playback.pause',
  'chart.get_current_candle',
  'chart.get_candle_at_time',
] as const;

export type V1Capability = (typeof V1_CAPABILITIES)[number];

export function isV1Capability(value: unknown): value is V1Capability {
  return typeof value === 'string' && (V1_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * One step in an agent plan.
 *
 * `dependsOn` (optional) lets a plan express that a step must not run unless
 * every listed prior step succeeded. When omitted the executor treats every
 * step as depending on the immediately-preceding required step, which is the
 * common case for chart-control sequences.
 */
export interface AgentStep {
  /** Stable, plan-local id — e.g. "step-1". Used to correlate receipts. */
  id: string;
  /** Capability name; must be a V1Capability at execution time. */
  capability: string;
  /** Free-form arguments; validated per-capability by the executor. */
  args: Record<string, unknown>;
  /**
   * If false, the executor may continue subsequent steps even when this
   * step fails. Defaults to true. Read-only queries (e.g. get_current_candle)
   * often set this to false so a probe doesn't abort the whole plan.
   */
  required?: boolean;
  /** Step ids this step depends on. */
  dependsOn?: string[];
  /** Human-readable rationale — used by the composer, not by execution. */
  rationale?: string;
}

export interface AgentPlan {
  /** Unique plan identifier — used for cancellation and receipt correlation. */
  id: string;
  kind: PlanKind;
  /** One-line summary of the plan's intent. */
  summary: string;
  /** Ordered list of steps. Empty for pure chat plans. */
  steps: AgentStep[];
  /** Optional conversational text the composer may include on success. */
  chat?: string;
  /** Freeform metadata (e.g. planner source). */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Error codes (stable)
// ---------------------------------------------------------------------------

export type AgentErrorCode =
  | 'UNKNOWN_CAPABILITY'
  | 'INVALID_ARGUMENTS'
  | 'PRECONDITION_FAILED'
  | 'NO_DATA_FOR_DATE'
  | 'SYMBOL_UNAVAILABLE'
  | 'SYMBOL_AMBIGUOUS'
  | 'ENGINE_UNREACHABLE'
  | 'ENGINE_ERROR'
  | 'ACKNOWLEDGMENT_TIMEOUT'
  | 'DEPENDENCY_FAILED'
  | 'CANCELLED'
  | 'INVALID_PLAN'
  | 'PLAN_EXECUTION_FAILED'
  | 'INTERNAL_ERROR';

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * A single-key state transition captured from a step. Only fields that
 * actually changed should be reported — the composer relies on presence,
 * not value equality, to decide what to mention.
 */
export interface StateChange<T = unknown> {
  key: string;
  before: T;
  after: T;
}

export interface ExecutionReceiptSuccess<TData = unknown> {
  planId: string;
  stepId: string;
  capability: string;
  success: true;
  /** Short human-readable summary of what happened. */
  message: string;
  /** Structured payload the composer or a downstream step may consume. */
  data?: TData;
  /** Committed state changes triggered by this step. */
  stateChanges?: StateChange[];
  /** Monotonic timestamp (ms) when the receipt was finalized. */
  finalizedAt: number;
}

export interface ExecutionReceiptFailure {
  planId: string;
  stepId: string;
  capability: string;
  success: false;
  errorCode: AgentErrorCode;
  message: string;
  /** Optional structured hint (e.g. nearest available date). */
  data?: Record<string, unknown>;
  finalizedAt: number;
}

export type ExecutionReceipt<TData = unknown> =
  | ExecutionReceiptSuccess<TData>
  | ExecutionReceiptFailure;

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

export interface AgentExecutionResult {
  planId: string;
  /** True when every required step succeeded. */
  ok: boolean;
  /** All step receipts in the order they were finalized. */
  receipts: ExecutionReceipt[];
  /**
   * The step id at which the executor stopped, if any (either a required
   * step failed, or the plan was cancelled).
   */
  stoppedAtStepId?: string;
  /**
   * Snapshot of `WorldState`-shaped data after the plan finished, if the
   * executor was able to refresh it. Kept as `unknown` here to avoid a
   * circular import with `worldState.ts`.
   */
  finalWorldState?: unknown;
  /** Plan-level error when the plan itself was rejected before executing. */
  errorCode?: AgentErrorCode;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export interface CancellationToken {
  /** True once a caller has requested cancellation. */
  readonly cancelled: boolean;
  /** Reason string, if the token has been cancelled. */
  readonly reason?: string;
}

export interface CancellationSource extends CancellationToken {
  cancel: (reason?: string) => void;
}

export function createCancellationSource(): CancellationSource {
  let cancelled = false;
  let reason: string | undefined;
  return {
    get cancelled() { return cancelled; },
    get reason() { return reason; },
    cancel(r?: string) {
      cancelled = true;
      reason = r;
    },
  };
}

// ---------------------------------------------------------------------------
// Capability descriptor (registry entry)
// ---------------------------------------------------------------------------

export type CapabilityKind = 'read' | 'mutate';

/**
 * Metadata-only descriptor for a capability. The executor holds the
 * implementation function separately so this shape can be serialized and
 * given to the LLM as a catalog.
 */
export interface CapabilityDescriptor {
  name: string;
  kind: CapabilityKind;
  description: string;
  /** Compact schema hint for the LLM (JSON-Schema-style). */
  argSchema?: Record<string, unknown>;
  /** Human-readable preconditions the model can reason about. */
  preconditions?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeStepId(index: number, prefix = 'step'): string {
  return `${prefix}-${index + 1}`;
}

export function isRequiredStep(step: AgentStep): boolean {
  return step.required !== false;
}

export function receiptIsSuccess<T>(
  r: ExecutionReceipt<T>
): r is ExecutionReceiptSuccess<T> {
  return r.success;
}

// ---------------------------------------------------------------------------
// Runtime context passed to the executor and individual capabilities.
// ---------------------------------------------------------------------------

export interface AgentContext {
  /** Live state accessor; always reflects the latest committed state. */
  getState: () => AppState;
  /** Mutable ref to the chart imperative handle. */
  chartRef: { current: ChartHandle | null } | null;
  /** Persisted performance log for WorldState. */
  performanceLog: PerformanceLog;
  /** Engine REST base URL. */
  apiBase: string;
  /** Optional local data directory; omitted in managed mode. */
  dataDir?: string;
  /** List of currently available tickers. */
  availableTickers: string[];
  /** WebSocket command sender. */
  send: (payload: Record<string, unknown>) => void;
  /** React reducer dispatch. */
  dispatch: (action: AppAction) => void;
  /**
   * App-level symbol switch handler (App.tsx `handleSymbolChange`).
   * The executor must not create its own session-start POST.
   */
  onSwitchSymbol: (symbol: string, date?: string) => void | Promise<void>;
  /** Optional callback for progress / side messages during a plan. */
  onMessage?: (text: string) => void;
  /** Previous orchestrator execution result, if any, so chat can answer truthfully. */
  lastResult?: AgentExecutionResult;
}
