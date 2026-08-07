// =============================================================================
// runtimeValidationOrchestrator.ts — pure, I/O-free orchestration for
// Chapter 2B runtime validation (Slice 1).
//
// This module decides which certified candidate to test, coordinates one
// OpenRewind model-work lease, accepts only complete identity-bound evidence,
// and repeatedly calls the signed-off `selectCertifiedModel` until a candidate
// is positively selected or the run terminates.
//
// The orchestrator, not the validator, owns the `RuntimeValidationEvidence`
// contract. The validator returns a raw, candidate-scoped observation; the
// orchestrator converts it into evidence using trusted run and profile fields.
//
// Slice 1 is intentionally incomplete: it does not contact Ollama, Tauri, the
// network, timers or browser APIs. The actual model-scoped validator, residency
// inspection, streaming and percentile computation are Slice 2 concerns.
//
// Lease contract (future integration):
//   The same lease provider must guard runtime validation, `warmOrionAgent`,
//   `orionChat` and all other OpenRewind-controlled startup model work. It
//   cannot exclude external Ollama clients that already hold the model.
// =============================================================================

import type { CertifiedModelProfile, CertificationIdentity } from './certifiedModels';
import type {
  CandidateDisposition,
  CertifiedModelSelectorInput,
  ModelSelectionResult,
  RuntimeValidationEvidence,
} from './certifiedModelSelector';
import type { HardwareProfile } from './hardwareProfile';

// ---------------------------------------------------------------------------
// Approved warm smoothness policy
// ---------------------------------------------------------------------------

export interface SmoothnessPolicy {
  readonly warmSampleCount: number;
  readonly maxP95TrueTTFTMs: number;
  readonly maxP95WallClockMs: number;
}

export const APPROVED_WARM_SMOOTHNESS_POLICY = Object.freeze({
  warmSampleCount: 5,
  maxP95TrueTTFTMs: 400,
  maxP95WallClockMs: 1800,
} as const) satisfies SmoothnessPolicy;

export type ApprovedSmoothnessPolicy = typeof APPROVED_WARM_SMOOTHNESS_POLICY;

export function isApprovedSmoothnessPolicy(policy: SmoothnessPolicy): policy is ApprovedSmoothnessPolicy {
  return (
    policy.warmSampleCount === 5 &&
    policy.maxP95TrueTTFTMs === 400 &&
    policy.maxP95WallClockMs === 1800
  );
}

// ---------------------------------------------------------------------------
// Run input
// ---------------------------------------------------------------------------

export interface RuntimeValidationRunInput {
  /** Deterministic, caller-supplied identifier. No time or randomness. */
  readonly runId: string;
  /** Snapshot of the certified-model registry at the start of the run. */
  readonly registry: readonly CertifiedModelProfile[];
  /** Snapshot of the local hardware profile. */
  readonly hardwareProfile: HardwareProfile;
  /** Target runtime for selector compatibility (e.g. 'ollama'). */
  readonly runtime: string;
  /** Target operating system for selector compatibility (e.g. 'win32'). */
  readonly platform: string;
  /** Approved warm smoothness budget for this run. */
  readonly smoothnessPolicy: SmoothnessPolicy;
  /** External abort signal. */
  readonly signal: AbortSignal;
  /** Optional progress observer. Emissions are best-effort and non-mutating. */
  readonly onProgress?: (event: RuntimeValidationProgressEvent) => void;
}

// ---------------------------------------------------------------------------
// Candidate input for the validator
// ---------------------------------------------------------------------------

export interface RuntimeValidationCandidateInput {
  readonly runId: string;
  readonly profile: CertifiedModelProfile;
  readonly certificationIdentity: CertificationIdentity;
  readonly hardwareProfile: HardwareProfile;
  readonly runtime: string;
  readonly platform: string;
  readonly smoothnessPolicy: ApprovedSmoothnessPolicy;
  readonly signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Model-work lease
// ---------------------------------------------------------------------------

/** Opaque lease. The only operation is release. */
export interface ModelWorkLease {
  release(): void;
}

export interface LeaseAcquired {
  readonly kind: 'acquired';
  readonly lease: ModelWorkLease;
}

export interface LeaseBusy {
  readonly kind: 'busy';
  readonly reason: string;
}

export interface LeaseInconclusive {
  readonly kind: 'inconclusive';
  readonly reason: string;
}

export type LeaseAcquisition = LeaseAcquired | LeaseBusy | LeaseInconclusive;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface RuntimeValidationDiagnostics {
  readonly modelId: string;
  readonly ollamaTag: string;
  readonly runId: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly stages?: readonly string[];
  readonly error?: string;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Raw candidate observation from the validator
// ---------------------------------------------------------------------------

/**
 * A complete candidate observation. It must not carry selector-owned
 * identity/context fields (runtime, platform, comparisonGroupId,
 * certificationVersion, benchmarkSuiteVersion, controlledContextSize,
 * thinking, keepAlive). Those are added by the orchestrator when constructing
 * `RuntimeValidationEvidence`.
 */
export interface RuntimeValidationObservation {
  readonly modelId: string;
  readonly ollamaTag: string;
  readonly certificationIdentity: CertificationIdentity;
  readonly loadSuccess: boolean;
  readonly loadFailureReason?: string;
  readonly oom: boolean;
  readonly cpuOffload: boolean;
  readonly evicted: boolean;
  readonly smoothnessOk: boolean;
  readonly measuredWholeAppPeakMemoryMiB?: number;
  readonly avgTokensPerSecond?: number;
  readonly p95WallClockMs?: number;
  readonly p95TrueTTFTMs?: number;
}

// ---------------------------------------------------------------------------
// Attempts returned by the validator
// ---------------------------------------------------------------------------

export type ActionRequiredReason =
  | 'not-installed'
  | 'wrong-digest'
  | 'certified-digest-unavailable'
  | 'unsupported-ollama-version';

export type InconclusiveReason =
  | 'ambiguous-engine-failure'
  | 'unavailable-residency-observation'
  | 'malformed-residency-observation'
  | 'resource-conflict'
  | 'incomplete-observation'
  | 'validator-exception';

export type CancellationReason = 'aborted' | 'stale';

export interface RuntimeValidationAttemptValidated {
  readonly kind: 'validated';
  readonly observation: RuntimeValidationObservation;
  readonly diagnostics?: RuntimeValidationDiagnostics;
}

export interface RuntimeValidationAttemptFailed {
  readonly kind: 'failed';
  readonly observation: RuntimeValidationObservation;
  readonly diagnostics?: RuntimeValidationDiagnostics;
}

export interface RuntimeValidationAttemptActionRequired {
  readonly kind: 'action-required';
  readonly reason: ActionRequiredReason;
  readonly modelId: string;
  readonly ollamaTag: string;
  readonly diagnostics?: RuntimeValidationDiagnostics;
}

export interface RuntimeValidationAttemptInconclusive {
  readonly kind: 'inconclusive';
  readonly reason: InconclusiveReason;
  readonly modelId: string;
  readonly ollamaTag: string;
  readonly detail?: string;
  readonly diagnostics?: RuntimeValidationDiagnostics;
}

export interface RuntimeValidationAttemptCancelled {
  readonly kind: 'cancelled';
  readonly reason: CancellationReason;
  readonly modelId: string;
  readonly ollamaTag: string;
  readonly diagnostics?: RuntimeValidationDiagnostics;
}

export type RuntimeValidationAttempt =
  | RuntimeValidationAttemptValidated
  | RuntimeValidationAttemptFailed
  | RuntimeValidationAttemptActionRequired
  | RuntimeValidationAttemptInconclusive
  | RuntimeValidationAttemptCancelled;

// ---------------------------------------------------------------------------
// Validator dependency
// ---------------------------------------------------------------------------

export type ValidateCandidate = (
  candidateInput: RuntimeValidationCandidateInput,
  isCurrent: () => boolean
) => Promise<RuntimeValidationAttempt>;

// ---------------------------------------------------------------------------
// Orchestrator dependencies
// ---------------------------------------------------------------------------

export interface RuntimeValidationDependencies {
  /** The signed-off pure selector. */
  readonly selectCertifiedModel: (input: CertifiedModelSelectorInput) => ModelSelectionResult;
  /** Future Slice 2 validator. In Slice 1 this is fakeable. */
  readonly validateCandidate: ValidateCandidate;
  /** Yields a typed lease acquisition. No real implementation in Slice 1. */
  readonly acquireLease: () => Promise<LeaseAcquisition>;
  /** Returns true only while this run is still the current one. */
  readonly isCurrent: () => boolean;
}

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

export type RuntimeValidationProgressEvent =
  | { readonly kind: 'run-started'; readonly runId: string }
  | { readonly kind: 'lock-acquired'; readonly runId: string }
  | {
      readonly kind: 'validation-order-resolved';
      readonly runId: string;
      readonly validationOrder: readonly string[];
      readonly remainingValidationOrder: readonly string[];
    }
  | { readonly kind: 'candidate-started'; readonly runId: string; readonly modelId: string }
  | {
      readonly kind: 'action-required';
      readonly runId: string;
      readonly modelId: string;
      readonly reason: ActionRequiredReason;
    }
  | {
      readonly kind: 'candidate-completed';
      readonly runId: string;
      readonly modelId: string;
      readonly attemptKind: 'validated' | 'failed';
    }
  | {
      readonly kind: 'candidate-rejected-by-selector';
      readonly runId: string;
      readonly modelId: string;
      readonly resultKind: string;
    }
  | { readonly kind: 'candidate-selected'; readonly runId: string; readonly modelId: string }
  | {
      readonly kind: 'inconclusive';
      readonly runId: string;
      readonly modelId?: string;
      readonly reason: InconclusiveReason;
      readonly detail?: string;
    }
  | {
      readonly kind: 'cancelled-stale';
      readonly runId: string;
      readonly modelId?: string;
      readonly reason: CancellationReason;
    }
  | {
      readonly kind: 'run-completed';
      readonly runId: string;
      readonly resultKind: string;
      readonly modelId?: string;
    };

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type ActionCategory =
  | 'install-consent'
  | 're-pull-consent'
  | 'update-ollama'
  | 'registry-identity-missing';

export type RuntimeValidationOrchestratorResult =
  | {
      readonly kind: 'selected';
      readonly runId: string;
      readonly selected: CertifiedModelProfile;
      readonly fallbackOrder: readonly CertifiedModelProfile[];
      readonly validationOrder: readonly CertifiedModelProfile[];
      readonly remainingValidationOrder: readonly CertifiedModelProfile[];
      readonly dispositions: readonly CandidateDisposition[];
      readonly reason: string;
    }
  | {
      readonly kind: 'runtime-validation-failed';
      readonly runId: string;
      readonly dispositions: readonly CandidateDisposition[];
      readonly reason: string;
      readonly validationOrder: readonly CertifiedModelProfile[];
      readonly remainingValidationOrder: readonly CertifiedModelProfile[];
    }
  | {
      readonly kind: 'no-certified-profiles' | 'no-compatible-certified' | 'invalid-input';
      readonly runId: string;
      readonly reason: string;
      readonly issues?: readonly string[];
      readonly dispositions?: readonly CandidateDisposition[];
    }
  | {
      readonly kind: 'action-required';
      readonly runId: string;
      readonly modelId: string;
      readonly ollamaTag: string;
      readonly reason: ActionRequiredReason;
      readonly action: ActionCategory;
      readonly validationOrder?: readonly CertifiedModelProfile[];
      readonly remainingValidationOrder?: readonly CertifiedModelProfile[];
    }
  | {
      readonly kind: 'inconclusive';
      readonly runId: string;
      readonly modelId: string;
      readonly ollamaTag: string;
      readonly reason: InconclusiveReason;
      readonly detail?: string;
      readonly validationOrder?: readonly CertifiedModelProfile[];
      readonly remainingValidationOrder?: readonly CertifiedModelProfile[];
    }
  | {
      readonly kind: 'cancelled-stale';
      readonly runId: string;
      readonly reason: CancellationReason;
      readonly modelId?: string;
      readonly ollamaTag?: string;
      readonly validationOrder?: readonly CertifiedModelProfile[];
      readonly remainingValidationOrder?: readonly CertifiedModelProfile[];
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapActionRequiredReason(reason: ActionRequiredReason): ActionCategory {
  switch (reason) {
    case 'not-installed':
      return 'install-consent';
    case 'wrong-digest':
      return 're-pull-consent';
    case 'certified-digest-unavailable':
      return 'registry-identity-missing';
    case 'unsupported-ollama-version':
      return 'update-ollama';
  }
}

function isNonBlankString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isNonNegativeFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isOptionalNonBlankString(v: unknown): boolean {
  return v === undefined || isNonBlankString(v);
}

function isOptionalNonNegativeFiniteNumber(v: unknown): boolean {
  return v === undefined || isNonNegativeFiniteNumber(v);
}

function makeResultContext(
  validationOrder: readonly CertifiedModelProfile[],
  evidenceById: Readonly<Record<string, RuntimeValidationEvidence>>,
  selectedIndex: number
): { validationOrder: readonly CertifiedModelProfile[]; remainingValidationOrder: readonly CertifiedModelProfile[] } {
  const remaining = validationOrder
    .slice(selectedIndex + 1)
    .filter((p) => !Object.prototype.hasOwnProperty.call(evidenceById, p.modelId));
  return { validationOrder, remainingValidationOrder: remaining };
}

function makeRemainingContext(
  validationOrder: readonly CertifiedModelProfile[],
  evidenceById: Readonly<Record<string, RuntimeValidationEvidence>>,
  stoppedIndex: number
): { validationOrder: readonly CertifiedModelProfile[]; remainingValidationOrder: readonly CertifiedModelProfile[] } {
  const remaining = validationOrder
    .slice(stoppedIndex)
    .filter((p) => !Object.prototype.hasOwnProperty.call(evidenceById, p.modelId));
  return { validationOrder, remainingValidationOrder: remaining };
}

function certificationIdentityMatches(a: CertificationIdentity, b: CertificationIdentity): boolean {
  return (
    a.modelTag === b.modelTag &&
    a.modelDigest === b.modelDigest &&
    a.ollamaVersion === b.ollamaVersion &&
    a.productionHead === b.productionHead &&
    a.certificationContractVersion === b.certificationContractVersion &&
    a.promptSuiteVersion === b.promptSuiteVersion &&
    a.scorerVersion === b.scorerVersion &&
    a.schemaVersion === b.schemaVersion
  );
}

/**
 * Convert a trusted, complete observation into the evidence the signed-off
 * selector expects. Selector-owned fields come from the run input and the
 * certified profile, never from the validator's observation.
 */
function toRuntimeValidationEvidence(
  input: RuntimeValidationRunInput,
  profile: CertifiedModelProfile,
  observation: RuntimeValidationObservation
): RuntimeValidationEvidence {
  return {
    modelId: profile.modelId,
    ollamaTag: profile.ollamaTag,
    certificationVersion: profile.certificationVersion,
    benchmarkSuiteVersion: profile.benchmarkSuiteVersion,
    controlledContextSize: profile.controlledContextSize,
    thinking: profile.thinking,
    keepAlive: profile.keepAlive,
    runtime: input.runtime,
    platform: input.platform,
    comparisonGroupId: input.runId,
    loadSuccess: observation.loadSuccess,
    loadFailureReason: observation.loadFailureReason,
    oom: observation.oom,
    cpuOffload: observation.cpuOffload,
    evicted: observation.evicted,
    measuredWholeAppPeakMemoryMiB: observation.measuredWholeAppPeakMemoryMiB,
    avgTokensPerSecond: observation.avgTokensPerSecond,
    p95WallClockMs: observation.p95WallClockMs,
    p95TrueTTFTMs: observation.p95TrueTTFTMs,
    smoothnessOk: observation.smoothnessOk,
  };
}

/**
 * Verify that a complete observation is internally consistent and matches the
 * candidate. Any failure is treated as inconclusive and the evidence must not
 * reach the selector.
 */
function verifyCompleteObservation(
  candidate: CertifiedModelProfile,
  attempt: RuntimeValidationAttemptValidated | RuntimeValidationAttemptFailed
): { ok: true } | { ok: false; reason: InconclusiveReason; detail: string } {
  const obs = attempt.observation;
  const detailPrefix = `${candidate.modelId}: `;

  if (obs.modelId !== candidate.modelId) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}observation modelId mismatch` };
  }
  if (obs.ollamaTag !== candidate.ollamaTag) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}observation ollamaTag mismatch` };
  }
  if (candidate.certified && candidate.certificationIdentity) {
    if (!certificationIdentityMatches(obs.certificationIdentity, candidate.certificationIdentity)) {
      return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}certification identity mismatch` };
    }
  }

  if (!isBoolean(obs.loadSuccess)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}loadSuccess is not a boolean` };
  }
  if (!isBoolean(obs.oom)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}oom is not a boolean` };
  }
  if (!isBoolean(obs.cpuOffload)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}cpuOffload is not a boolean` };
  }
  if (!isBoolean(obs.evicted)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}evicted is not a boolean` };
  }
  if (!isBoolean(obs.smoothnessOk)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}smoothnessOk is not a boolean` };
  }
  if (!isOptionalNonBlankString(obs.loadFailureReason)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}loadFailureReason must be a nonblank string when present` };
  }
  if (!isOptionalNonNegativeFiniteNumber(obs.measuredWholeAppPeakMemoryMiB)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}measuredWholeAppPeakMemoryMiB must be a nonnegative finite number when present` };
  }
  if (!isOptionalNonNegativeFiniteNumber(obs.avgTokensPerSecond)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}avgTokensPerSecond must be a nonnegative finite number when present` };
  }
  if (!isOptionalNonNegativeFiniteNumber(obs.p95WallClockMs)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}p95WallClockMs must be a nonnegative finite number when present` };
  }
  if (!isOptionalNonNegativeFiniteNumber(obs.p95TrueTTFTMs)) {
    return { ok: false, reason: 'incomplete-observation', detail: `${detailPrefix}p95TrueTTFTMs must be a nonnegative finite number when present` };
  }

  const isPositive = attempt.kind === 'validated';
  const positiveFlags = obs.loadSuccess && !obs.oom && !obs.evicted && obs.smoothnessOk;
  if (isPositive && !positiveFlags) {
    return {
      ok: false,
      reason: 'incomplete-observation',
      detail: `${detailPrefix}validated observation contains failed load, OOM, eviction or failed smoothness`,
    };
  }

  const negativeFlags = !obs.loadSuccess || obs.oom || obs.evicted || !obs.smoothnessOk;
  if (!isPositive && !negativeFlags) {
    return {
      ok: false,
      reason: 'incomplete-observation',
      detail: `${detailPrefix}failed observation contains all success flags without a negative cause`,
    };
  }

  return { ok: true };
}

function attemptIdentifiesCandidate(
  candidate: CertifiedModelProfile,
  attempt: RuntimeValidationAttempt
): boolean {
  if (attempt.kind === 'validated' || attempt.kind === 'failed') {
    return (
      attempt.observation.modelId === candidate.modelId &&
      attempt.observation.ollamaTag === candidate.ollamaTag
    );
  }
  return attempt.modelId === candidate.modelId && attempt.ollamaTag === candidate.ollamaTag;
}

function makeCandidateInput(
  input: RuntimeValidationRunInput,
  profile: CertifiedModelProfile
): RuntimeValidationCandidateInput {
  if (!profile.certificationIdentity) {
    throw new Error(`Certified profile ${profile.modelId} is missing certificationIdentity`);
  }
  return {
    runId: input.runId,
    profile,
    certificationIdentity: profile.certificationIdentity,
    hardwareProfile: input.hardwareProfile,
    runtime: input.runtime,
    platform: input.platform,
    smoothnessPolicy: input.smoothnessPolicy as ApprovedSmoothnessPolicy,
    signal: input.signal,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runRuntimeValidation(
  input: RuntimeValidationRunInput,
  deps: RuntimeValidationDependencies
): Promise<RuntimeValidationOrchestratorResult> {
  const { runId, signal } = input;
  const emit = input.onProgress ?? (() => undefined);

  function emitEvent(event: RuntimeValidationProgressEvent) {
    try {
      emit(event);
    } catch {
      // Progress observers are best-effort and must not fail the run.
    }
  }

  function isCancelled(): { cancelled: true; reason: CancellationReason } | { cancelled: false } {
    if (signal.aborted) return { cancelled: true, reason: 'aborted' };
    if (!deps.isCurrent()) return { cancelled: true, reason: 'stale' };
    return { cancelled: false };
  }

  emitEvent({ kind: 'run-started', runId });

  if (!isApprovedSmoothnessPolicy(input.smoothnessPolicy)) {
    const reason = 'smoothness policy does not match the approved warm budget';
    emitEvent({ kind: 'run-completed', runId, resultKind: 'invalid-input' });
    return {
      kind: 'invalid-input',
      runId,
      reason,
      issues: [
        'smoothnessPolicy must be the approved warm budget: warmSampleCount=5, maxP95TrueTTFTMs=400, maxP95WallClockMs=1800',
      ],
      dispositions: [],
    };
  }

  const cancelledBeforeLease = isCancelled();
  if (cancelledBeforeLease.cancelled) {
    emitEvent({ kind: 'cancelled-stale', runId, reason: cancelledBeforeLease.reason });
    emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale' });
    return { kind: 'cancelled-stale', runId, reason: cancelledBeforeLease.reason };
  }

  let leaseResult: LeaseAcquisition;
  try {
    leaseResult = await deps.acquireLease();
  } catch (e) {
    const reason = `lease acquisition failed: ${e instanceof Error ? e.message : String(e)}`;
    emitEvent({ kind: 'inconclusive', runId, reason: 'resource-conflict', detail: reason });
    emitEvent({ kind: 'run-completed', runId, resultKind: 'inconclusive' });
    return { kind: 'inconclusive', runId, modelId: '', ollamaTag: '', reason: 'resource-conflict', detail: reason };
  }

  if (leaseResult.kind === 'busy') {
    emitEvent({ kind: 'inconclusive', runId, reason: 'resource-conflict', detail: leaseResult.reason });
    emitEvent({ kind: 'run-completed', runId, resultKind: 'inconclusive' });
    return { kind: 'inconclusive', runId, modelId: '', ollamaTag: '', reason: 'resource-conflict', detail: leaseResult.reason };
  }

  if (leaseResult.kind === 'inconclusive') {
    emitEvent({ kind: 'inconclusive', runId, reason: 'resource-conflict', detail: leaseResult.reason });
    emitEvent({ kind: 'run-completed', runId, resultKind: 'inconclusive' });
    return { kind: 'inconclusive', runId, modelId: '', ollamaTag: '', reason: 'resource-conflict', detail: leaseResult.reason };
  }

  const activeLease = leaseResult.lease;
  let released = false;
  function releaseLease() {
    if (released) return;
    try {
      activeLease.release();
    } catch {
      // Release failures must not mask the real result.
    }
    released = true;
  }

  try {
    const afterLockCancel = isCancelled();
    if (afterLockCancel.cancelled) {
      emitEvent({ kind: 'cancelled-stale', runId, reason: afterLockCancel.reason });
      emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale' });
      return { kind: 'cancelled-stale', runId, reason: afterLockCancel.reason };
    }

    emitEvent({ kind: 'lock-acquired', runId });

    const initialResult = deps.selectCertifiedModel({
      registry: [...input.registry] as CertifiedModelProfile[],
      runtime: input.runtime,
      platform: input.platform,
      runtimeValidationEvidence: {},
    });

    switch (initialResult.kind) {
      case 'no-certified-profiles':
      case 'no-compatible-certified':
        emitEvent({ kind: 'run-completed', runId, resultKind: initialResult.kind });
        return { ...initialResult, runId };
      case 'runtime-validation-failed':
        emitEvent({ kind: 'run-completed', runId, resultKind: 'runtime-validation-failed' });
        return {
          kind: 'runtime-validation-failed',
          runId,
          dispositions: initialResult.dispositions,
          reason: initialResult.reason,
          validationOrder: [],
          remainingValidationOrder: [],
        };
      case 'invalid-input':
        emitEvent({ kind: 'run-completed', runId, resultKind: 'invalid-input' });
        return { ...initialResult, runId };
      case 'selected': {
        // A selected result with no evidence cannot be produced by the signed-off
        // selector, but we defensively treat it as terminal.
        const fullOrder = [initialResult.selected, ...initialResult.validationOrder];
        const ctx = makeResultContext(fullOrder, {}, 0);
        emitEvent({ kind: 'candidate-selected', runId, modelId: initialResult.selected.modelId });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'selected' });
        return {
          kind: 'selected',
          runId,
          selected: initialResult.selected,
          fallbackOrder: initialResult.fallbackOrder,
          ...ctx,
          dispositions: initialResult.dispositions,
          reason: initialResult.reason,
        };
      }
    }

    const validationOrder: readonly CertifiedModelProfile[] = initialResult.validationOrder;

    emitEvent({
      kind: 'validation-order-resolved',
      runId,
      validationOrder: validationOrder.map((p) => p.modelId),
      remainingValidationOrder: validationOrder.map((p) => p.modelId),
    });

    const evidenceById: Record<string, RuntimeValidationEvidence> = {};

    for (let i = 0; i < validationOrder.length; i++) {
      const candidate = validationOrder[i];

      const beforeCandidateCancel = isCancelled();
      if (beforeCandidateCancel.cancelled) {
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'cancelled-stale',
          runId,
          modelId: candidate.modelId,
          reason: beforeCandidateCancel.reason,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale', modelId: candidate.modelId });
        return {
          kind: 'cancelled-stale',
          runId,
          reason: beforeCandidateCancel.reason,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          ...ctx,
        };
      }

      emitEvent({ kind: 'candidate-started', runId, modelId: candidate.modelId });

      let attempt: RuntimeValidationAttempt;
      try {
        const candidateInput = makeCandidateInput(input, candidate);
        attempt = await deps.validateCandidate(candidateInput, deps.isCurrent);
      } catch (e) {
        const detail = `validator exception: ${e instanceof Error ? e.message : String(e)}`;
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          reason: 'validator-exception',
          detail,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'inconclusive', modelId: candidate.modelId });
        return {
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          reason: 'validator-exception',
          detail,
          ...ctx,
        };
      }

      const afterValidationCancel = isCancelled();
      if (afterValidationCancel.cancelled) {
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'cancelled-stale',
          runId,
          modelId: candidate.modelId,
          reason: afterValidationCancel.reason,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale', modelId: candidate.modelId });
        return {
          kind: 'cancelled-stale',
          runId,
          reason: afterValidationCancel.reason,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          ...ctx,
        };
      }

      if (!attemptIdentifiesCandidate(candidate, attempt)) {
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          reason: 'incomplete-observation',
          detail: `attempt identity does not match candidate ${candidate.modelId}`,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'inconclusive', modelId: candidate.modelId });
        return {
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          reason: 'incomplete-observation',
          detail: `attempt identity does not match candidate ${candidate.modelId}`,
          ...ctx,
        };
      }

      if (attempt.kind === 'action-required') {
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'action-required',
          runId,
          modelId: candidate.modelId,
          reason: attempt.reason,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'action-required', modelId: candidate.modelId });
        return {
          kind: 'action-required',
          runId,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          reason: attempt.reason,
          action: mapActionRequiredReason(attempt.reason),
          ...ctx,
        };
      }

      if (attempt.kind === 'inconclusive') {
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          reason: attempt.reason,
          detail: attempt.detail,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'inconclusive', modelId: candidate.modelId });
        return {
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          reason: attempt.reason,
          detail: attempt.detail,
          ...ctx,
        };
      }

      if (attempt.kind === 'cancelled') {
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'cancelled-stale',
          runId,
          modelId: candidate.modelId,
          reason: attempt.reason,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale', modelId: candidate.modelId });
        return {
          kind: 'cancelled-stale',
          runId,
          reason: attempt.reason,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          ...ctx,
        };
      }

      const preConversionCancel = isCancelled();
      if (preConversionCancel.cancelled) {
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'cancelled-stale',
          runId,
          modelId: candidate.modelId,
          reason: preConversionCancel.reason,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale', modelId: candidate.modelId });
        return {
          kind: 'cancelled-stale',
          runId,
          reason: preConversionCancel.reason,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          ...ctx,
        };
      }

      const verified = verifyCompleteObservation(candidate, attempt);
      if (!verified.ok) {
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          reason: verified.reason,
          detail: verified.detail,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'inconclusive', modelId: candidate.modelId });
        return {
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          reason: verified.reason,
          detail: verified.detail,
          ...ctx,
        };
      }

      const evidence = toRuntimeValidationEvidence(input, candidate, attempt.observation);

      const preEvidenceCancel = isCancelled();
      if (preEvidenceCancel.cancelled) {
        const ctx = makeRemainingContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'cancelled-stale',
          runId,
          modelId: candidate.modelId,
          reason: preEvidenceCancel.reason,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale', modelId: candidate.modelId });
        return {
          kind: 'cancelled-stale',
          runId,
          reason: preEvidenceCancel.reason,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          ...ctx,
        };
      }

      evidenceById[candidate.modelId] = evidence;

      emitEvent({
        kind: 'candidate-completed',
        runId,
        modelId: candidate.modelId,
        attemptKind: attempt.kind,
      });

      const preSelectorCancel = isCancelled();
      if (preSelectorCancel.cancelled) {
        const ctx = makeResultContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'cancelled-stale',
          runId,
          modelId: candidate.modelId,
          reason: preSelectorCancel.reason,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale', modelId: candidate.modelId });
        return {
          kind: 'cancelled-stale',
          runId,
          reason: preSelectorCancel.reason,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          ...ctx,
        };
      }

      const selectorResult = deps.selectCertifiedModel({
        registry: [...input.registry] as CertifiedModelProfile[],
        runtime: input.runtime,
        platform: input.platform,
        runtimeValidationEvidence: evidenceById,
      });

      const preReturnCancel = isCancelled();
      if (preReturnCancel.cancelled) {
        const ctx = makeResultContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'cancelled-stale',
          runId,
          modelId: candidate.modelId,
          reason: preReturnCancel.reason,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale', modelId: candidate.modelId });
        return {
          kind: 'cancelled-stale',
          runId,
          reason: preReturnCancel.reason,
          modelId: candidate.modelId,
          ollamaTag: candidate.ollamaTag,
          ...ctx,
        };
      }

      if (selectorResult.kind === 'selected') {
        const ctx = makeResultContext(validationOrder, evidenceById, i);
        emitEvent({
          kind: 'candidate-selected',
          runId,
          modelId: selectorResult.selected.modelId,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'selected', modelId: selectorResult.selected.modelId });
        return {
          kind: 'selected',
          runId,
          selected: selectorResult.selected,
          fallbackOrder: selectorResult.fallbackOrder,
          ...ctx,
          dispositions: selectorResult.dispositions,
          reason: selectorResult.reason,
        };
      }

      if (selectorResult.kind === 'runtime-validation-failed') {
        emitEvent({
          kind: 'candidate-rejected-by-selector',
          runId,
          modelId: candidate.modelId,
          resultKind: 'runtime-validation-failed',
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'runtime-validation-failed', modelId: candidate.modelId });
        return {
          kind: 'runtime-validation-failed',
          runId,
          dispositions: selectorResult.dispositions,
          reason: selectorResult.reason,
          validationOrder,
          remainingValidationOrder: [],
        };
      }

      if (selectorResult.kind === 'validation-required') {
        // Continue with the next candidate in the original order.
        continue;
      }

      // Terminal selector result with remaining evidence already added.
      emitEvent({ kind: 'run-completed', runId, resultKind: selectorResult.kind });
      return { ...selectorResult, runId };
    }

    // All candidates attempted without a positive selection.
    const preFinalCancel = isCancelled();
    if (preFinalCancel.cancelled) {
      emitEvent({
        kind: 'cancelled-stale',
        runId,
        reason: preFinalCancel.reason,
      });
      emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale' });
      return { kind: 'cancelled-stale', runId, reason: preFinalCancel.reason };
    }

    const finalResult = deps.selectCertifiedModel({
      registry: [...input.registry] as CertifiedModelProfile[],
      runtime: input.runtime,
      platform: input.platform,
      runtimeValidationEvidence: evidenceById,
    });

    const finalCancel = isCancelled();
    if (finalCancel.cancelled) {
      emitEvent({
        kind: 'cancelled-stale',
        runId,
        reason: finalCancel.reason,
      });
      emitEvent({ kind: 'run-completed', runId, resultKind: 'cancelled-stale' });
      return { kind: 'cancelled-stale', runId, reason: finalCancel.reason };
    }

    if (finalResult.kind === 'selected') {
      const ctx = makeResultContext(validationOrder, evidenceById, validationOrder.length - 1);
      emitEvent({
        kind: 'candidate-selected',
        runId,
        modelId: finalResult.selected.modelId,
      });
      emitEvent({ kind: 'run-completed', runId, resultKind: 'selected', modelId: finalResult.selected.modelId });
      return {
        kind: 'selected',
        runId,
        selected: finalResult.selected,
        fallbackOrder: finalResult.fallbackOrder,
        ...ctx,
        dispositions: finalResult.dispositions,
        reason: finalResult.reason,
      };
    }

    if (finalResult.kind === 'runtime-validation-failed') {
      emitEvent({
        kind: 'candidate-rejected-by-selector',
        runId,
        modelId: validationOrder[validationOrder.length - 1].modelId,
        resultKind: 'runtime-validation-failed',
      });
      emitEvent({ kind: 'run-completed', runId, resultKind: 'runtime-validation-failed' });
      return {
        kind: 'runtime-validation-failed',
        runId,
        dispositions: finalResult.dispositions,
        reason: finalResult.reason,
        validationOrder,
        remainingValidationOrder: [],
      };
    }

    // After the loop, only selected or runtime-validation-failed are expected
    // from the signed-off selector. Any other result is a selector contract
    // violation and is reported as inconclusive.
    emitEvent({
      kind: 'inconclusive',
      runId,
      reason: 'incomplete-observation',
      detail: `final selector returned unexpected kind: ${finalResult.kind}`,
    });
    emitEvent({ kind: 'run-completed', runId, resultKind: 'inconclusive' });
    return {
      kind: 'inconclusive',
      runId,
      modelId: '',
      ollamaTag: '',
      reason: 'incomplete-observation',
      detail: `final selector returned unexpected kind: ${finalResult.kind}`,
      validationOrder,
      remainingValidationOrder: [],
    };
  } finally {
    releaseLease();
  }
}
