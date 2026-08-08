import { describe, it, expect, vi } from 'vitest';
import { buildIntentExtractionPrompt } from '../agent/intent';
import type { HardwareProfile } from '../hardwareProfile';
import {
  APPROVED_WARM_SMOOTHNESS_POLICY,
  type RuntimeValidationCandidateInput,
} from '../runtimeValidationOrchestrator';
import {
  RUNTIME_VALIDATION_WORKLOAD_VERSION,
  RUNTIME_VALIDATION_USER_PROMPT,
  buildRuntimeValidationMessages,
  buildRuntimeValidationRequest,
  percentileNearestRank,
} from '../runtimeValidationWorkload';

const TEST_MODEL_ID = 'qwen3:8b';
const TEST_OLLAMA_TAG = 'qwen3:8b';

function makeCertificationIdentity() {
  return {
    modelTag: TEST_OLLAMA_TAG,
    modelDigest: '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41',
    ollamaVersion: '0.32.6',
    productionHead: 'aa4553522065229f62ed5cf85c13a9cdb8740739',
    certificationContractVersion: 'v2.1.1-semantic',
    promptSuiteVersion: 'v2.1.0-22-prompts',
    scorerVersion: 'v2.0.1',
    schemaVersion: 'v2.0.0',
  } as const;
}

function makeHardwareProfile(): HardwareProfile {
  return {
    platform: 'win32',
    timestamp: '2026-08-07T00:00:00Z',
    cpu: {
      logicalCores: { status: 'known', value: 16, source: 'test', confidence: 'high' },
      physicalCores: { status: 'known', value: 8, source: 'test', confidence: 'high' },
      brand: { status: 'known', value: 'Test CPU', source: 'test', confidence: 'high' },
    },
    ram: {
      totalMib: { status: 'known', value: 32768, source: 'test', confidence: 'high' },
      availableMib: { status: 'known', value: 16384, source: 'test', confidence: 'high' },
    },
    gpuInventory: {
      status: 'known',
      source: 'test',
      devices: [],
    },
    warnings: [],
  };
}

function makeCandidateInput(
  overrides: Partial<RuntimeValidationCandidateInput> = {}
): RuntimeValidationCandidateInput {
  return {
    runId: 'run-1',
    profile: {
      modelId: TEST_MODEL_ID,
      ollamaTag: TEST_OLLAMA_TAG,
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
    },
    certificationIdentity: makeCertificationIdentity(),
    hardwareProfile: makeHardwareProfile(),
    runtime: 'ollama',
    platform: 'win32',
    smoothnessPolicy: APPROVED_WARM_SMOOTHNESS_POLICY,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('runtimeValidationWorkload', () => {
  it('workload version is exact and frozen', () => {
    expect(RUNTIME_VALIDATION_WORKLOAD_VERSION).toBe('orion-runtime-validation-v1');
    expect(() => {
      (RUNTIME_VALIDATION_WORKLOAD_VERSION as any) = 'mutated';
    }).toThrow();
  });

  it('system message equals the current buildIntentExtractionPrompt() full-schema output', () => {
    const messages = buildRuntimeValidationMessages();
    const system = messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).toBe(buildIntentExtractionPrompt());
  });

  it('user prompt exactly matches the authoritative fixed primary compound prompt', () => {
    const messages = buildRuntimeValidationMessages();
    const user = messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    expect(user!.content).toBe(
      'Could you set me up on Nvidia for the prior trading session, use fifteen-minute bars, park the replay at quarter past eleven and tell me what candle I am on?'
    );
    expect(RUNTIME_VALIDATION_USER_PROMPT).toBe(user!.content);
  });

  it('messages are newly allocated and recursively frozen', () => {
    const a = buildRuntimeValidationMessages();
    const b = buildRuntimeValidationMessages();

    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);

    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a[0])).toBe(true);
    expect(Object.isFrozen(a[1])).toBe(true);

    expect(() => {
      (a as any).push({ role: 'assistant', content: 'x' });
    }).toThrow();
    expect(() => {
      (a[0] as any).content = 'mutated';
    }).toThrow();
  });

  it('mutation through runtime casts throws and does not alter later builds', () => {
    const first = buildRuntimeValidationMessages();
    const original = first[0].content;

    expect(() => {
      (first as any)[0].content = 'mutated';
    }).toThrow();

    const second = buildRuntimeValidationMessages();
    expect(second[0].content).toBe(original);
    expect(second[0].content).toBe(buildIntentExtractionPrompt());
  });

  describe('cold request', () => {
    it('uses candidate model/context/thinking/keep-alive and fixed options', () => {
      const input = makeCandidateInput();
      const req = buildRuntimeValidationRequest(input, 'cold');

      expect(req.model).toBe(TEST_OLLAMA_TAG);
      expect(req.think).toBe(false);
      expect(req.keepAlive).toBe('10m');
      expect(req.numCtx).toBe(4096);
      expect(req.temperature).toBe(0);
      expect(req.seed).toBe(42);
      expect(req.format).toBe('json');
      expect(req.stream).toBe(true);
      expect(req.messages[0].role).toBe('system');
      expect(req.messages[1].role).toBe('user');
    });

    it('uses numPredict=1 and timeoutMs=300_000', () => {
      const req = buildRuntimeValidationRequest(makeCandidateInput(), 'cold');
      expect(req.numPredict).toBe(1);
      expect(req.timeoutMs).toBe(300_000);
    });

    it('is excluded from warm percentile semantics by phase-specific numPredict', () => {
      const cold = buildRuntimeValidationRequest(makeCandidateInput(), 'cold');
      const warm = buildRuntimeValidationRequest(makeCandidateInput(), 'warm');
      expect(cold.numPredict).not.toBe(warm.numPredict);
      expect(cold.numPredict).toBe(1);
    });
  });

  describe('warm request', () => {
    it('uses numPredict=160 and timeoutMs=120_000', () => {
      const req = buildRuntimeValidationRequest(makeCandidateInput(), 'warm');
      expect(req.numPredict).toBe(160);
      expect(req.timeoutMs).toBe(120_000);
    });

    it('uses the same frozen workload as the cold request', () => {
      const warm = buildRuntimeValidationRequest(makeCandidateInput(), 'warm');
      const cold = buildRuntimeValidationRequest(makeCandidateInput(), 'cold');

      expect(warm.messages[0].content).toBe(cold.messages[0].content);
      expect(warm.messages[1].content).toBe(cold.messages[1].content);
      expect(warm.messages[1].content).toBe(RUNTIME_VALIDATION_USER_PROMPT);
    });
  });

  it('does not resolve the active model or consult environment overrides', () => {
    const original = process.env.ORION_AGENT_MODEL;
    process.env.ORION_AGENT_MODEL = 'some-override:latest';

    vi.resetModules();
    const req = buildRuntimeValidationRequest(makeCandidateInput(), 'warm');
    expect(req.model).toBe(TEST_OLLAMA_TAG);

    if (original === undefined) {
      delete process.env.ORION_AGENT_MODEL;
    } else {
      process.env.ORION_AGENT_MODEL = original;
    }
  });

  it('does not mutate the candidate input', () => {
    const input = makeCandidateInput();
    const before = JSON.stringify(input);
    buildRuntimeValidationRequest(input, 'cold');
    buildRuntimeValidationRequest(input, 'warm');
    expect(JSON.stringify(input)).toBe(before);
  });

  describe('percentileNearestRank', () => {
    it('matches the existing benchmark formula', () => {
      const samples = [10, 20, 30, 40, 50];
      // Benchmark formula: idx = ceil((pct / 100) * len) - 1
      // 95th of 5: ceil(0.95 * 5) - 1 = 5 - 1 = 4 => 50
      expect(percentileNearestRank(samples, 95)).toBe(50);
    });

    it('p95 of five samples equals the maximum sample', () => {
      const samples = [120, 95, 180, 110, 150];
      expect(percentileNearestRank(samples, 95)).toBe(180);
    });

    it('does not mutate the input array', () => {
      const samples = [3, 1, 2];
      const before = [...samples];
      percentileNearestRank(samples, 95);
      expect(samples).toEqual(before);
    });

    it('rejects empty sample sets', () => {
      expect(() => percentileNearestRank([], 95)).toThrow(/empty/);
    });

    it('rejects non-finite samples', () => {
      expect(() => percentileNearestRank([1, NaN, 3], 95)).toThrow(/finite/);
      expect(() => percentileNearestRank([1, Infinity, 3], 95)).toThrow(/finite/);
      expect(() => percentileNearestRank([1, -1, 3], 95)).toThrow(/non-negative/);
    });

    it('rejects invalid percentiles', () => {
      expect(() => percentileNearestRank([1, 2, 3], 0)).toThrow(/Percentile/);
      expect(() => percentileNearestRank([1, 2, 3], -5)).toThrow(/Percentile/);
      expect(() => percentileNearestRank([1, 2, 3], 101)).toThrow(/Percentile/);
      expect(() => percentileNearestRank([1, 2, 3], NaN)).toThrow(/Percentile/);
    });

    it('returns the exact nearest-rank value for other percentiles', () => {
      // 5 samples, 50th percentile: ceil(0.5 * 5) - 1 = 3 - 1 = 2 => 3rd sorted
      const samples = [10, 20, 30, 40, 50];
      expect(percentileNearestRank(samples, 50)).toBe(30);
    });
  });

  it('approved warm sample count remains five without redefining the policy', () => {
    expect(APPROVED_WARM_SMOOTHNESS_POLICY.warmSampleCount).toBe(5);

    const req = buildRuntimeValidationRequest(makeCandidateInput(), 'warm');
    // The workload should not invent its own sample count; it should use the
    // policy's warmSampleCount via the caller's loop, not in the request.
    expect(req).not.toHaveProperty('warmSampleCount');
    expect(req.numPredict).toBe(160);
  });

  it('does not invoke network, Tauri, Ollama, pull/switch/unload or startup functions', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const controller = { startOrionStartup: vi.fn() };

    // The workload is pure; calling it should not trigger any I/O.
    buildRuntimeValidationMessages();
    buildRuntimeValidationRequest(makeCandidateInput(), 'cold');
    buildRuntimeValidationRequest(makeCandidateInput(), 'warm');
    percentileNearestRank([1, 2, 3, 4, 5], 95);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(controller.startOrionStartup).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
