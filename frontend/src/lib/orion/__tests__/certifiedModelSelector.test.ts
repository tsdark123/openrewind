import { describe, it, expect, vi } from 'vitest';
import {
  selectCertifiedModel,
  type CertifiedModelSelectorInput,
  type RuntimeValidationEvidence,
  type CandidateDisposition,
} from '../certifiedModelSelector';
import type { CertifiedModelProfile } from '../certifiedModels';

const DEFAULT_RUNTIME = 'ollama';
const DEFAULT_PLATFORM = 'win32';

function makeProfile(overrides: Partial<CertifiedModelProfile> = {}): CertifiedModelProfile {
  return {
    modelId: 'qwen3:8b',
    ollamaTag: 'qwen3:8b',
    certificationVersion: 'orion-runtime-validation-2026-08-04',
    benchmarkSuiteVersion: 'frontend/benchmark/orion @ 9b8206d5fdfb16fb02fc8d8ad2b9e288b97b7cca',
    certified: true,
    certificationDate: '2026-08-04',
    controlledContextSize: 4096,
    thinking: false,
    keepAlive: '10m',
    supportedRuntimes: ['ollama'],
    supportedOperatingSystems: ['win32'],
    fallbackPriority: 0,
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
    conservativeRecommendedHardware: 'Measured on NVIDIA GeForce RTX 3070 Ti 8 GB. Universal minimum envelope is unresolved.',
    measuredHardwareReferences: ['NVIDIA GeForce RTX 3070 Ti 8 GB, WDDM, 8192 MiB VRAM, Ollama local runtime'],
    ...overrides,
  } as unknown as CertifiedModelProfile;
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
    comparisonGroupId: 'group-a',
    loadSuccess: true,
    oom: false,
    cpuOffload: false,
    evicted: false,
    smoothnessOk: true,
    ...overrides,
  } as RuntimeValidationEvidence;
}

function select(input: Partial<CertifiedModelSelectorInput> & Pick<CertifiedModelSelectorInput, 'registry'>) {
  return selectCertifiedModel({
    runtime: DEFAULT_RUNTIME,
    platform: DEFAULT_PLATFORM,
    runtimeValidationEvidence: {},
    ...input,
  });
}

function getDisposition(dispositions: CandidateDisposition[], modelId: string) {
  return dispositions.find((d) => d.modelId === modelId);
}

describe('selectCertifiedModel', () => {
  it('returns no-certified-profiles for an empty valid registry', () => {
    const result = select({ registry: [] });
    expect(result.kind).toBe('no-certified-profiles');
    expect('fallbackOrder' in result).toBe(false);
  });

  it('returns invalid-input for a malformed registry', () => {
    const result = select({ registry: 'not an array' as any });
    expect(result.kind).toBe('invalid-input');
    if (result.kind === 'invalid-input') {
      expect(result.issues).toContain('registry must be an array');
    }
  });

  it('returns no-certified-profiles when registry contains only uncertified profiles', () => {
    const result = select({
      registry: [makeProfile({ modelId: 'qwen3:4b-instruct', certified: false })],
    });
    expect(result.kind).toBe('no-certified-profiles');
    if (result.kind === 'no-certified-profiles') {
      const d = getDisposition(result.dispositions, 'qwen3:4b-instruct');
      expect(d?.codes).toContain('uncertified');
    }
  });

  it('returns validation-required for one pending certified candidate', () => {
    const profile = makeProfile();
    const result = select({ registry: [profile] });
    expect(result.kind).toBe('validation-required');
    if (result.kind === 'validation-required') {
      expect(result.validationOrder).toHaveLength(1);
      expect(result.validationOrder[0].modelId).toBe('qwen3:8b');
      expect(result.fallbackOrder).toHaveLength(0);
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('validation-pending');
    }
  });

  it('selects one positively validated candidate with an empty fallback', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile);
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: { [profile.modelId]: evidence },
    });
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('qwen3:8b');
      expect(result.fallbackOrder).toHaveLength(0);
      expect(result.validationOrder).toHaveLength(0);
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('validation-passed');
    }
  });

  it('returns runtime-validation-failed when the only candidate OOMs', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile, { oom: true, smoothnessOk: false });
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: { [profile.modelId]: evidence },
    });
    expect(result.kind).toBe('runtime-validation-failed');
    if (result.kind === 'runtime-validation-failed') {
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('oom');
    }
  });

  it('returns no-compatible-certified for an incompatible runtime', () => {
    const result = select({
      registry: [makeProfile()],
      runtime: 'llamafile',
    });
    expect(result.kind).toBe('no-compatible-certified');
    if (result.kind === 'no-compatible-certified') {
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('runtime-incompatible');
    }
  });

  it('returns no-compatible-certified for an incompatible platform', () => {
    const result = select({
      registry: [makeProfile()],
      platform: 'linux',
    });
    expect(result.kind).toBe('no-compatible-certified');
    if (result.kind === 'no-compatible-certified') {
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('platform-incompatible');
    }
  });

  it('never selects or fallbacks to an uncertified profile', () => {
    const certified = makeProfile({ modelId: 'qwen3:8b' });
    const uncertified = makeProfile({ modelId: 'qwen3:4b-instruct', certified: false });
    const result = select({
      registry: [uncertified, certified],
      runtimeValidationEvidence: { [certified.modelId]: makeEvidence(certified) },
    });
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('qwen3:8b');
      expect(result.fallbackOrder).toHaveLength(0);
      const d = getDisposition(result.dispositions, 'qwen3:4b-instruct');
      expect(d?.codes).toContain('uncertified');
    }
  });

  it('selects the validated lower-ranked candidate over a pending higher-ranked one', () => {
    const lower = makeProfile({
      modelId: 'low-model',
      ollamaTag: 'low-model',
      primaryPromptPassRate: 0.95,
    });
    const higher = makeProfile({
      modelId: 'high-model',
      ollamaTag: 'high-model',
      primaryPromptPassRate: 1.0,
    });
    const evidence = makeEvidence(lower);
    const result = select({
      registry: [higher, lower],
      runtimeValidationEvidence: { [lower.modelId]: evidence },
    });
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('low-model');
      expect(result.validationOrder).toHaveLength(1);
      expect(result.validationOrder[0].modelId).toBe('high-model');
    }
  });

  it('excludes a failed top candidate and selects a validated second candidate', () => {
    const top = makeProfile({
      modelId: 'top-model',
      ollamaTag: 'top-model',
      primaryPromptPassRate: 1.0,
    });
    const second = makeProfile({
      modelId: 'second-model',
      ollamaTag: 'second-model',
      primaryPromptPassRate: 0.95,
    });
    const result = select({
      registry: [top, second],
      runtimeValidationEvidence: {
        [top.modelId]: makeEvidence(top, { oom: true, smoothnessOk: false }),
        [second.modelId]: makeEvidence(second),
      },
    });
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('second-model');
      expect(result.fallbackOrder).toHaveLength(0);
      const topD = getDisposition(result.dispositions, 'top-model');
      expect(topD?.codes).toContain('oom');
    }
  });

  it('returns runtime-validation-failed when all compatible candidates fail', () => {
    const a = makeProfile({ modelId: 'a', ollamaTag: 'a' });
    const b = makeProfile({ modelId: 'b', ollamaTag: 'b' });
    const result = select({
      registry: [a, b],
      runtimeValidationEvidence: {
        [a.modelId]: makeEvidence(a, { oom: true, smoothnessOk: false }),
        [b.modelId]: makeEvidence(b, { evicted: true, smoothnessOk: false }),
      },
    });
    expect(result.kind).toBe('runtime-validation-failed');
    if (result.kind === 'runtime-validation-failed') {
      const da = getDisposition(result.dispositions, 'a');
      const db = getDisposition(result.dispositions, 'b');
      expect(da?.codes).toContain('oom');
      expect(db?.codes).toContain('evicted');
    }
  });

  it('excludes pending, failed, incompatible and uncertified candidates from fallbackOrder', () => {
    const validated = makeProfile({ modelId: 'validated', ollamaTag: 'validated' });
    const pending = makeProfile({ modelId: 'pending', ollamaTag: 'pending' });
    const failed = makeProfile({ modelId: 'failed', ollamaTag: 'failed' });
    const incompatible = makeProfile({ modelId: 'incompatible', ollamaTag: 'incompatible', supportedRuntimes: ['llamafile'] });
    const uncertified = makeProfile({ modelId: 'uncertified', ollamaTag: 'uncertified', certified: false });
    const result = select({
      registry: [validated, pending, failed, incompatible, uncertified],
      runtimeValidationEvidence: {
        [validated.modelId]: makeEvidence(validated),
        [failed.modelId]: makeEvidence(failed, { oom: true, smoothnessOk: false }),
      },
    });
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.fallbackOrder).toHaveLength(0);
      expect(result.validationOrder.map((p) => p.modelId)).toEqual(['pending']);
    }
  });

  it('returns invalid-input for duplicate modelId', () => {
    const result = select({
      registry: [makeProfile(), makeProfile()],
    });
    expect(result.kind).toBe('invalid-input');
    if (result.kind === 'invalid-input') {
      expect(result.issues.some((i) => i.includes('duplicate modelId'))).toBe(true);
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('invalid-evidence');
    }
  });

  it('returns invalid-input when runtime evidence key mismatches modelId', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile);
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: { 'wrong-key': evidence },
    });
    expect(result.kind).toBe('invalid-input');
    if (result.kind === 'invalid-input') {
      expect(result.issues.some((i) => i.includes('does not match evidence modelId'))).toBe(true);
    }
  });

  it('returns invalid-input when evidence benchmarkSuiteVersion does not match profile', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile, { benchmarkSuiteVersion: 'other' });
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: { [profile.modelId]: evidence },
    });
    expect(result.kind).toBe('invalid-input');
    if (result.kind === 'invalid-input') {
      expect(result.issues.some((i) => i.includes('benchmarkSuiteVersion'))).toBe(true);
    }
  });

  it('returns invalid-input for missing/blank comparisonGroupId', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile, { comparisonGroupId: '' });
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: { [profile.modelId]: evidence },
    });
    expect(result.kind).toBe('invalid-input');
    if (result.kind === 'invalid-input') {
      expect(result.issues.some((i) => i.includes('comparisonGroupId'))).toBe(true);
    }
  });

  it('returns invalid-input when runtimeValidationEvidence is an array', () => {
    const profile = makeProfile();
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: [] as any,
    });
    expect(result.kind).toBe('invalid-input');
    if (result.kind === 'invalid-input') {
      expect(result.issues).toContain('runtimeValidationEvidence must be a non-null, non-array record');
    }
  });

  it('records load success followed by OOM as a validation failure', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile, { oom: true, smoothnessOk: false });
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: { [profile.modelId]: evidence },
    });
    expect(result.kind).toBe('runtime-validation-failed');
    if (result.kind === 'runtime-validation-failed') {
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('oom');
      expect(d?.codes).toContain('smoothness-failed');
      expect(d?.codes).not.toContain('load-failed');
    }
  });

  it('records load success followed by eviction as a validation failure', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile, { evicted: true, smoothnessOk: false });
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: { [profile.modelId]: evidence },
    });
    expect(result.kind).toBe('runtime-validation-failed');
    if (result.kind === 'runtime-validation-failed') {
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('evicted');
      expect(d?.codes).toContain('smoothness-failed');
    }
  });

  it('passes validation for CPU offload with positive smoothness', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile, { cpuOffload: true });
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: { [profile.modelId]: evidence },
    });
    expect(result.kind).toBe('selected');
  });

  it('records all applicable failure disposition codes', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile, {
      loadSuccess: false,
      loadFailureReason: 'context length',
      oom: true,
      evicted: true,
      smoothnessOk: false,
    });
    const result = select({
      registry: [profile],
      runtimeValidationEvidence: { [profile.modelId]: evidence },
    });
    expect(result.kind).toBe('runtime-validation-failed');
    if (result.kind === 'runtime-validation-failed') {
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toEqual(expect.arrayContaining(['load-failed', 'oom', 'evicted', 'smoothness-failed']));
    }
  });

  it('produces a reachable invalid-evidence disposition for malformed certified profile metrics', () => {
    const profile = makeProfile({ primaryPromptPassRate: 1.5 });
    const result = select({ registry: [profile] });
    expect(result.kind).toBe('invalid-input');
    if (result.kind === 'invalid-input') {
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('invalid-evidence');
      expect(result.issues.some((i) => i.includes('correctness metrics'))).toBe(true);
    }
  });

  it('ranks by comparable local memory metrics within the same comparison group', () => {
    const a = makeProfile({ modelId: 'a', ollamaTag: 'a', primaryPromptPassRate: 0.9 });
    const b = makeProfile({ modelId: 'b', ollamaTag: 'b', primaryPromptPassRate: 0.9 });
    const result = select({
      registry: [b, a], // input order reversed
      runtimeValidationEvidence: {
        [a.modelId]: makeEvidence(a, { measuredWholeAppPeakMemoryMiB: 7000 }),
        [b.modelId]: makeEvidence(b, { measuredWholeAppPeakMemoryMiB: 6000 }),
      },
    });
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('b');
      expect(result.fallbackOrder[0].modelId).toBe('a');
    }
  });

  it('does not compare measurements from different comparison groups', () => {
    const a = makeProfile({ modelId: 'a', ollamaTag: 'a', primaryPromptPassRate: 0.9, fallbackPriority: 1 });
    const b = makeProfile({ modelId: 'b', ollamaTag: 'b', primaryPromptPassRate: 0.9, fallbackPriority: 0 });
    const result = select({
      registry: [a, b],
      runtimeValidationEvidence: {
        [a.modelId]: makeEvidence(a, { comparisonGroupId: 'group-a', measuredWholeAppPeakMemoryMiB: 9000 }),
        [b.modelId]: makeEvidence(b, { comparisonGroupId: 'group-b', measuredWholeAppPeakMemoryMiB: 1000 }),
      },
    });
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      // Memory should not flip the fallback-priority order.
      expect(result.selected.modelId).toBe('b');
      expect(result.fallbackOrder[0].modelId).toBe('a');
    }
  });

  it('skips a local metric for the entire tied group when one candidate lacks it', () => {
    const a = makeProfile({ modelId: 'a', ollamaTag: 'a', primaryPromptPassRate: 0.9, fallbackPriority: 1 });
    const b = makeProfile({ modelId: 'b', ollamaTag: 'b', primaryPromptPassRate: 0.9, fallbackPriority: 0 });
    const result = select({
      registry: [a, b],
      runtimeValidationEvidence: {
        [a.modelId]: makeEvidence(a, { measuredWholeAppPeakMemoryMiB: 4000 }),
        [b.modelId]: makeEvidence(b), // no measuredWholeAppPeakMemoryMiB
      },
    });
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('b');
      expect(result.fallbackOrder[0].modelId).toBe('a');
    }
  });

  it('uses a stable ordinal modelId tie-break', () => {
    const z = makeProfile({ modelId: 'zzz', ollamaTag: 'zzz', primaryPromptPassRate: 0.9 });
    const a = makeProfile({ modelId: 'aaa', ollamaTag: 'aaa', primaryPromptPassRate: 0.9 });
    const result = select({
      registry: [z, a],
      runtimeValidationEvidence: {
        [z.modelId]: makeEvidence(z),
        [a.modelId]: makeEvidence(a),
      },
    });
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') {
      expect(result.selected.modelId).toBe('aaa');
      expect(result.fallbackOrder[0].modelId).toBe('zzz');
    }
  });

  it('is independent of registry input order', () => {
    const a = makeProfile({ modelId: 'a', ollamaTag: 'a', primaryPromptPassRate: 0.85 });
    const b = makeProfile({ modelId: 'b', ollamaTag: 'b', primaryPromptPassRate: 0.95 });
    const r1 = select({
      registry: [a, b],
      runtimeValidationEvidence: { [a.modelId]: makeEvidence(a), [b.modelId]: makeEvidence(b) },
    });
    const r2 = select({
      registry: [b, a],
      runtimeValidationEvidence: { [a.modelId]: makeEvidence(a), [b.modelId]: makeEvidence(b) },
    });
    expect(r1.kind).toBe('selected');
    expect(r2.kind).toBe('selected');
    if (r1.kind === 'selected' && r2.kind === 'selected') {
      expect(r1.selected.modelId).toBe(r2.selected.modelId);
      expect(r1.fallbackOrder.map((p) => p.modelId)).toEqual(r2.fallbackOrder.map((p) => p.modelId));
    }
  });

  it('is independent of evidence map iteration order', () => {
    const a = makeProfile({ modelId: 'a', ollamaTag: 'a', primaryPromptPassRate: 0.85 });
    const b = makeProfile({ modelId: 'b', ollamaTag: 'b', primaryPromptPassRate: 0.95 });
    const r1 = select({
      registry: [a, b],
      runtimeValidationEvidence: { [a.modelId]: makeEvidence(a), [b.modelId]: makeEvidence(b) },
    });
    const r2 = select({
      registry: [a, b],
      runtimeValidationEvidence: { [b.modelId]: makeEvidence(b), [a.modelId]: makeEvidence(a) },
    });
    if (r1.kind === 'selected' && r2.kind === 'selected') {
      expect(r1.selected.modelId).toBe(r2.selected.modelId);
    }
  });

  it('does not mutate its inputs', () => {
    const profile = makeProfile();
    const evidence = makeEvidence(profile);
    const input = {
      registry: [profile],
      runtime: DEFAULT_RUNTIME,
      platform: DEFAULT_PLATFORM,
      runtimeValidationEvidence: { [profile.modelId]: evidence },
    };
    const inputClone = JSON.parse(JSON.stringify(input));
    selectCertifiedModel(input);
    expect(input).toEqual(inputClone);
  });

  it('performs no host, filesystem, Tauri, network, environment or Ollama I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response()));
    const profile = makeProfile();
    selectCertifiedModel({
      registry: [profile],
      runtime: DEFAULT_RUNTIME,
      platform: DEFAULT_PLATFORM,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns invalid-input and records every structural field error for certified profiles', () => {
    const profile = makeProfile({
      ollamaTag: '',
      certificationVersion: '',
      benchmarkSuiteVersion: '',
      controlledContextSize: 0,
      keepAlive: '',
      supportedRuntimes: [] as any,
      supportedOperatingSystems: [''] as any,
      fallbackPriority: -1,
    });
    const result = select({ registry: [profile] });
    expect(result.kind).toBe('invalid-input');
    if (result.kind === 'invalid-input') {
      expect(result.issues.length).toBeGreaterThan(5);
      const d = getDisposition(result.dispositions, 'qwen3:8b');
      expect(d?.codes).toContain('invalid-evidence');
    }
  });

  it('rejects malformed optional fallbackPriority', () => {
    const result = select({
      registry: [makeProfile({ fallbackPriority: Number.POSITIVE_INFINITY })],
    });
    expect(result.kind).toBe('invalid-input');
    if (result.kind === 'invalid-input') {
      expect(result.issues.some((i) => i.includes('fallbackPriority'))).toBe(true);
    }
  });

  describe('fallbackPriority boundary values', () => {
    it('accepts omitted/undefined fallbackPriority for certified and uncertified profiles', () => {
      const certified = select({
        registry: [makeProfile({ fallbackPriority: undefined })],
      });
      expect(certified.kind).toBe('validation-required');

      const uncertified = select({
        registry: [makeProfile({ modelId: 'qwen3:4b-instruct', ollamaTag: 'qwen3:4b-instruct', certified: false, fallbackPriority: undefined })],
      });
      expect(uncertified.kind).toBe('no-certified-profiles');
    });

    it('rejects null fallbackPriority for certified profiles', () => {
      const result = select({
        registry: [makeProfile({ fallbackPriority: null as any })],
      });
      expect(result.kind).toBe('invalid-input');
      if (result.kind === 'invalid-input') {
        expect(result.issues.some((i) => i.includes('fallbackPriority'))).toBe(true);
      }
    });

    it('rejects null fallbackPriority for uncertified profiles', () => {
      const result = select({
        registry: [makeProfile({ modelId: 'qwen3:4b-instruct', ollamaTag: 'qwen3:4b-instruct', certified: false, fallbackPriority: null as any })],
      });
      expect(result.kind).toBe('invalid-input');
      if (result.kind === 'invalid-input') {
        expect(result.issues.some((i) => i.includes('fallbackPriority'))).toBe(true);
      }
    });

    const malformedCases: Array<{ value: unknown; label: string }> = [
      { value: NaN, label: 'NaN' },
      { value: Number.POSITIVE_INFINITY, label: 'Infinity' },
      { value: -1, label: 'negative number' },
      { value: 'zero', label: 'string' },
      { value: true, label: 'boolean' },
    ];

    for (const { value, label } of malformedCases) {
      it(`rejects ${label} fallbackPriority for certified profiles`, () => {
        const result = select({
          registry: [makeProfile({ fallbackPriority: value as any })],
        });
        expect(result.kind).toBe('invalid-input');
        if (result.kind === 'invalid-input') {
          expect(result.issues.some((i) => i.includes('fallbackPriority'))).toBe(true);
        }
      });
    }
  });

});
