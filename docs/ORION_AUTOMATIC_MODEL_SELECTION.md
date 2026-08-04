# Orion Automatic Certified Model Selection

This document defines the **design-only contract** for how OpenRewind will
automatically choose, download, configure and persist a local LLM for the Orion
AI runtime during the future installation / setup flow.

It is intentionally non-implementation: interfaces, metadata and algorithms are
specified, but no production code is added yet.

## Goals

- Ordinary onboarding must **not** ask the user to pick an LLM.
- Selection must be limited to **Orion-certified model profiles**.
- The chosen model must pass compatibility, whole-application memory-headroom
  and smoothness checks on the local machine.
- If the first choice fails, fallback must be **deterministic** to the next
  certified candidate.
- A manual Advanced override may exist, but no normal model picker is shown.
- No hardware specifications or telemetry are uploaded by default.

---

## A. Certified model registry metadata

A profile is stored in the certified-model registry. Every field must be
verifiable from a controlled Orion bake-off + real runtime test before the model
can be marked `certified: true`.

```ts
interface CertifiedModelProfile {
  // Identity
  modelId: string;          // Ollama name, e.g. "qwen3:8b"
  ollamaTag: string;        // Exact tag, e.g. "qwen3:8b"
  immutableDigest?: string; // Ollama manifest digest when certified

  // Certification provenance
  certificationVersion: string; // Version of the certification process
  benchmarkSuiteVersion: string; // Version/SHA of the bake-off suite
  certified: boolean;
  certificationDate: string;    // ISO 8601 date
  reasonWhenNotCertified?: string; // Required when certified is false

  // Runtime configuration used during certification
  controlledContextSize: number; // e.g. 4096
  thinking: boolean | 'default'; // Agent thinking mode; qwen3 required false

  // Pipeline quality from the controlled bake-off
  primaryRepetitionPassRate: number;     // 0..1
  primaryPromptPassRate: number;         // 0..1
  safetyExecutionRate: number;           // 0..1
  safetyClassificationAccuracy: number;  // 0..1
  preconditionPassRate: number;          // 0..1
  rawFieldAccuracy: number;              // 0..1
  pipelineFieldAccuracy: number;         // 0..1
  avgHallucinationRate: number;          // 0..1

  // Size and platform
  measuredModelSizeBytes?: number; // Ollama-reported model size
  measuredModelSizeHuman?: string; // e.g. "5.6 GB"
  supportedRuntimes: ('ollama' | string)[];
  supportedOperatingSystems: ('win32' | 'darwin' | 'linux' | string)[];

  // Memory and latency measured on reference hardware
  measuredWholeRuntimeMemoryMiB?: number; // Whole app GPU memory at peak
  processorSplit?: string;                // e.g. "100% GPU"
  avgTokensPerSecond?: number;
  p95WallClockMs?: number;
  p95TrueTTFTMs?: number;

  // Recommendation
  conservativeRecommendedHardware?: string; // Free-text envelope, not a hard threshold
  measuredHardwareReferences: string[];     // Descriptions of machines used
  fallbackPriority: number;                 // Lower = prefer first; 0 is top
}
```

Certification rules:

- `certified: true` requires the full bake-off primary prompt pass rate,
  safety execution rate, safety classification accuracy and precondition pass
  rate to all meet the production bar.
- `certified: false` is for models that are **measured** but did not clear the
  bar; `reasonWhenNotCertified` must explain why.
- No profile may be promoted without a successful live-engine runtime retest.
- `conservativeRecommendedHardware` is documentation, not a gating predicate.
  Gating is done by the local probe in section B.

---

## B. Local hardware / runtime probe

The installer uses a local probe. The following values are **inputs** to the
selection algorithm. This section defines them, but does not implement them.

```ts
interface HardwareProfile {
  // GPU
  hasGpu: boolean;
  gpuVendor?: string;       // e.g. "NVIDIA"
  gpuModel?: string;        // e.g. "NVIDIA GeForce RTX 3070 Ti"
  totalVramMiB?: number;
  availableVramMiB?: number; // At install time, not after loading

  // System
  totalRamMiB?: number;
  availableRamMiB?: number;
  cpuCapability?: 'low' | 'mid' | 'high' | string;

  // Runtime environment
  ollamaVersion?: string;
  cudaVersion?: string;
  rocmVersion?: string;
  metalVersion?: string;
}

interface RuntimeHealthResult {
  modelId: string;
  loadSuccess: boolean;
  loadFailureReason?: string;
  oom: boolean;
  cpuOffload: boolean;      // Did Ollama partially run on CPU?
  evicted: boolean;         // Was the model repeatedly evicted?
  measuredContextAllocationMiB?: number;
  measuredWholeAppPeakMemoryMiB?: number; // True peak with engine + app
  avgTokensPerSecond?: number;
  p95WallClockMs?: number;
  p95TrueTTFTMs?: number;
  smoothnessOk: boolean;    // Latency does not cause visible stalls
}
```

Probe behavior:

- Measure **total and currently available VRAM** before any model is loaded.
- After loading, measure **whole-application peak memory**, not just the model
  size from `ollama ps`.
- Record whether the model loads fully on GPU, partially on CPU, or not at all.
- Run a short local load + latency health check and record TTFT and total
  latency.
- The probe runs locally; nothing is uploaded.

---

## C. Selection algorithm

The algorithm must follow this order exactly. It is presented as pseudocode,
not production code.

```ts
function selectBestCertifiedModel(
  certifiedProfiles: CertifiedModelProfile[],
  hardware: HardwareProfile,
  healthCheck: (profile: CertifiedModelProfile) => Promise<RuntimeHealthResult>
): Promise<ModelSelectionResult>
```

Pseudocode:

1. **Exclude non-certified models.**
   ```
   candidates = profiles where p.certified === true
   ```
2. **Exclude incompatible platforms / runtime formats.**
   ```
   candidates = candidates where
     p.supportedRuntings includes 'ollama' and
     p.supportedOperatingSystems includes currentOS
   ```
3. **Exclude models without conservative whole-app memory headroom.**
   ```
   candidates = candidates where
     healthCheck(p).measuredWholeAppPeakMemoryMiB < hardware.availableVramMiB * safetyMargin
   ```
   The `safetyMargin` is a tuned constant (e.g. 0.8) chosen so the app does not
   run at the absolute VRAM limit. The exact value must be set from packaged
   production profiling, not from a single workstation.
4. **Exclude models that fail the local load / latency health check.**
   ```
   candidates = candidates where
     healthCheck(p).loadSuccess === true and
     healthCheck(p).oom === false and
     healthCheck(p).smoothnessOk === true
   ```
5. **Choose the highest-correctness remaining model.**
   ```
   primaryScore(p) = weighted(0.5 * primaryPromptPassRate,
                              0.25 * safetyClassificationAccuracy,
                              0.15 * rawFieldAccuracy,
                              0.10 * pipelineFieldAccuracy)
   selected = maxBy(candidates, primaryScore)
   ```
6. **When correctness is effectively tied**, prefer lower latency and lower
   measured whole-app memory.
7. **Fall back deterministically** if the selected model fails. The fallback
   list is the remaining candidates sorted by `fallbackPriority` then by the
   same score above.
8. **Persist the successful selection** locally and re-evaluate only after a
   meaningful change to the registry, certification data or hardware.

Important constraints:

- Do **not** use "largest model that loads" as the rule. Correctness comes
  first; memory and latency are filters and tie-breakers.
- The local probe is the source of truth for memory and latency, not the
  reference measurements in the registry.

---

## D. Current evidence

Only the following facts are supported by the completed bake-off and runtime
measurements:

- `qwen3:8b` is **certified**.
- `qwen3:4b-instruct` is **measured but not certified** (primary prompt pass
  rate 93.3%, safety classification 75.0%).
- On the measured RTX 3070 Ti 8 GB system:
  - `qwen3:8b` ran fully on GPU and the whole development runtime consumed
    ~6802 MiB, leaving ~1.4 GB of VRAM free.
  - `qwen3:4b-instruct` ran fully on GPU and consumed ~4564 MiB.
- The minimum universal hardware envelope is **still unresolved**.
- Packaged production-runtime profiling is still required before claiming
  `qwen3:8b` is appropriate for every 8 GB system.
- There is currently **no certified lighter fallback tier**.

No minimum-VRAM threshold should be derived from this single machine.

---

## E. Smallest future interface

These are the public surface and supporting types. Implementation is left to a
later phase.

```ts
// ---------------------------------------------------------------------------
// Model selection domain
// ---------------------------------------------------------------------------

interface CertifiedModelProfile {
  modelId: string;
  ollamaTag: string;
  immutableDigest?: string;
  certificationVersion: string;
  benchmarkSuiteVersion: string;
  certified: boolean;
  certificationDate: string;
  reasonWhenNotCertified?: string;
  controlledContextSize: number;
  thinking: boolean | 'default';
  primaryRepetitionPassRate: number;
  primaryPromptPassRate: number;
  safetyExecutionRate: number;
  safetyClassificationAccuracy: number;
  preconditionPassRate: number;
  rawFieldAccuracy: number;
  pipelineFieldAccuracy: number;
  avgHallucinationRate: number;
  measuredModelSizeBytes?: number;
  measuredModelSizeHuman?: string;
  supportedRuntimes: string[];
  supportedOperatingSystems: string[];
  measuredWholeRuntimeMemoryMiB?: number;
  processorSplit?: string;
  avgTokensPerSecond?: number;
  p95WallClockMs?: number;
  p95TrueTTFTMs?: number;
  conservativeRecommendedHardware?: string;
  measuredHardwareReferences: string[];
  fallbackPriority: number;
}

interface HardwareProfile {
  hasGpu: boolean;
  gpuVendor?: string;
  gpuModel?: string;
  totalVramMiB?: number;
  availableVramMiB?: number;
  totalRamMiB?: number;
  availableRamMiB?: number;
  cpuCapability?: string;
  ollamaVersion?: string;
  cudaVersion?: string;
  rocmVersion?: string;
  metalVersion?: string;
}

interface RuntimeHealthResult {
  modelId: string;
  loadSuccess: boolean;
  loadFailureReason?: string;
  oom: boolean;
  cpuOffload: boolean;
  evicted: boolean;
  measuredContextAllocationMiB?: number;
  measuredWholeAppPeakMemoryMiB?: number;
  avgTokensPerSecond?: number;
  p95WallClockMs?: number;
  p95TrueTTFTMs?: number;
  smoothnessOk: boolean;
}

interface ModelSelectionResult {
  selected: CertifiedModelProfile | null;
  fallbackOrder: CertifiedModelProfile[];
  healthResults: Record<string, RuntimeHealthResult>;
  reason: string;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Select the best certified model for the local machine.
 *
 * 1. Filter to certified profiles.
 * 2. Filter by OS/runtime compatibility.
 * 3. Filter by conservative whole-app memory headroom (local probe).
 * 4. Filter by successful load + latency health check.
 * 5. Pick the highest-correctness remaining profile.
 * 6. Break ties by lower latency and memory.
 * 7. Return a deterministic fallback list.
 */
declare function selectBestCertifiedModel(
  profiles: CertifiedModelProfile[],
  hardware: HardwareProfile,
  healthCheck: (profile: CertifiedModelProfile) => Promise<RuntimeHealthResult>,
  memoryHeadroomSafetyMargin?: number
): Promise<ModelSelectionResult>;

/**
 * Validate that a previously selected model still passes the health check on
 * the current machine and that the registry has not changed.
 */
declare function validateSelectedModel(
  selected: CertifiedModelProfile,
  previousSelection: { modelId: string; certifiedAt: string },
  hardware: HardwareProfile,
  healthCheck: (profile: CertifiedModelProfile) => Promise<RuntimeHealthResult>
): Promise<RuntimeHealthResult>;
```

---

## Open questions

- What is the right `memoryHeadroomSafetyMargin` constant? It must come from
  packaged production-runtime profiling across several GPUs, not from the
  single RTX 3070 Ti 8 GB measurement.
- Should the registry ship inside the app bundle or be fetched from a
  pinned, signed update endpoint? Design decision for a later phase.
- How do we define "smoothness"? A concrete latency budget (e.g. p95 TTFT
  < 250 ms and p95 wall-clock < 1200 ms) should be set after profiling.

---

## Notes

- This document does **not** create active production configuration.
- The optional `orion-certified-models.example.json` file contains only the
  values directly supported by the completed measurements.
- No SQLite, database files or telemetry upload are introduced by this design.
