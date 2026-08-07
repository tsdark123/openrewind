// =============================================================================
// runtimeValidationOrchestrator.ts — pure, I/O-free orchestration for
// Chapter 2B runtime validation (Slice 1).
//
// This module decides which certified candidate to test, coordinates the
// OpenRewind model-work lease, accepts only complete identity-bound evidence,
// and repeatedly calls the signed-off `selectCertifiedModel` until a candidate
// is positively selected or the run terminates.
//
// It does not contact Ollama, Tauri, the network, timers or browser APIs. The
// actual model-scoped validator is injected and will be implemented in Slice 2.
// =============================================================================

import type { CertifiedModelProfile, CertificationIdentity } from './certifiedModels';
import type {
  CertifiedModelSelectorInput,
  ModelSelectionResult,
  RuntimeValidationEvidence,
} from './certifiedModelSelector';
import type { HardwareProfile } from './hardwareProfile';

// ---------------------------------------------------------------------------
// Smoothness policy
// ---------------------------------------------------------------------------

export interface SmoothnessPolicy {
  warmSampleCount: number;
  maxP95TrueTTFTMs: number;
  maxP95WallClockMs: number;
}

// ---------------------------------------------------------------------------
// Run input
// ---------------------------------------------------------------------------

export interface RuntimeValidationRunInput {
  /** Deterministic, caller-supplied identifier. No time or randomness. */
  runId: string;
  /** Snapshot of the certified-model registry at the start of the run. */
  registry: CertifiedModelProfile[];
  /** Snapshot of the local hardware profile. */
  hardwareProfile: HardwareProfile;
  /** Target runtime for selector compatibility (e.g. 'ollama'). */
  runtime: string;
  /** Target operating system for selector compatibility (e.g. 'win32'). */
  platform: string;
  /** Approved warm smoothness budget for this run. */
  smoothnessPolicy: SmoothnessPolicy;
  /** External abort signal. */
  signal: AbortSignal;
  /** Optional progress observer. Emissions are best-effort and non-mutating. */
  onProgress?: (event: RuntimeValidationProgressEvent) => void;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ModelWorkLease {
  release(): void;
}

export interface RuntimeValidationDiagnostics {
  modelId: string;
  ollamaTag: string;
  runId: string;
  startedAt?: string;
  completedAt?: string;
  stages?: string[];
  error?: string;
}

export interface RuntimeValidationAttemptValidated {
  kind: 'validated';
  evidence: RuntimeValidationEvidence;
  certificationIdentity: CertificationIdentity;
  diagnostics?: RuntimeValidationDiagnostics;
}

export interface RuntimeValidationAttemptFailed {
  kind: 'failed';
  evidence: RuntimeValidationEvidence;
  certificationIdentity: CertificationIdentity;
  diagnostics?: RuntimeValidationDiagnostics;
}

export interface RuntimeValidationAttemptActionRequired {
  kind: 'action-required';
  reason:
    | 'not-installed'
    | 'wrong-digest'
    | 'certified-digest-unavailable'
    | 'unsupported-ollama-version';
  diagnostics: RuntimeValidationDiagnostics;
}

export interface RuntimeValidationAttemptInconclusive {
  kind: 'inconclusive';
  reason: string;
  diagnostics: RuntimeValidationDiagnostics;
}

export interface RuntimeValidationAttemptCancelled {
  kind: 'cancelled';
  reason: 'aborted' | 'stale' | string;
  diagnostics: RuntimeValidationDiagnostics;
}

export type RuntimeValidationAttempt =
  | RuntimeValidationAttemptValidated
  | RuntimeValidationAttemptFailed
  | RuntimeValidationAttemptActionRequired
  | RuntimeValidationAttemptInconclusive
  | RuntimeValidationAttemptCancelled;

export type ValidateCandidate = (
  profile: CertifiedModelProfile,
  runInput: RuntimeValidationRunInput,
  isCurrent: () => boolean
) => Promise<RuntimeValidationAttempt>;

export interface RuntimeValidationDependencies {
  /** The signed-off pure selector. */
  selectCertifiedModel: (input: CertifiedModelSelectorInput) => ModelSelectionResult;
  /** Future Slice 2 validator. In Slice 1 this is fakeable. */
  validateCandidate: ValidateCandidate;
  /** Yields a lease or 'busy'. No real implementation in Slice 1. */
  acquireLease: () => Promise<ModelWorkLease | 'busy'>;
  /** Returns true only while this run is still the current one. */
  isCurrent: () => boolean;
}

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

export type RuntimeValidationProgressEvent =
  | { kind: 'run-started'; runId: string }
  | { kind: 'lock-acquired'; runId: string }
  | { kind: 'validation-order-resolved'; runId: string; validationOrder: string[] }
  | { kind: 'candidate-started'; runId: string; modelId: string }
  | { kind: 'action-required'; runId: string; modelId: string; reason: string }
  | { kind: 'candidate-completed'; runId: string; modelId: string; attemptKind: 'validated' | 'failed' }
  | { kind: 'candidate-rejected-by-selector'; runId: string; modelId: string; resultKind: string }
  | { kind: 'candidate-selected'; runId: string; modelId: string }
  | { kind: 'inconclusive'; runId: string; modelId?: string; reason: string }
  | { kind: 'cancelled-stale'; runId: string; modelId?: string; reason: string }
  | { kind: 'run-completed'; runId: string; resultKind: string };

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type RuntimeValidationOrchestratorResult =
  | (ModelSelectionResult & { runId: string })
  | {
      kind: 'action-required';
      runId: string;
      modelId: string;
      reason: string;
      action: 'install-consent' | 're-pull-consent' | 'update-ollama' | 'registry-identity-missing';
    }
  | { kind: 'inconclusive'; runId: string; reason: string }
  | { kind: 'cancelled-stale'; runId: string; reason: string };

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

type ActionCategory = 'install-consent' | 're-pull-consent' | 'update-ollama' | 'registry-identity-missing';

function mapActionRequiredReason(
  reason: RuntimeValidationAttemptActionRequired['reason']
): ActionCategory {
  switch (reason) {
    case 'not-installed':
      return 'install-consent';
    case 'wrong-digest':
      return 're-pull-consent';
    case 'certified-digest-unavailable':
      return 'registry-identity-missing';
    case 'unsupported-ollama-version':
      return 'update-ollama';
    default:
      return 'install-consent';
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

/**
 * Verify that a complete attempt's evidence carries every mandatory selector
 * field and that its identity matches the registry profile. Incomplete or
 * mismatched evidence must not reach the selector.
 */
function verifyEvidenceForProfile(
  profile: CertifiedModelProfile,
  attempt: RuntimeValidationAttemptValidated | RuntimeValidationAttemptFailed
): { ok: true } | { ok: false; reason: string } {
  const ev = attempt.evidence;

  if (ev.modelId !== profile.modelId) return { ok: false, reason: 'evidence modelId mismatch' };
  if (ev.ollamaTag !== profile.ollamaTag) return { ok: false, reason: 'evidence ollamaTag mismatch' };
  if (ev.certificationVersion !== profile.certificationVersion)
    return { ok: false, reason: 'evidence certificationVersion mismatch' };
  if (ev.benchmarkSuiteVersion !== profile.benchmarkSuiteVersion)
    return { ok: false, reason: 'evidence benchmarkSuiteVersion mismatch' };
  if (ev.controlledContextSize !== profile.controlledContextSize)
    return { ok: false, reason: 'evidence controlledContextSize mismatch' };
  if (ev.thinking !== profile.thinking) return { ok: false, reason: 'evidence thinking mismatch' };
  if (ev.keepAlive !== profile.keepAlive) return { ok: false, reason: 'evidence keepAlive mismatch' };

  if (!isNonBlankString(ev.runtime)) return { ok: false, reason: 'evidence runtime missing or blank' };
  if (!isNonBlankString(ev.platform)) return { ok: false, reason: 'evidence platform missing or blank' };
  if (!isNonBlankString(ev.comparisonGroupId))
    return { ok: false, reason: 'evidence comparisonGroupId missing or blank' };

  if (!isBoolean(ev.loadSuccess)) return { ok: false, reason: 'evidence loadSuccess is not a boolean' };
  if (!isBoolean(ev.oom)) return { ok: false, reason: 'evidence oom is not a boolean' };
  if (!isBoolean(ev.cpuOffload)) return { ok: false, reason: 'evidence cpuOffload is not a boolean' };
  if (!isBoolean(ev.evicted)) return { ok: false, reason: 'evidence evicted is not a boolean' };
  if (!isBoolean(ev.smoothnessOk)) return { ok: false, reason: 'evidence smoothnessOk is not a boolean' };

  if (ev.loadFailureReason !== undefined && !isNonBlankString(ev.loadFailureReason))
    return { ok: false, reason: 'evidence loadFailureReason must be a nonblank string when present' };

  if (ev.measuredWholeAppPeakMemoryMiB !== undefined && !isNonNegativeFiniteNumber(ev.measuredWholeAppPeakMemoryMiB))
    return { ok: false, reason: 'evidence measuredWholeAppPeakMemoryMiB must be a nonnegative finite number when present' };
  if (ev.avgTokensPerSecond !== undefined && !isNonNegativeFiniteNumber(ev.avgTokensPerSecond))
    return { ok: false, reason: 'evidence avgTokensPerSecond must be a nonnegative finite number when present' };
  if (ev.p95WallClockMs !== undefined && !isNonNegativeFiniteNumber(ev.p95WallClockMs))
    return { ok: false, reason: 'evidence p95WallClockMs must be a nonnegative finite number when present' };
  if (ev.p95TrueTTFTMs !== undefined && !isNonNegativeFiniteNumber(ev.p95TrueTTFTMs))
    return { ok: false, reason: 'evidence p95TrueTTFTMs must be a nonnegative finite number when present' };

  const expectedId = profile.certificationIdentity;
  if (profile.certified) {
    if (!expectedId) return { ok: false, reason: 'certified profile missing certificationIdentity' };
    const actualId = attempt.certificationIdentity;
    if (
      actualId.modelTag !== expectedId.modelTag ||
      actualId.modelDigest !== expectedId.modelDigest ||
      actualId.ollamaVersion !== expectedId.ollamaVersion ||
      actualId.productionHead !== expectedId.productionHead ||
      actualId.certificationContractVersion !== expectedId.certificationContractVersion ||
      actualId.promptSuiteVersion !== expectedId.promptSuiteVersion ||
      actualId.scorerVersion !== expectedId.scorerVersion ||
      actualId.schemaVersion !== expectedId.schemaVersion
    ) {
      return { ok: false, reason: 'certificationIdentity tuple mismatch' };
    }
  }

  return { ok: true };
}

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

  function isCancelledOrStale(): { cancelled: true; reason: 'aborted' | 'stale' } | { cancelled: false } {
    if (signal.aborted) return { cancelled: true, reason: 'aborted' };
    if (!deps.isCurrent()) return { cancelled: true, reason: 'stale' };
    return { cancelled: false };
  }

  function cancelCheck(modelId?: string): RuntimeValidationOrchestratorResult | undefined {
    const c = isCancelledOrStale();
    if (c.cancelled) {
      emitEvent({ kind: 'cancelled-stale', runId, modelId, reason: c.reason });
      return { kind: 'cancelled-stale', runId, reason: c.reason };
    }
    return undefined;
  }

  emitEvent({ kind: 'run-started', runId });

  const initialCancel = cancelCheck();
  if (initialCancel) return initialCancel;

  let lease: ModelWorkLease | 'busy';
  try {
    lease = await deps.acquireLease();
  } catch (e) {
    const reason = `lease acquisition failed: ${e instanceof Error ? e.message : String(e)}`;
    emitEvent({ kind: 'inconclusive', runId, reason });
    return { kind: 'inconclusive', runId, reason };
  }

  if (lease === 'busy') {
    const reason = 'model-work lease busy';
    emitEvent({ kind: 'inconclusive', runId, reason });
    return { kind: 'inconclusive', runId, reason };
  }

  const activeLease: ModelWorkLease = lease;
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
    const postLockCancel = cancelCheck();
    if (postLockCancel) return postLockCancel;

    emitEvent({ kind: 'lock-acquired', runId });

    const initialResult = deps.selectCertifiedModel({
      registry: input.registry,
      runtime: input.runtime,
      platform: input.platform,
      runtimeValidationEvidence: {},
    });

    if (
      initialResult.kind === 'no-certified-profiles' ||
      initialResult.kind === 'no-compatible-certified' ||
      initialResult.kind === 'runtime-validation-failed' ||
      initialResult.kind === 'invalid-input'
    ) {
      emitEvent({ kind: 'run-completed', runId, resultKind: initialResult.kind });
      return { ...initialResult, runId };
    }

    // selected cannot occur with no evidence; validation-required is the only
    // expected starting state.
    const validationOrder: CertifiedModelProfile[] =
      initialResult.kind === 'selected'
        ? [initialResult.selected, ...initialResult.validationOrder]
        : initialResult.validationOrder;

    emitEvent({
      kind: 'validation-order-resolved',
      runId,
      validationOrder: validationOrder.map((p) => p.modelId),
    });

    const evidenceById: Record<string, RuntimeValidationEvidence> = {};

    for (let i = 0; i < validationOrder.length; i++) {
      const candidate = validationOrder[i];

      const beforeCandidateCancel = cancelCheck(candidate.modelId);
      if (beforeCandidateCancel) return beforeCandidateCancel;

      emitEvent({ kind: 'candidate-started', runId, modelId: candidate.modelId });

      let attempt: RuntimeValidationAttempt;
      try {
        attempt = await deps.validateCandidate(candidate, input, deps.isCurrent);
      } catch (e) {
        attempt = {
          kind: 'inconclusive',
          reason: `validator exception: ${e instanceof Error ? e.message : String(e)}`,
          diagnostics: {
            modelId: candidate.modelId,
            ollamaTag: candidate.ollamaTag,
            runId,
            error: e instanceof Error ? e.message : String(e),
          },
        };
      }

      const afterValidationCancel = cancelCheck(candidate.modelId);
      if (afterValidationCancel) return afterValidationCancel;

      if (attempt.kind === 'action-required') {
        emitEvent({
          kind: 'action-required',
          runId,
          modelId: candidate.modelId,
          reason: attempt.reason,
        });
        return {
          kind: 'action-required',
          runId,
          modelId: candidate.modelId,
          reason: attempt.reason,
          action: mapActionRequiredReason(attempt.reason),
        };
      }

      if (attempt.kind === 'inconclusive') {
        emitEvent({
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          reason: attempt.reason,
        });
        return { kind: 'inconclusive', runId, reason: attempt.reason };
      }

      if (attempt.kind === 'cancelled') {
        const reason = attempt.reason || 'aborted';
        emitEvent({ kind: 'cancelled-stale', runId, modelId: candidate.modelId, reason });
        return { kind: 'cancelled-stale', runId, reason };
      }

      const preConversionCancel = cancelCheck(candidate.modelId);
      if (preConversionCancel) return preConversionCancel;

      const verified = verifyEvidenceForProfile(candidate, attempt);
      if (!verified.ok) {
        emitEvent({
          kind: 'inconclusive',
          runId,
          modelId: candidate.modelId,
          reason: verified.reason,
        });
        return { kind: 'inconclusive', runId, reason: verified.reason };
      }

      evidenceById[candidate.modelId] = attempt.evidence;

      emitEvent({
        kind: 'candidate-completed',
        runId,
        modelId: candidate.modelId,
        attemptKind: attempt.kind,
      });

      const preSelectorCancel = cancelCheck(candidate.modelId);
      if (preSelectorCancel) return preSelectorCancel;

      const selectorResult = deps.selectCertifiedModel({
        registry: input.registry,
        runtime: input.runtime,
        platform: input.platform,
        runtimeValidationEvidence: evidenceById,
      });

      const preReturnCancel = cancelCheck(candidate.modelId);
      if (preReturnCancel) return preReturnCancel;

      if (selectorResult.kind === 'selected') {
        emitEvent({
          kind: 'candidate-selected',
          runId,
          modelId: selectorResult.selected.modelId,
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'selected' });
        return { ...selectorResult, runId };
      }

      if (selectorResult.kind === 'runtime-validation-failed') {
        emitEvent({
          kind: 'candidate-rejected-by-selector',
          runId,
          modelId: candidate.modelId,
          resultKind: 'runtime-validation-failed',
        });
        emitEvent({ kind: 'run-completed', runId, resultKind: 'runtime-validation-failed' });
        return { ...selectorResult, runId };
      }

      if (selectorResult.kind === 'validation-required') {
        // Continue with the next candidate in the original order. The original
        // order is preserved; the selector only adds/removes evidence.
        continue;
      }

      // no-certified-profiles, no-compatible-certified, invalid-input are
      // terminal after evidence has been added.
      emitEvent({ kind: 'run-completed', runId, resultKind: selectorResult.kind });
      return { ...selectorResult, runId };
    }

    // All candidates attempted without a positive selection. Final selector call
    // is the authoritative result.
    const preFinalCancel = cancelCheck();
    if (preFinalCancel) return preFinalCancel;

    const finalResult = deps.selectCertifiedModel({
      registry: input.registry,
      runtime: input.runtime,
      platform: input.platform,
      runtimeValidationEvidence: evidenceById,
    });

    const finalCancel = cancelCheck();
    if (finalCancel) return finalCancel;

    emitEvent({ kind: 'run-completed', runId, resultKind: finalResult.kind });
    return { ...finalResult, runId };
  } finally {
    releaseLease();
  }
}
