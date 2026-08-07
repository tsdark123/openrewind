// =============================================================================
// certifiedModels — single bundled source of truth for Orion-certified models.
//
// The registry is imported directly into the frontend bundle so there is one
// immutable source of truth in the repo. No remote registry is fetched.
//
// qwen3:8b is the only currently certified semantic Orion model. The registry
// is designed so additional models can be added once they independently pass
// acceptance, runtime and latency certification.
// =============================================================================

export type SupportedRuntime = 'ollama' | string;
export type SupportedOperatingSystem = 'win32' | 'darwin' | 'linux' | string;

/**
 * Immutable Chapter 2A certification identity. Required whenever
 * `certified === true` on a `CertifiedModelProfile`.
 */
export interface CertificationIdentity {
  modelTag: string;
  modelDigest: string;
  ollamaVersion: string;
  productionHead: string;
  certificationContractVersion: string;
  promptSuiteVersion: string;
  scorerVersion: string;
  schemaVersion: string;
}

export interface CertifiedModelProfile {
  // Identity
  modelId: string;
  ollamaTag: string;

  // Certification provenance
  certificationVersion: string;
  benchmarkSuiteVersion: string;
  certified: boolean;
  certificationDate: string;
  reasonWhenNotCertified?: string;

  /**
   * Required identity when `certified === true`.
   * The full tuple is bound to the committed Chapter 2A control artifact.
   */
  certificationIdentity?: Readonly<CertificationIdentity>;

  // Runtime configuration used during certification.
  // These are the authoritative values for every semantic Orion call.
  controlledContextSize: number;
  thinking: boolean;
  keepAlive: string;

  // Pipeline quality from the controlled bake-off
  primaryRepetitionPassRate?: number;
  primaryPromptPassRate?: number;
  safetyExecutionRate?: number;
  safetyClassificationAccuracy?: number;
  preconditionPassRate?: number;
  rawFieldAccuracy?: number;
  pipelineFieldAccuracy?: number;
  avgHallucinationRate?: number;

  // Size and platform
  measuredModelSizeHuman?: string;
  supportedRuntimes: SupportedRuntime[];
  supportedOperatingSystems: SupportedOperatingSystem[];

  // Memory and latency measured on reference hardware
  measuredWholeRuntimeMemoryMiB?: number;
  processorSplit?: string;
  avgTokensPerSecond?: number;
  p95WallClockMs?: number;
  p95TrueTTFTMs?: number;

  // Recommendation
  conservativeRecommendedHardware?: string;
  measuredHardwareReferences?: string[];
  fallbackPriority?: number;
}

export interface ResolvedModel {
  modelId: string;
  ollamaTag: string;
  controlledContextSize: number;
  thinking: boolean;
  keepAlive: string;
  certified: boolean;
  source: 'certified' | 'env-override-certified' | 'env-override-uncertified';
  certificationVersion?: string;
}

export const CERTIFIED_MODEL_REGISTRY: CertifiedModelProfile[] = [
  {
    modelId: 'qwen3:8b',
    ollamaTag: 'qwen3:8b',
    certificationVersion: 'v2.1.1-semantic',
    benchmarkSuiteVersion: 'v2.1.0-22-prompts',
    certified: true,
    certificationDate: '2026-08-07',
    certificationIdentity: {
      modelTag: 'qwen3:8b',
      modelDigest:
        '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41',
      ollamaVersion: '0.32.6',
      productionHead: 'aa4553522065229f62ed5cf85c13a9cdb8740739',
      certificationContractVersion: 'v2.1.1-semantic',
      promptSuiteVersion: 'v2.1.0-22-prompts',
      scorerVersion: 'v2.0.1',
      schemaVersion: 'v2.0.0',
    },
    controlledContextSize: 4096,
    thinking: false,
    keepAlive: '10m',
    primaryRepetitionPassRate: 1.0,
    primaryPromptPassRate: 1.0,
    safetyExecutionRate: 1.0,
    safetyClassificationAccuracy: 1.0,
    preconditionPassRate: 1.0,
    rawFieldAccuracy: 0.967,
    pipelineFieldAccuracy: 0.922,
    avgHallucinationRate: 0.022,
    measuredModelSizeHuman: '5.6 GB',
    supportedRuntimes: ['ollama'],
    supportedOperatingSystems: ['win32'],
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
  },
];

export function getCertifiedModelRegistry(): CertifiedModelProfile[] {
  return CERTIFIED_MODEL_REGISTRY;
}

export function getDefaultCertifiedModel(): CertifiedModelProfile | null {
  return CERTIFIED_MODEL_REGISTRY.find((p) => p.certified) ?? null;
}

export function findCertifiedModel(modelIdOrTag: string): CertifiedModelProfile | null {
  return (
    CERTIFIED_MODEL_REGISTRY.find(
      (p) => p.modelId === modelIdOrTag || p.ollamaTag === modelIdOrTag
    ) ?? null
  );
}

function getProcessOrionAgentModel(): string | undefined {
  try {
    const envProcess = (globalThis as typeof globalThis & { process?: { env?: Record<string, string> } }).process;
    return envProcess?.env?.ORION_AGENT_MODEL;
  } catch {
    return undefined;
  }
}

function getViteOrionAgentModel(): string | undefined {
  try {
    return (import.meta as any).env?.VITE_ORION_AGENT_MODEL as string | undefined;
  } catch {
    return undefined;
  }
}

function getEnvOrionAgentModel(): string | undefined {
  // Node/Vitest override takes precedence when both are present.
  return getProcessOrionAgentModel() ?? getViteOrionAgentModel();
}

function toResolvedModel(
  profile: CertifiedModelProfile,
  source: ResolvedModel['source']
): ResolvedModel {
  return {
    modelId: profile.modelId,
    ollamaTag: profile.ollamaTag,
    controlledContextSize: profile.controlledContextSize,
    thinking: profile.thinking,
    keepAlive: profile.keepAlive,
    certified: profile.certified,
    source,
    certificationVersion: profile.certificationVersion,
  };
}

/**
 * Resolve the single active Orion model.
 *
 * Priority:
 * 1. ORION_AGENT_MODEL process env (Node / Vitest).
 * 2. VITE_ORION_AGENT_MODEL Vite env (browser / Tauri dev).
 * 3. The first certified model in the bundled registry (production default).
 *
 * Overrides that match a certified profile are used as certified. Uncertified
 * overrides are used for development/validation but are explicitly flagged
 * `certified: false` and `source: 'env-override-uncertified'`. No uncertified
 * model is automatically selected, pulled or advertised in production.
 */
export function resolveActiveModel(): ResolvedModel {
  const override = getEnvOrionAgentModel();

  if (override) {
    const certified = findCertifiedModel(override);
    if (certified) {
      return toResolvedModel(certified, 'env-override-certified');
    }

    // Uncertified override: allow it for local validation, but do not claim it
    // is certified. Defaults mirror the certified runtime envelope.
    return {
      modelId: override,
      ollamaTag: override,
      controlledContextSize: 4096,
      thinking: false,
      keepAlive: '10m',
      certified: false,
      source: 'env-override-uncertified',
    };
  }

  const certified = getDefaultCertifiedModel();
  if (certified) {
    return toResolvedModel(certified, 'certified');
  }

  // This should never happen in production because the registry must contain
  // at least one certified model. Return a deterministic fallback so callers
  // can fail gracefully instead of throwing at import time.
  return {
    modelId: 'qwen3:8b',
    ollamaTag: 'qwen3:8b',
    controlledContextSize: 4096,
    thinking: false,
    keepAlive: '10m',
    certified: false,
    source: 'certified',
  };
}

export function getActiveOrionModelTag(): string {
  return resolveActiveModel().ollamaTag;
}

export function getActiveOrionModelId(): string {
  return resolveActiveModel().modelId;
}

export function isActiveModelCertified(): boolean {
  return resolveActiveModel().certified;
}

/**
 * Shared runtime options for every semantic Orion call.
 *
 * This is the single source for num_ctx, thinking and keep_alive. Callers
 * may layer on request-specific values such as temperature, seed and
 * num_predict, but they must not change the context size.
 */
export function getOrionRuntimeOptions() {
  const model = resolveActiveModel();
  return {
    num_ctx: model.controlledContextSize,
    think: model.thinking,
    keep_alive: model.keepAlive,
    temperature: 0,
    seed: 42,
  };
}
