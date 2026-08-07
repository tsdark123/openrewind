import { describe, it, expect, vi } from 'vitest';
import {
  runRuntimeValidation,
  APPROVED_WARM_SMOOTHNESS_POLICY,
  type RuntimeValidationRunInput,
  type RuntimeValidationDependencies,
  type RuntimeValidationAttempt,
  type RuntimeValidationObservation,
  type RuntimeValidationProgressEvent,
  type SmoothnessPolicy,
  type LeaseAcquisition,
  type RuntimeValidationCandidateInput,
} from '../runtimeValidationOrchestrator';
import {
  selectCertifiedModel,
  type CertifiedModelSelectorInput,
  type ModelSelectionResult,
  type RuntimeValidationEvidence,
} from '../certifiedModelSelector';
import type { CertifiedModelProfile, CertificationIdentity, HardwareProfile } from '../certifiedModels';

const DEFAULT_RUNTIME = 'ollama';
const DEFAULT_PLATFORM = 'win32';
const DEFAULT_RUN_ID = 'orion-2b-run-001';

const DEFAULT_CERTIFICATION_IDENTITY: CertificationIdentity = {
  modelTag: 'qwen3:8b',
  modelDigest: '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41',
  ollamaVersion: '0.32.6',
  productionHead: 'aa4553522065229f62ed5cf85c13a9cdb8740739',
  certificationContractVersion: 'v2.1.1-semantic',
  promptSuiteVersion: 'v2.1.0-22-prompts',
  scorerVersion: 'v2.0.1',
  schemaVersion: 'v2.0.0',
};

function makeCertificationIdentity(overrides: Partial<CertificationIdentity> = {}): CertificationIdentity {
  return { ...DEFAULT_CERTIFICATION_IDENTITY, ...overrides };
}

function makeProfile(overrides: Partial<CertifiedModelProfile> = {}): CertifiedModelProfile {
  return {
    modelId: 'qwen3:8b',
    ollamaTag: 'qwen3:8b',
    certificationVersion: 'v2.1.1-semantic',
    benchmarkSuiteVersion: 'v2.1.0-22-prompts',
    certified: true,
    certificationDate: '2026-08-07',
    certificationIdentity: makeCertificationIdentity(),
    controlledContextSize: 4096,
    thinking: false,
    keepAlive: '10m',
    supportedRuntimes: ['ollama'],
    supportedOperatingSystems: ['win32'],
    primaryRepetitionPassRate: 1.0,
    primaryPromptPassRate: 1.0,
    safetyExecutionRate: 1.0,
    safetyClassificationAccuracy: 1.0,
    preconditionPassRate: 1.0,
    rawFieldAccuracy: 0.967,
    pipelineFieldAccuracy: 0.922,
    avgHallucinationRate: 0.022,
    measuredModelSizeHuman: '5.6 GB',
    measuredWholeRuntimeMemoryMiB: 6802,
    processorSplit: '100% GPU',
    avgTokensPerSecond: 82.31,
    p95WallClockMs: 792,
    p95TrueTTFTMs: 160,
    conservativeRecommendedHardware:
      'Measured on NVIDIA GeForce RTX 3070 Ti 8 GB. Universal minimum envelope is unresolved.',
    measuredHardwareReferences: [
      'NVIDIA GeForce RTX 3070 Ti 8 GB, WDDM, 8192 MiB VRAM, Ollama local runtime',
    ],
    fallbackPriority: 0,
    ...overrides,
  } as CertifiedModelProfile;
}

function makeHardwareProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    platform: DEFAULT_PLATFORM,
    timestamp: '2026-08-07T00:00:00.000Z',
    cpu: {
      logicalCores: { status: 'known', value: 8, source: 'test' },
      physicalCores: { status: 'known', value: 4, source: 'test' },
      brand: { status: 'known', value: 'Test CPU', source: 'test' },
    },
    ram: {
      totalMib: { status: 'known', value: 16384, source: 'test' },
      availableMib: { status: 'known', value: 8192, source: 'test' },
    },
    gpuInventory: {
      status: 'known',
      source: 'test',
      devices: [
        {
          index: 0,
          model: { status: 'known', value: 'NVIDIA Test GPU', source: 'test' },
          totalVramMib: { status: 'known', value: 8192, source: 'test' },
          availableVramMib: { status: 'known', value: 4096, source: 'test' },
          computeCapability: { status: 'known', value: '8.6', source: 'test' },
        },
      ],
    },
    warnings: [],
    ...overrides,
  } as HardwareProfile;
}

function makeObservation(
  profile: CertifiedModelProfile,
  overrides: Partial<RuntimeValidationObservation> = {}
): RuntimeValidationObservation {
  return {
    modelId: profile.modelId,
    ollamaTag: profile.ollamaTag,
    certificationIdentity: profile.certificationIdentity as CertificationIdentity,
    loadSuccess: true,
    oom: false,
    cpuOffload: false,
    evicted: false,
    smoothnessOk: true,
    ...overrides,
  };
}

function makeValidatedAttempt(
  profile: CertifiedModelProfile,
  overrides: { observation?: Partial<RuntimeValidationObservation>; certificationIdentity?: CertificationIdentity } = {}
): Extract<RuntimeValidationAttempt, { kind: 'validated' }> {
  const observation = makeObservation(profile, overrides.observation);
  return {
    kind: 'validated',
    observation: overrides.certificationIdentity
      ? { ...observation, certificationIdentity: overrides.certificationIdentity }
      : observation,
  };
}

function makeFailedAttempt(
  profile: CertifiedModelProfile,
  overrides: { observation?: Partial<RuntimeValidationObservation>; certificationIdentity?: CertificationIdentity } = {}
): Extract<RuntimeValidationAttempt, { kind: 'failed' }> {
  const observation = makeObservation(profile, { smoothnessOk: false, ...overrides.observation });
  return {
    kind: 'failed',
    observation: overrides.certificationIdentity
      ? { ...observation, certificationIdentity: overrides.certificationIdentity }
      : observation,
  };
}

function makeRunInput(overrides: Partial<RuntimeValidationRunInput> = {}): RuntimeValidationRunInput {
  const controller = new AbortController();
  return {
    runId: DEFAULT_RUN_ID,
    registry: [makeProfile()],
    hardwareProfile: makeHardwareProfile(),
    runtime: DEFAULT_RUNTIME,
    platform: DEFAULT_PLATFORM,
    smoothnessPolicy: APPROVED_WARM_SMOOTHNESS_POLICY,
    signal: controller.signal,
    ...overrides,
  };
}

function makeLease(release: () => void = vi.fn()): LeaseAcquisition {
  return { kind: 'acquired', lease: { release } };
}

function makeDependencies(overrides: Partial<RuntimeValidationDependencies> = {}): RuntimeValidationDependencies {
  return {
    selectCertifiedModel,
    validateCandidate: vi.fn().mockRejectedValue(new Error('no validator configured')),
    acquireLease: vi.fn().mockResolvedValue(makeLease()),
    isCurrent: () => true,
    ...overrides,
  } as unknown as RuntimeValidationDependencies;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runRuntimeValidation', () => {
  it('validator returns a raw complete observation, not RuntimeValidationEvidence', async () => {
    const profile = makeProfile();
    const observation = makeObservation(profile);
    const attempt: RuntimeValidationAttempt = { kind: 'validated', observation };

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('selected');
    // The attempt must be an observation; it must not carry selector-owned
    // evidence fields or context that the orchestrator adds later.
    expect(attempt).not.toHaveProperty('evidence');
    expect(observation).not.toHaveProperty('runtime');
    expect(observation).not.toHaveProperty('platform');
    expect(observation).not.toHaveProperty('comparisonGroupId');
    expect(observation).not.toHaveProperty('certificationVersion');
    expect(observation).not.toHaveProperty('benchmarkSuiteVersion');
    expect(observation).not.toHaveProperty('controlledContextSize');
    expect(observation).not.toHaveProperty('thinking');
    expect(observation).not.toHaveProperty('keepAlive');
  });

  it('orchestrator constructs selector evidence from registry and run inputs', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue(makeValidatedAttempt(profile)),
    });

    await runRuntimeValidation(
      makeRunInput({
        registry: [profile],
        runtime: DEFAULT_RUNTIME,
        platform: DEFAULT_PLATFORM,
        runId: DEFAULT_RUN_ID,
      }),
      deps
    );

    expect(selectSpy).toHaveBeenCalledTimes(2);
    const secondCall = selectSpy.mock.calls[1][0];
    const evidence = secondCall.runtimeValidationEvidence[profile.modelId] as RuntimeValidationEvidence;

    expect(evidence).toEqual({
      modelId: profile.modelId,
      ollamaTag: profile.ollamaTag,
      certificationVersion: profile.certificationVersion,
      benchmarkSuiteVersion: profile.benchmarkSuiteVersion,
      controlledContextSize: profile.controlledContextSize,
      thinking: profile.thinking,
      keepAlive: profile.keepAlive,
      runtime: DEFAULT_RUNTIME,
      platform: DEFAULT_PLATFORM,
      comparisonGroupId: DEFAULT_RUN_ID,
      loadSuccess: true,
      loadFailureReason: undefined,
      oom: false,
      cpuOffload: false,
      evicted: false,
      measuredWholeAppPeakMemoryMiB: undefined,
      avgTokensPerSecond: undefined,
      p95WallClockMs: undefined,
      p95TrueTTFTMs: undefined,
      smoothnessOk: true,
    });
  });

  it('comparisonGroupId always equals the current runId', async () => {
    const runId = 'custom-run-42';
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue(makeValidatedAttempt(profile)),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile], runId }), deps);

    const secondCall = selectSpy.mock.calls[1][0];
    expect(secondCall.runtimeValidationEvidence[profile.modelId].comparisonGroupId).toBe(runId);
  });

  it('does not let validator override runtime, platform or profile identity', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);
    const observation = makeObservation(profile);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue({ kind: 'validated', observation }),
    });

    await runRuntimeValidation(
      makeRunInput({
        registry: [profile],
        runtime: 'ollama',
        platform: 'win32',
      }),
      deps
    );

    const secondCall = selectSpy.mock.calls[1][0];
    const evidence = secondCall.runtimeValidationEvidence[profile.modelId];
    expect(evidence.runtime).toBe('ollama');
    expect(evidence.platform).toBe('win32');
    expect(evidence.modelId).toBe(profile.modelId);
    expect(evidence.certificationVersion).toBe(profile.certificationVersion);
  });

  it('rejects mismatched observed candidate identity as inconclusive before a second selector call', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const attempt = makeValidatedAttempt(profile, {
      observation: { modelId: 'impostor', ollamaTag: 'impostor' },
    });

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched certification identity as inconclusive before a second selector call', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const attempt = makeValidatedAttempt(profile, {
      certificationIdentity: makeCertificationIdentity({ ollamaVersion: '0.99.9' }),
    });

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('turns wrong-model action-required attempts into inconclusive and emits no user action', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const attempt: RuntimeValidationAttempt = {
      kind: 'action-required',
      reason: 'not-installed',
      modelId: 'wrong-model',
      ollamaTag: 'wrong-tag',
    };

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'inconclusive') {
      expect(result.reason).toBe('incomplete-observation');
    }
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let contradictory complete observations reach the selector', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    // A 'validated' attempt with smoothnessOk=false is contradictory.
    const attempt = makeValidatedAttempt(profile, {
      observation: { smoothnessOk: false },
    });

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let partial observations reach the selector', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const attempt = makeValidatedAttempt(profile, {
      observation: { smoothnessOk: undefined as any },
    });

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('lets complete authoritative negative evidence reach the selector', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue(makeFailedAttempt(profile)),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('runtime-validation-failed');
    expect(selectSpy).toHaveBeenCalledTimes(2);
    const secondCall = selectSpy.mock.calls[1][0];
    expect(secondCall.runtimeValidationEvidence[profile.modelId].smoothnessOk).toBe(false);
  });

  it.each([
    ['not-installed' as const, 'install-consent'],
    ['wrong-digest' as const, 're-pull-consent'],
    ['certified-digest-unavailable' as const, 'registry-identity-missing'],
    ['unsupported-ollama-version' as const, 'update-ollama'],
  ])(
    'action-required %s produces no evidence and maps to %s',
    async (reason, action) => {
      const profile = makeProfile();
      const selectSpy = vi.fn(selectCertifiedModel);

      const attempt: RuntimeValidationAttempt = {
        kind: 'action-required',
        reason,
        modelId: profile.modelId,
        ollamaTag: profile.ollamaTag,
      };

      const deps = makeDependencies({
        selectCertifiedModel: selectSpy,
        validateCandidate: vi.fn().mockResolvedValue(attempt),
      });

      const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

      expect(result.kind).toBe('action-required');
      if (result.kind === 'action-required') {
        expect(result.action).toBe(action);
        expect(result.reason).toBe(reason);
      }
      expect(selectSpy).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects arbitrary smoothness-policy values before lease, selector or validator work', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);
    const validateSpy = vi.fn();
    const acquireSpy = vi.fn();

    const badPolicy: SmoothnessPolicy = {
      warmSampleCount: 99,
      maxP95TrueTTFTMs: 999,
      maxP95WallClockMs: 999,
    };

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: validateSpy,
      acquireLease: acquireSpy,
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile], smoothnessPolicy: badPolicy }), deps);

    expect(result.kind).toBe('invalid-input');
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('gives the validator a candidate input without registry, progress observer or orchestration state', async () => {
    const profile = makeProfile();
    const validateSpy = vi.fn().mockResolvedValue(makeValidatedAttempt(profile));

    const deps = makeDependencies({ validateCandidate: validateSpy });
    const input = makeRunInput({ registry: [profile], onProgress: vi.fn() });

    await runRuntimeValidation(input, deps);

    const candidateInput = validateSpy.mock.calls[0][0] as RuntimeValidationCandidateInput;

    expect(candidateInput.runId).toBe(input.runId);
    expect(candidateInput.profile.modelId).toBe(profile.modelId);
    expect(candidateInput.certificationIdentity).toEqual(profile.certificationIdentity);
    expect(candidateInput.hardwareProfile).toEqual(input.hardwareProfile);
    expect(candidateInput.runtime).toBe(input.runtime);
    expect(candidateInput.platform).toBe(input.platform);
    expect(candidateInput.smoothnessPolicy).toEqual(APPROVED_WARM_SMOOTHNESS_POLICY);
    expect(candidateInput.signal).toBe(input.signal);

    expect(candidateInput).not.toHaveProperty('registry');
    expect(candidateInput).not.toHaveProperty('onProgress');
    expect(candidateInput).not.toHaveProperty('selectCertifiedModel');
    expect(candidateInput).not.toHaveProperty('acquireLease');
    expect(candidateInput).not.toHaveProperty('validateCandidate');
  });

  it('preserves the original selector validation order', async () => {
    const a = makeProfile({ modelId: 'model-a', fallbackPriority: 0 });
    const b = makeProfile({ modelId: 'model-b', fallbackPriority: 1 });
    const order: string[] = [];

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockImplementation(async (candidateInput) => {
        order.push(candidateInput.profile.modelId);
        if (candidateInput.profile.modelId === 'model-a') {
          return makeFailedAttempt(candidateInput.profile);
        }
        return makeValidatedAttempt(candidateInput.profile);
      }),
    });

    const input = makeRunInput({ registry: [b, a] }); // registry order reversed
    const result = await runRuntimeValidation(input, deps);

    expect(result.kind).toBe('selected');
    expect(order).toEqual(['model-a', 'model-b']);
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('model-b');
      expect(result.validationOrder.map((p) => p.modelId)).toEqual(['model-a', 'model-b']);
    }
  });

  it('exposes remainingValidationOrder as the untouched suffix after selection', async () => {
    const a = makeProfile({ modelId: 'qwen3:8b', fallbackPriority: 0 });
    const b = makeProfile({ modelId: 'qwen3:second', fallbackPriority: 1 });
    const c = makeProfile({ modelId: 'qwen3:third', fallbackPriority: 2 });

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockImplementation(async (candidateInput) => {
        return makeValidatedAttempt(candidateInput.profile);
      }),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [c, b, a] }), deps);

    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('qwen3:8b');
      expect(result.validationOrder.map((p) => p.modelId)).toEqual(['qwen3:8b', 'qwen3:second', 'qwen3:third']);
      expect(result.remainingValidationOrder.map((p) => p.modelId)).toEqual(['qwen3:second', 'qwen3:third']);
    }
  });

  it('returns no selection and releases once when stale after lease acquisition but before validation', async () => {
    const profile = makeProfile();
    const release = vi.fn();
    const deferredLease = createDeferred<LeaseAcquisition>();
    let current = true;

    const deps = makeDependencies({
      isCurrent: () => current,
      acquireLease: vi.fn().mockReturnValue(deferredLease.promise),
      validateCandidate: vi.fn(),
    });

    const run = runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    await Promise.resolve();
    current = false;
    deferredLease.resolve(makeLease(release));

    const result = await run;

    expect(result.kind).toBe('cancelled-stale');
    expect(result).toEqual(expect.objectContaining({ reason: 'stale' }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(deps.validateCandidate).not.toHaveBeenCalled();
  });

  it('returns no selection and releases once when cancelled while validation is pending', async () => {
    const controller = new AbortController();
    const deferredValidate = createDeferred<RuntimeValidationAttempt>();
    const release = vi.fn();
    const profile = makeProfile();

    const validateSpy = vi.fn().mockReturnValue(deferredValidate.promise);
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: validateSpy,
      acquireLease: vi.fn().mockResolvedValue(makeLease(release)),
    });

    const run = runRuntimeValidation(makeRunInput({ signal: controller.signal, registry: [profile] }), deps);

    await Promise.resolve();

    controller.abort();
    deferredValidate.resolve(makeValidatedAttempt(profile));

    const result = await run;

    expect(result.kind).toBe('cancelled-stale');
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(validateSpy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: 'busy' as const, reason: 'lease busy' },
    { kind: 'inconclusive' as const, reason: 'lock acquisition failed' },
  ])('typed lease %s performs no validation', async (leaseKind) => {
    const selectSpy = vi.fn(selectCertifiedModel);
    const validateSpy = vi.fn();
    const release = vi.fn();

    const lease: LeaseAcquisition =
      leaseKind === 'busy'
        ? { kind: 'busy', reason: 'another run holds the model-work lease' }
        : { kind: 'inconclusive', reason: 'lock acquisition failed' };

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: validateSpy,
      acquireLease: vi.fn().mockResolvedValue(lease),
    });

    const result = await runRuntimeValidation(makeRunInput(), deps);

    expect(result.kind).toBe('inconclusive');
    expect(selectSpy).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('releases the lease once after success', async () => {
    const profile = makeProfile();
    const release = vi.fn();

    const deps = makeDependencies({
      acquireLease: vi.fn().mockResolvedValue(makeLease(release)),
      validateCandidate: vi.fn().mockResolvedValue(makeValidatedAttempt(profile)),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease once after action-required', async () => {
    const profile = makeProfile();
    const release = vi.fn();

    const attempt: RuntimeValidationAttempt = {
      kind: 'action-required',
      reason: 'not-installed',
      modelId: profile.modelId,
      ollamaTag: profile.ollamaTag,
    };

    const deps = makeDependencies({
      acquireLease: vi.fn().mockResolvedValue(makeLease(release)),
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease once after inconclusive', async () => {
    const profile = makeProfile();
    const release = vi.fn();

    const attempt: RuntimeValidationAttempt = {
      kind: 'inconclusive',
      reason: 'ambiguous-engine-failure',
      modelId: profile.modelId,
      ollamaTag: profile.ollamaTag,
      detail: 'HTTP 500',
    };

    const deps = makeDependencies({
      acquireLease: vi.fn().mockResolvedValue(makeLease(release)),
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not acquire or release a lease when cancelled before acquisition', async () => {
    const controller = new AbortController();
    controller.abort();
    const release = vi.fn();
    const acquireSpy = vi.fn();

    const deps = makeDependencies({
      acquireLease: acquireSpy,
    });

    const result = await runRuntimeValidation(makeRunInput({ signal: controller.signal }), deps);

    expect(result.kind).toBe('cancelled-stale');
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('releases the lease once after cancellation after lock acquisition', async () => {
    const controller = new AbortController();
    const deferredLease = createDeferred<LeaseAcquisition>();
    const deferredValidate = createDeferred<RuntimeValidationAttempt>();
    const release = vi.fn();

    const deps = makeDependencies({
      acquireLease: vi.fn().mockReturnValue(deferredLease.promise),
      validateCandidate: vi.fn().mockReturnValue(deferredValidate.promise),
    });

    const run = runRuntimeValidation(makeRunInput({ signal: controller.signal }), deps);

    await Promise.resolve();
    controller.abort();
    deferredLease.resolve(makeLease(release));
    deferredValidate.resolve(makeValidatedAttempt(makeProfile()));

    await run;

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease once after validator exception', async () => {
    const release = vi.fn();

    const deps = makeDependencies({
      acquireLease: vi.fn().mockResolvedValue(makeLease(release)),
      validateCandidate: vi.fn().mockRejectedValue(new Error('validator boom')),
    });

    await runRuntimeValidation(makeRunInput(), deps);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('emits exactly one run-completed for every terminal path', async () => {
    const cases: { deps: RuntimeValidationDependencies; expectedResult: string }[] = [
      {
        deps: makeDependencies({
          validateCandidate: vi.fn().mockResolvedValue(makeValidatedAttempt(makeProfile())),
        }),
        expectedResult: 'selected',
      },
      {
        deps: makeDependencies({
          validateCandidate: vi.fn().mockResolvedValue(makeFailedAttempt(makeProfile())),
        }),
        expectedResult: 'runtime-validation-failed',
      },
      {
        deps: makeDependencies({
          validateCandidate: vi.fn().mockResolvedValue({
            kind: 'action-required',
            reason: 'not-installed',
            modelId: 'qwen3:8b',
            ollamaTag: 'qwen3:8b',
          } as RuntimeValidationAttempt),
        }),
        expectedResult: 'action-required',
      },
      {
        deps: makeDependencies({
          validateCandidate: vi.fn().mockResolvedValue({
            kind: 'inconclusive',
            reason: 'ambiguous-engine-failure',
            modelId: 'qwen3:8b',
            ollamaTag: 'qwen3:8b',
          } as RuntimeValidationAttempt),
        }),
        expectedResult: 'inconclusive',
      },
      {
        deps: makeDependencies({
          acquireLease: vi.fn().mockResolvedValue({ kind: 'busy', reason: 'busy' } as LeaseAcquisition),
        }),
        expectedResult: 'inconclusive',
      },
      {
        deps: makeDependencies({
          isCurrent: () => false,
        }),
        expectedResult: 'cancelled-stale',
      },
    ];

    for (const { deps, expectedResult } of cases) {
      const events: RuntimeValidationProgressEvent[] = [];
      const input = makeRunInput({ onProgress: (e) => events.push(e) });

      await runRuntimeValidation(input, deps);

      const completed = events.filter((e) => e.kind === 'run-completed');
      expect(completed).toHaveLength(1);
      expect(completed[0].resultKind).toBe(expectedResult);
      expect(events[events.length - 1].kind).toBe('run-completed');
    }
  });

  it('success progress order is correct', async () => {
    const profile = makeProfile();
    const events: RuntimeValidationProgressEvent[] = [];

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue(makeValidatedAttempt(profile)),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile], onProgress: (e) => events.push(e) }), deps);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'run-started',
      'lock-acquired',
      'validation-order-resolved',
      'candidate-started',
      'candidate-completed',
      'candidate-selected',
      'run-completed',
    ]);
  });

  it('action-required progress order is correct', async () => {
    const profile = makeProfile();
    const events: RuntimeValidationProgressEvent[] = [];

    const attempt: RuntimeValidationAttempt = {
      kind: 'action-required',
      reason: 'not-installed',
      modelId: profile.modelId,
      ollamaTag: profile.ollamaTag,
    };

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile], onProgress: (e) => events.push(e) }), deps);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'run-started',
      'lock-acquired',
      'validation-order-resolved',
      'candidate-started',
      'action-required',
      'run-completed',
    ]);
  });

  it('inconclusive progress order is correct', async () => {
    const profile = makeProfile();
    const events: RuntimeValidationProgressEvent[] = [];

    const attempt: RuntimeValidationAttempt = {
      kind: 'inconclusive',
      reason: 'ambiguous-engine-failure',
      modelId: profile.modelId,
      ollamaTag: profile.ollamaTag,
      detail: 'HTTP 500',
    };

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile], onProgress: (e) => events.push(e) }), deps);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'run-started',
      'lock-acquired',
      'validation-order-resolved',
      'candidate-started',
      'inconclusive',
      'run-completed',
    ]);
  });

  it('busy lease progress order is correct', async () => {
    const events: RuntimeValidationProgressEvent[] = [];

    const deps = makeDependencies({
      acquireLease: vi.fn().mockResolvedValue({ kind: 'busy', reason: 'busy' } as LeaseAcquisition),
    });

    await runRuntimeValidation(makeRunInput({ onProgress: (e) => events.push(e) }), deps);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['run-started', 'inconclusive', 'run-completed']);
  });

  it('cancelled progress order is correct', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: RuntimeValidationProgressEvent[] = [];

    const deps = makeDependencies({});

    await runRuntimeValidation(makeRunInput({ signal: controller.signal, onProgress: (e) => events.push(e) }), deps);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['run-started', 'cancelled-stale', 'run-completed']);
  });

  it('selects the single current certified candidate without speculative fallback behavior', async () => {
    const profile = makeProfile();

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue(makeValidatedAttempt(profile)),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('qwen3:8b');
      expect(result.fallbackOrder).toHaveLength(0);
      expect(result.validationOrder.map((p) => p.modelId)).toEqual(['qwen3:8b']);
      expect(result.remainingValidationOrder).toHaveLength(0);
    }
    expect(deps.validateCandidate).toHaveBeenCalledTimes(1);
  });

  it('rejects the dependency interface at compile time when model lifecycle methods are added', () => {
    const deps = makeDependencies();

    // TypeScript must reject this; the test only compiles if the error is expected.
    // @ts-expect-error pullModel must not exist on RuntimeValidationDependencies
    const _badDeps: RuntimeValidationDependencies = { ...deps, pullModel: vi.fn() };

    // @ts-expect-error persistModel must not exist on RuntimeValidationDependencies
    const _badDeps2: RuntimeValidationDependencies = { ...deps, persistModel: vi.fn() };

    // @ts-expect-error switchModel must not exist on RuntimeValidationDependencies
    const _badDeps3: RuntimeValidationDependencies = { ...deps, switchModel: vi.fn() };

    // @ts-expect-error unloadModel must not exist on RuntimeValidationDependencies
    const _badDeps4: RuntimeValidationDependencies = { ...deps, unloadModel: vi.fn() };

    expect(deps).toBeDefined();
  });
});

describe('deep immutability and snapshot isolation', () => {
  // ---------------------------------------------------------------------------
  // Compile-time public-contract tests
  // ---------------------------------------------------------------------------

  it('prevents compile-time mutation of nested registry profiles in run input', () => {
    const input: RuntimeValidationRunInput = makeRunInput();

    // @ts-expect-error modelId must be deeply readonly
    const _ = () => { input.registry[0].modelId = 'mutated'; };

    expect(_).toBeDefined();
  });

  it('prevents compile-time push into supported runtime and OS arrays', () => {
    const input: RuntimeValidationRunInput = makeRunInput();

    // @ts-expect-error supportedRuntimes must be deeply readonly
    const _ = () => { input.registry[0].supportedRuntimes.push('new-runtime'); };

    // @ts-expect-error supportedOperatingSystems must be deeply readonly
    const _2 = () => { input.registry[0].supportedOperatingSystems.push('new-os'); };

    expect(_).toBeDefined();
    expect(_2).toBeDefined();
  });

  it('prevents compile-time mutation of nested hardware profile values', () => {
    const input: RuntimeValidationRunInput = makeRunInput();

    // @ts-expect-error cpu logicalCores.value must be deeply readonly
    const _ = () => { input.hardwareProfile.cpu.logicalCores.value = 0; };

    // @ts-expect-error gpu device available VRAM must be deeply readonly
    const _2 = () => { input.hardwareProfile.gpuInventory.devices[0].availableVramMib.value = 0; };

    expect(_).toBeDefined();
    expect(_2).toBeDefined();
  });

  it('prevents compile-time mutation of certification identity in observation', () => {
    const observation: RuntimeValidationObservation = makeObservation(makeProfile());

    // @ts-expect-error certificationIdentity must be deeply readonly
    const _ = () => { observation.certificationIdentity.modelDigest = 'mutated'; };

    expect(_).toBeDefined();
  });

  it('prevents compile-time mutation of candidate input snapshots', async () => {
    const profile = makeProfile();
    const validateSpy = vi.fn().mockImplementation((candidateInput: RuntimeValidationCandidateInput) => {
      // @ts-expect-error profile modelId must be deeply readonly
      const _ = () => { candidateInput.profile.modelId = 'mutated'; };

      // @ts-expect-error supportedRuntimes must be deeply readonly
      const _2 = () => { candidateInput.profile.supportedRuntimes.push('new-runtime'); };

      // @ts-expect-error certificationIdentity must be deeply readonly
      const _3 = () => { candidateInput.certificationIdentity.modelDigest = 'mutated'; };

      // @ts-expect-error hardwareProfile cpu must be deeply readonly
      const _4 = () => { candidateInput.hardwareProfile.cpu.logicalCores.value = 0; };

      // @ts-expect-error smoothnessPolicy must be deeply readonly
      const _5 = () => { candidateInput.smoothnessPolicy.warmSampleCount = 99; };

      expect(_).toBeDefined();
      expect(_2).toBeDefined();
      expect(_3).toBeDefined();
      expect(_4).toBeDefined();
      expect(_5).toBeDefined();

      return makeValidatedAttempt(candidateInput.profile);
    });

    const deps = makeDependencies({ validateCandidate: validateSpy });
    await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);
  });

  // ---------------------------------------------------------------------------
  // Runtime alias-isolation tests
  // ---------------------------------------------------------------------------

  it('isolates the registry snapshot from caller mutation', async () => {
    const profile = makeProfile();
    const registry = [profile];
    const deferredValidate = createDeferred<RuntimeValidationAttempt>();
    const selectSpy = vi.fn(selectCertifiedModel);
    const validateSpy = vi.fn().mockReturnValue(deferredValidate.promise);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: validateSpy,
    });

    const run = runRuntimeValidation(makeRunInput({ registry }), deps);

    await Promise.resolve();

    // Mutate the caller's original registry while the run is paused.
    registry[0].modelId = 'mutated';
    (registry[0].certificationIdentity as CertificationIdentity).modelDigest = 'mutated';

    const seenCandidate = validateSpy.mock.calls[0][0] as RuntimeValidationCandidateInput;
    expect(seenCandidate.profile.modelId).toBe('qwen3:8b');
    expect(seenCandidate.certificationIdentity.modelDigest).toBe(DEFAULT_CERTIFICATION_IDENTITY.modelDigest);

    deferredValidate.resolve(makeValidatedAttempt(seenCandidate.profile));
    const result = await run;

    expect(result.kind).toBe('selected');
    expect(selectSpy).toHaveBeenCalledTimes(2);
    const secondCall = selectSpy.mock.calls[1][0];
    expect(secondCall.runtimeValidationEvidence['qwen3:8b'].modelId).toBe('qwen3:8b');
  });

  it('isolates nested profile arrays from caller mutation', async () => {
    const profile = makeProfile();
    const registry = [profile];
    const deferred = createDeferred<RuntimeValidationAttempt>();
    const validateSpy = vi.fn().mockReturnValue(deferred.promise);

    const deps = makeDependencies({ validateCandidate: validateSpy });
    const run = runRuntimeValidation(makeRunInput({ registry }), deps);

    await Promise.resolve();

    profile.supportedRuntimes.push('new-runtime');
    profile.measuredHardwareReferences[0] = 'mutated';

    const seen = validateSpy.mock.calls[0][0] as RuntimeValidationCandidateInput;
    expect(seen.profile.supportedRuntimes).toEqual(['ollama']);
    expect(seen.profile.measuredHardwareReferences).toEqual([
      'NVIDIA GeForce RTX 3070 Ti 8 GB, WDDM, 8192 MiB VRAM, Ollama local runtime',
    ]);

    deferred.resolve(makeValidatedAttempt(seen.profile));
    await run;
  });

  it('isolates the hardware profile snapshot from caller mutation', async () => {
    const profile = makeProfile();
    const hardware = makeHardwareProfile();
    const deferred = createDeferred<RuntimeValidationAttempt>();
    const validateSpy = vi.fn().mockReturnValue(deferred.promise);

    const deps = makeDependencies({ validateCandidate: validateSpy });
    const run = runRuntimeValidation(makeRunInput({ registry: [profile], hardwareProfile: hardware }), deps);

    await Promise.resolve();

    hardware.cpu.logicalCores.value = 0;
    hardware.gpuInventory.devices[0].availableVramMib.value = 0;

    const seen = validateSpy.mock.calls[0][0] as RuntimeValidationCandidateInput;
    expect(seen.hardwareProfile.cpu.logicalCores.value).toBe(8);
    expect(seen.hardwareProfile.gpuInventory.devices[0].availableVramMib.value).toBe(4096);

    deferred.resolve(makeValidatedAttempt(seen.profile));
    await run;
  });

  it('progress observer mutation during run-started cannot alter internal snapshots', async () => {
    const profile = makeProfile();
    const registry = [profile];
    const deferred = createDeferred<RuntimeValidationAttempt>();
    const validateSpy = vi.fn().mockReturnValue(deferred.promise);
    const input = makeRunInput({
      registry,
      onProgress: (event) => {
        if (event.kind === 'run-started') {
          registry[0].modelId = 'mutated-by-observer';
          registry[0].supportedRuntimes.push('observer-runtime');
        }
      },
    });

    const deps = makeDependencies({ validateCandidate: validateSpy });
    const run = runRuntimeValidation(input, deps);

    await Promise.resolve();

    const seen = validateSpy.mock.calls[0][0] as RuntimeValidationCandidateInput;
    expect(seen.profile.modelId).toBe('qwen3:8b');
    expect(seen.profile.supportedRuntimes).toEqual(['ollama']);

    deferred.resolve(makeValidatedAttempt(seen.profile));
    const result = await run;

    expect(result.kind).toBe('selected');
  });

  it('freezes candidate input snapshots so the validator cannot mutate them at runtime', async () => {
    const profile = makeProfile();
    const validateSpy = vi.fn().mockImplementation((candidateInput: RuntimeValidationCandidateInput) => {
      expect(Object.isFrozen(candidateInput.profile)).toBe(true);
      expect(Object.isFrozen(candidateInput.certificationIdentity)).toBe(true);
      expect(Object.isFrozen(candidateInput.hardwareProfile)).toBe(true);
      expect(Object.isFrozen(candidateInput.smoothnessPolicy)).toBe(true);
      expect(Object.isFrozen(candidateInput.profile.supportedRuntimes)).toBe(true);

      expect(() => { (candidateInput as any).profile.modelId = 'mutated'; }).toThrow();
      expect(() => { (candidateInput as any).certificationIdentity.modelDigest = 'mutated'; }).toThrow();
      expect(() => { (candidateInput as any).profile.supportedRuntimes.push('new-runtime'); }).toThrow();
      expect(() => { (candidateInput as any).hardwareProfile.cpu.logicalCores.value = 0; }).toThrow();
      expect(() => { (candidateInput as any).smoothnessPolicy.warmSampleCount = 99; }).toThrow();

      return makeValidatedAttempt(candidateInput.profile);
    });

    const deps = makeDependencies({ validateCandidate: validateSpy });
    await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);
  });

  it('does not freeze or mutate caller-owned inputs', async () => {
    const profile = makeProfile();
    const registry = [profile];
    const hardware = makeHardwareProfile();
    const policy: SmoothnessPolicy = { warmSampleCount: 5, maxP95TrueTTFTMs: 400, maxP95WallClockMs: 1800 };

    await runRuntimeValidation(
      makeRunInput({ registry, hardwareProfile: hardware, smoothnessPolicy: policy }),
      makeDependencies()
    );

    expect(Object.isFrozen(registry)).toBe(false);
    expect(Object.isFrozen(profile)).toBe(false);
    expect(Object.isFrozen(hardware)).toBe(false);
    expect(Object.isFrozen(hardware.cpu)).toBe(false);
    expect(Object.isFrozen(policy)).toBe(false);
  });

  it('isolates validator-returned attempts from later mutation', async () => {
    const profile = makeProfile();
    const attempt = makeValidatedAttempt(profile);
    const deferred = createDeferred<RuntimeValidationAttempt>();
    const selectSpy = vi.fn(selectCertifiedModel);
    const validateSpy = vi.fn().mockReturnValue(deferred.promise);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: validateSpy,
    });

    const run = runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    await Promise.resolve();
    deferred.resolve(attempt);
    await Promise.resolve();

    // Mutate the shared attempt after the orchestrator has received it.
    (attempt as any).observation.modelId = 'mutated';
    (attempt as any).observation.certificationIdentity.modelDigest = 'mutated';
    (attempt as any).observation.smoothnessOk = false;

    const result = await run;

    expect(result.kind).toBe('selected');
    expect(selectSpy).toHaveBeenCalledTimes(2);
    const evidence = selectSpy.mock.calls[1][0].runtimeValidationEvidence['qwen3:8b'];
    expect(evidence.modelId).toBe('qwen3:8b');
    expect(evidence.smoothnessOk).toBe(true);
  });

  it('still uses original snapshot values for evidence when caller mutates originals', async () => {
    const profile = makeProfile();
    const registry = [profile];
    const deferred = createDeferred<RuntimeValidationAttempt>();
    const validateSpy = vi.fn().mockReturnValue(deferred.promise);

    const deps = makeDependencies({ validateCandidate: validateSpy });
    const run = runRuntimeValidation(makeRunInput({ registry }), deps);

    await Promise.resolve();

    // Mutate the original profile's identity-related fields while the run is paused.
    profile.modelId = 'mutated';
    (profile.certificationIdentity as CertificationIdentity).modelDigest = 'mutated';

    const seen = validateSpy.mock.calls[0][0] as RuntimeValidationCandidateInput;
    expect(seen.profile.modelId).toBe('qwen3:8b');
    expect(seen.certificationIdentity.modelDigest).toBe(DEFAULT_CERTIFICATION_IDENTITY.modelDigest);

    deferred.resolve(makeValidatedAttempt(seen.profile));
    const result = await run;

    expect(result.kind).toBe('selected');
  });

  it('freezes validationOrder in the defensive initial-selected return path', async () => {
    const selected = makeProfile({ modelId: 'qwen3:8b', ollamaTag: 'qwen3:8b' });
    const pending = makeProfile({
      modelId: 'fallback:8b',
      ollamaTag: 'fallback:8b',
      fallbackPriority: 2,
    });

    const selectedResult: ModelSelectionResult = {
      kind: 'selected',
      selected,
      fallbackOrder: [],
      validationOrder: [pending],
      dispositions: [],
      reason: 'defensive initial selection with no evidence',
    };

    const validateSpy = vi.fn();
    const selectSpy = vi.fn().mockReturnValue(selectedResult);
    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: validateSpy,
    });

    const result = await runRuntimeValidation(
      makeRunInput({ registry: [selected, pending] }),
      deps
    );

    expect(result.kind).toBe('selected');
    expect(validateSpy).not.toHaveBeenCalled();
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('qwen3:8b');
      expect(result.validationOrder.map((p) => p.modelId)).toEqual([
        'qwen3:8b',
        'fallback:8b',
      ]);
      expect(result.validationOrder).toHaveLength(2);

      expect(Object.isFrozen(result.validationOrder)).toBe(true);

      expect(() => {
        (result.validationOrder as any).push(
          makeProfile({ modelId: 'extra:8b', ollamaTag: 'extra:8b' })
        );
      }).toThrow();

      expect(() => {
        (result.validationOrder as any)[0].modelId = 'mutated';
      }).toThrow();

      expect(result.validationOrder.map((p) => p.modelId)).toEqual([
        'qwen3:8b',
        'fallback:8b',
      ]);
      expect(result.validationOrder).toHaveLength(2);
    }
  });
});
