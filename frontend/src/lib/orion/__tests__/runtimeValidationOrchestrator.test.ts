import { describe, it, expect, vi } from 'vitest';
import {
  runRuntimeValidation,
  type RuntimeValidationRunInput,
  type RuntimeValidationDependencies,
  type RuntimeValidationAttempt,
  type RuntimeValidationAttemptValidated,
  type RuntimeValidationAttemptFailed,
  type RuntimeValidationProgressEvent,
  type SmoothnessPolicy,
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

const DEFAULT_SMOOTHNESS: SmoothnessPolicy = {
  warmSampleCount: 5,
  maxP95TrueTTFTMs: 400,
  maxP95WallClockMs: 1800,
};

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
    certificationIdentity: DEFAULT_CERTIFICATION_IDENTITY,
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

function makeEvidence(
  profile: CertifiedModelProfile,
  overrides: Partial<RuntimeValidationEvidence> = {}
): RuntimeValidationEvidence {
  return {
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
    oom: false,
    cpuOffload: false,
    evicted: false,
    smoothnessOk: true,
    ...overrides,
  };
}

function makeValidatedAttempt(
  profile: CertifiedModelProfile,
  overrides: { evidence?: Partial<RuntimeValidationEvidence>; certificationIdentity?: CertificationIdentity } = {}
): RuntimeValidationAttemptValidated {
  return {
    kind: 'validated',
    evidence: makeEvidence(profile, overrides.evidence),
    certificationIdentity: overrides.certificationIdentity ?? (profile.certificationIdentity as CertificationIdentity),
  };
}

function makeFailedAttempt(
  profile: CertifiedModelProfile,
  overrides: { evidence?: Partial<RuntimeValidationEvidence>; certificationIdentity?: CertificationIdentity } = {}
): RuntimeValidationAttemptFailed {
  return {
    kind: 'failed',
    evidence: makeEvidence(profile, { smoothnessOk: false, ...overrides.evidence }),
    certificationIdentity: overrides.certificationIdentity ?? (profile.certificationIdentity as CertificationIdentity),
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
    smoothnessPolicy: DEFAULT_SMOOTHNESS,
    signal: controller.signal,
    ...overrides,
  };
}

function makeDependencies(overrides: Partial<RuntimeValidationDependencies> = {}): RuntimeValidationDependencies {
  return {
    selectCertifiedModel,
    validateCandidate: vi.fn().mockRejectedValue(new Error('no validator configured')),
    acquireLease: vi.fn().mockResolvedValue({ release: vi.fn() }),
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
  it('invokes the selector with no fabricated evidence to determine the validation order', async () => {
    const a = makeProfile({ modelId: 'qwen3:8b', fallbackPriority: 0 });
    const b = makeProfile({ modelId: 'qwen3:second', fallbackPriority: 1 });

    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockImplementation(async (profile) => makeValidatedAttempt(profile)),
    });

    const input = makeRunInput({ registry: [a, b] });
    const result = await runRuntimeValidation(input, deps);

    expect(result.kind).toBe('selected');
    expect(selectSpy).toHaveBeenCalledTimes(2);
    expect(selectSpy.mock.calls[0][0]).toEqual(
      expect.objectContaining({ runtimeValidationEvidence: {} })
    );
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('qwen3:8b');
      expect(result.validationOrder.map((p) => p.modelId)).toEqual(['qwen3:second']);
    }
  });

  it('attempts candidates only in the signed-off selector validation order', async () => {
    const a = makeProfile({ modelId: 'model-a', fallbackPriority: 0 });
    const b = makeProfile({ modelId: 'model-b', fallbackPriority: 1 });
    const order: string[] = [];

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockImplementation(async (profile) => {
        order.push(profile.modelId);
        if (profile.modelId === 'model-a') {
          return makeFailedAttempt(profile); // fail first, continue to second
        }
        return makeValidatedAttempt(profile);
      }),
    });

    const input = makeRunInput({ registry: [b, a] }); // registry order reversed
    const result = await runRuntimeValidation(input, deps);

    expect(result.kind).toBe('selected');
    expect(order).toEqual(['model-a', 'model-b']); // selector orders by fallbackPriority
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('model-b');
    }
  });

  it('stops after the first positively selected candidate', async () => {
    const a = makeProfile({ modelId: 'qwen3:8b', fallbackPriority: 0 });
    const b = makeProfile({ modelId: 'qwen3:second', fallbackPriority: 1 });

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockImplementation(async (profile) => {
        return makeValidatedAttempt(profile);
      }),
    });

    const input = makeRunInput({ registry: [a, b] });
    const result = await runRuntimeValidation(input, deps);

    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('qwen3:8b');
      expect(result.fallbackOrder).toHaveLength(0);
      expect(result.validationOrder.map((p) => p.modelId)).toEqual(['qwen3:second']);
    }
    expect(deps.validateCandidate).toHaveBeenCalledTimes(1);
  });

  it('preserves the remaining validation order without mislabeling it', async () => {
    const a = makeProfile({ modelId: 'qwen3:8b', fallbackPriority: 0 });
    const b = makeProfile({ modelId: 'qwen3:second', fallbackPriority: 1 });
    const c = makeProfile({ modelId: 'qwen3:third', fallbackPriority: 2 });

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockImplementation(async (profile) => makeValidatedAttempt(profile)),
    });

    const input = makeRunInput({ registry: [c, b, a] });
    const result = await runRuntimeValidation(input, deps);

    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.validationOrder.map((p) => p.modelId)).toEqual(['qwen3:second', 'qwen3:third']);
    }
  });

  it('returns action-required for a missing installed model and produces no evidence', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue({
        kind: 'action-required',
        reason: 'not-installed',
        diagnostics: { modelId: profile.modelId, ollamaTag: profile.ollamaTag, runId: DEFAULT_RUN_ID },
      } as RuntimeValidationAttempt),
    });

    const input = makeRunInput({ registry: [profile] });
    const result = await runRuntimeValidation(input, deps);

    expect(result.kind).toBe('action-required');
    if (result.kind === 'action-required') {
      expect(result.modelId).toBe('qwen3:8b');
      expect(result.reason).toBe('not-installed');
      expect(result.action).toBe('install-consent');
    }

    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeValidationEvidence: {} })
    );
  });

  it('returns action-required for wrong digest and produces no evidence', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue({
        kind: 'action-required',
        reason: 'wrong-digest',
        diagnostics: { modelId: profile.modelId, ollamaTag: profile.ollamaTag, runId: DEFAULT_RUN_ID },
      } as RuntimeValidationAttempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('action-required');
    if (result.kind === 'action-required') {
      expect(result.action).toBe('re-pull-consent');
    }
    expect(selectSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeValidationEvidence: {} })
    );
  });

  it('returns action-required for unsupported/unverified Ollama version and produces no evidence', async () => {
    const profile = makeProfile();

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue({
        kind: 'action-required',
        reason: 'unsupported-ollama-version',
        diagnostics: { modelId: profile.modelId, ollamaTag: profile.ollamaTag, runId: DEFAULT_RUN_ID },
      } as RuntimeValidationAttempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('action-required');
    if (result.kind === 'action-required') {
      expect(result.action).toBe('update-ollama');
    }
  });

  it('returns inconclusive for generic ambiguous failure and makes no OOM claim', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue({
        kind: 'inconclusive',
        reason: 'ambiguous engine failure: HTTP 500',
        diagnostics: { modelId: profile.modelId, ollamaTag: profile.ollamaTag, runId: DEFAULT_RUN_ID },
      } as RuntimeValidationAttempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'inconclusive') {
      expect(result.reason).toContain('ambiguous engine failure');
    }
    expect(selectSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeValidationEvidence: {} })
    );
  });

  it('returns inconclusive for unavailable or malformed residency observation', async () => {
    const profile = makeProfile();

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue({
        kind: 'inconclusive',
        reason: '/api/ps unavailable; cannot determine residency',
        diagnostics: { modelId: profile.modelId, ollamaTag: profile.ollamaTag, runId: DEFAULT_RUN_ID },
      } as RuntimeValidationAttempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    expect(result).toEqual(expect.objectContaining({ reason: expect.stringContaining('/api/ps unavailable') }));
  });

  it('does not let partial diagnostics enter selector evidence', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockResolvedValue({
        kind: 'inconclusive',
        reason: 'incomplete observation',
        diagnostics: {
          modelId: profile.modelId,
          ollamaTag: profile.ollamaTag,
          runId: DEFAULT_RUN_ID,
          stages: ['started'],
          error: 'partial',
        },
      } as RuntimeValidationAttempt),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(selectSpy).toHaveBeenCalledTimes(1);
    const lastCall = selectSpy.mock.calls[selectSpy.mock.calls.length - 1][0];
    expect(Object.keys(lastCall.runtimeValidationEvidence ?? {})).toHaveLength(0);
  });

  it('only passes complete identity-bound evidence to the selector', async () => {
    const profile = makeProfile();
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: vi.fn().mockImplementation(async (p) => makeValidatedAttempt(p)),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('selected');
    expect(selectSpy).toHaveBeenCalledTimes(2);
    const secondCall = selectSpy.mock.calls[1][0];
    expect(secondCall.runtimeValidationEvidence[profile.modelId]).toEqual(
      expect.objectContaining({
        modelId: profile.modelId,
        ollamaTag: profile.ollamaTag,
        comparisonGroupId: DEFAULT_RUN_ID,
        smoothnessOk: true,
      })
    );
  });

  it('rejects mismatched candidate identity as inconclusive', async () => {
    const profile = makeProfile();

    const attempt = makeValidatedAttempt(profile, {
      evidence: { modelId: 'impostor', ollamaTag: 'impostor' },
    });

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'inconclusive') {
      expect(result.reason).toContain('modelId mismatch');
    }
  });

  it('rejects mismatched certification identity as inconclusive', async () => {
    const profile = makeProfile();

    const attempt = makeValidatedAttempt(profile, {
      certificationIdentity: makeCertificationIdentity({ ollamaVersion: '0.99.9' }),
    });

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'inconclusive') {
      expect(result.reason).toContain('certificationIdentity tuple mismatch');
    }
  });

  it('allows complete smoothness failure to become authoritative negative evidence', async () => {
    const profile = makeProfile();

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockImplementation(async (p) => makeFailedAttempt(p)),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('runtime-validation-failed');
  });

  it('permits optional whole-app memory to be absent from evidence', async () => {
    const profile = makeProfile();

    const attempt = makeValidatedAttempt(profile, {
      evidence: { measuredWholeAppPeakMemoryMiB: undefined },
    });

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('qwen3:8b');
    }
  });

  it('cancels before acquisition and calls neither selector nor validator', async () => {
    const controller = new AbortController();
    controller.abort();

    const selectSpy = vi.fn(selectCertifiedModel);
    const validateSpy = vi.fn();

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: validateSpy,
    });

    const result = await runRuntimeValidation(makeRunInput({ signal: controller.signal }), deps);

    expect(result.kind).toBe('cancelled-stale');
    expect(selectSpy).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('returns no authoritative selection when cancelled while validation is pending', async () => {
    const controller = new AbortController();
    const deferredValidate = createDeferred<RuntimeValidationAttempt>();
    const profile = makeProfile();

    const validateSpy = vi.fn().mockReturnValue(deferredValidate.promise);
    const selectSpy = vi.fn(selectCertifiedModel);

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: validateSpy,
    });

    const run = runRuntimeValidation(makeRunInput({ signal: controller.signal, registry: [profile] }), deps);

    // Let the orchestrator reach the validator's pending promise.
    await Promise.resolve();

    controller.abort();
    deferredValidate.resolve(makeValidatedAttempt(profile));

    const result = await run;

    expect(result.kind).toBe('cancelled-stale');
    expect(selectSpy).toHaveBeenCalledTimes(1); // initial call only
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it('returns no authoritative selection when stale before validation', async () => {
    const deps = makeDependencies({
      isCurrent: () => false,
    });

    const result = await runRuntimeValidation(makeRunInput(), deps);

    expect(result.kind).toBe('cancelled-stale');
    expect(result).toEqual(expect.objectContaining({ reason: 'stale' }));
  });

  it('returns no authoritative selection when stale after a complete attempt', async () => {
    const profile = makeProfile();
    let stale = false;

    const deps = makeDependencies({
      isCurrent: () => !stale,
      validateCandidate: vi.fn().mockImplementation(async (p) => {
        stale = true;
        return makeValidatedAttempt(p);
      }),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('cancelled-stale');
    expect(result).toEqual(expect.objectContaining({ reason: 'stale' }));
  });

  it('returns inconclusive when the model-work lease is busy', async () => {
    const selectSpy = vi.fn(selectCertifiedModel);
    const validateSpy = vi.fn();

    const deps = makeDependencies({
      selectCertifiedModel: selectSpy,
      validateCandidate: validateSpy,
      acquireLease: vi.fn().mockResolvedValue('busy'),
    });

    const result = await runRuntimeValidation(makeRunInput(), deps);

    expect(result.kind).toBe('inconclusive');
    expect(result).toEqual(expect.objectContaining({ reason: expect.stringContaining('lease busy') }));
    expect(selectSpy).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('releases the lease exactly once after success', async () => {
    const profile = makeProfile();
    const release = vi.fn();

    const deps = makeDependencies({
      acquireLease: vi.fn().mockResolvedValue({ release }),
      validateCandidate: vi.fn().mockImplementation(async (p) => makeValidatedAttempt(p)),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease exactly once after action-required', async () => {
    const profile = makeProfile();
    const release = vi.fn();

    const deps = makeDependencies({
      acquireLease: vi.fn().mockResolvedValue({ release }),
      validateCandidate: vi.fn().mockResolvedValue({
        kind: 'action-required',
        reason: 'not-installed',
        diagnostics: { modelId: profile.modelId, ollamaTag: profile.ollamaTag, runId: DEFAULT_RUN_ID },
      } as RuntimeValidationAttempt),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease exactly once after inconclusive', async () => {
    const profile = makeProfile();
    const release = vi.fn();

    const deps = makeDependencies({
      acquireLease: vi.fn().mockResolvedValue({ release }),
      validateCandidate: vi.fn().mockResolvedValue({
        kind: 'inconclusive',
        reason: 'oops',
        diagnostics: { modelId: profile.modelId, ollamaTag: profile.ollamaTag, runId: DEFAULT_RUN_ID },
      } as RuntimeValidationAttempt),
    });

    await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease exactly once after cancellation', async () => {
    const controller = new AbortController();
    const deferredLease = createDeferred<import('../runtimeValidationOrchestrator').ModelWorkLease>();
    const deferredValidate = createDeferred<RuntimeValidationAttempt>();
    const release = vi.fn();

    const deps = makeDependencies({
      acquireLease: vi.fn().mockReturnValue(deferredLease.promise),
      validateCandidate: vi.fn().mockReturnValue(deferredValidate.promise),
    });

    const run = runRuntimeValidation(makeRunInput({ signal: controller.signal }), deps);

    // Let the orchestrator reach the validator's pending promise.
    await Promise.resolve();

    controller.abort();
    deferredLease.resolve({ release });
    deferredValidate.resolve(makeValidatedAttempt(makeProfile()));

    await run;

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease exactly once when a dependency throws', async () => {
    const release = vi.fn();

    const deps = makeDependencies({
      acquireLease: vi.fn().mockResolvedValue({ release }),
      validateCandidate: vi.fn().mockRejectedValue(new Error('validator boom')),
    });

    await runRuntimeValidation(makeRunInput(), deps);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('emits progress events in the actual state transition order', async () => {
    const profile = makeProfile();
    const events: RuntimeValidationProgressEvent[] = [];

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockImplementation(async (p) => makeValidatedAttempt(p)),
    });

    const input = makeRunInput({
      registry: [profile],
      onProgress: (e) => events.push(e),
    });

    await runRuntimeValidation(input, deps);

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

  it('does not expose pull, persist, switch or unload dependencies', () => {
    const deps = makeDependencies();
    expect(deps).not.toHaveProperty('pullModel');
    expect(deps).not.toHaveProperty('persistModel');
    expect(deps).not.toHaveProperty('switchModel');
    expect(deps).not.toHaveProperty('releaseModel');
    expect(deps).not.toHaveProperty('unloadModel');
  });

  it('selects the single current certified candidate without speculative fallback behavior', async () => {
    const profile = makeProfile();

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockImplementation(async (p) => makeValidatedAttempt(p)),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('qwen3:8b');
      expect(result.fallbackOrder).toHaveLength(0);
      expect(result.validationOrder).toHaveLength(0);
    }
    expect(deps.validateCandidate).toHaveBeenCalledTimes(1);
  });

  it('uses the approved warm smoothness policy from the run input', async () => {
    const profile = makeProfile();
    const validateSpy = vi.fn().mockImplementation(async (p, runInput) => {
      expect(runInput.smoothnessPolicy.warmSampleCount).toBe(5);
      expect(runInput.smoothnessPolicy.maxP95TrueTTFTMs).toBe(400);
      expect(runInput.smoothnessPolicy.maxP95WallClockMs).toBe(1800);
      return makeValidatedAttempt(p);
    });

    const deps = makeDependencies({ validateCandidate: validateSpy });
    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('selected');
  });

  it('rejects incomplete evidence with missing mandatory fields as inconclusive', async () => {
    const profile = makeProfile();
    const attempt = makeValidatedAttempt(profile, {
      evidence: { smoothnessOk: undefined as any },
    });

    const deps = makeDependencies({
      validateCandidate: vi.fn().mockResolvedValue(attempt),
    });

    const result = await runRuntimeValidation(makeRunInput({ registry: [profile] }), deps);

    expect(result.kind).toBe('inconclusive');
    if (result.kind === 'inconclusive') {
      expect(result.reason).toContain('smoothnessOk');
    }
  });

});
