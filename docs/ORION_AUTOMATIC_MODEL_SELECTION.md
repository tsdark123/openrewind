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

## B. Local hardware probe and runtime validation evidence

Chapter 2B.1 (`hardware.rs`) produces a read-only `HardwareProfile` that
contains CPU, RAM and NVIDIA GPU facts. This profile is **not an input to the
2B.2 selector** because the current registry contains no evidence-backed,
machine-readable universal hardware requirements.

Instead, a separate **runtime-validation orchestrator** consumes the
`HardwareProfile` and, when it chooses to run a validation, produces
precomputed `RuntimeValidationEvidence`.

```ts
interface RuntimeValidationEvidence {
  // Identity binding: must match the certified profile and selector call.
  modelId: string;
  ollamaTag: string;
  certificationVersion: string;
  benchmarkSuiteVersion: string;
  controlledContextSize: number;
  thinking: boolean;
  keepAlive: string;
  runtime: string;
  platform: string;
  comparisonGroupId: string; // Nonblank identifier of the local validation run

  // Validation result.
  loadSuccess: boolean;
  loadFailureReason?: string;
  oom: boolean;
  cpuOffload: boolean;
  evicted: boolean;
  measuredWholeAppPeakMemoryMiB?: number;
  avgTokensPerSecond?: number;
  p95WallClockMs?: number;
  p95TrueTTFTMs?: number;
  smoothnessOk: boolean;
}
```

A `comparisonGroupId` ties measurements to one controlled local validation
environment. It is not proof of certification and does not affect eligibility.

Memory and latency metrics may only be used for ranking when **all** candidates
in a correctness-score tie have the same nonblank `comparisonGroupId` and the
same metric.

---

## C. Selection algorithm (pure selector)

Chapter 2B.2 is implemented by `selectCertifiedModel`, a synchronous,
I/O-free pure function.

Architecture:

```text
Chapter 2B.1 hardware observation
  → later runtime-validation orchestrator
  → RuntimeValidationEvidence
  → Chapter 2B.2 pure selector
  → explicit ModelSelectionResult
  → Chapter 2C persistence / switching
```

```ts
function selectCertifiedModel(input: {
  registry: CertifiedModelProfile[];
  runtime: string;
  platform: string;
  runtimeValidationEvidence?: Record<string, RuntimeValidationEvidence>;
}): ModelSelectionResult
```

Pseudocode:

1. **Fail closed on malformed input.**
   Validate registry structure, evidence structure, evidence identity binding,
   and the certified ranking metrics. Any error returns `invalid-input` with
   machine-readable issues and dispositions for safely identifiable profiles.
2. **Exclude non-certified models.**
   ```
   candidates = profiles where p.certified === true
   ```
3. **Exclude incompatible platforms / runtime formats.**
   ```
   candidates = candidates where
     p.supportedRuntimes includes runtime and
     p.supportedOperatingSystems includes platform
   ```
4. **Categorize eligible candidates by evidence.**
   - **Positively validated**: evidence exists, `loadSuccess === true`,
     `oom === false`, `evicted === false` and `smoothnessOk === true`.
   - **Pending validation**: no evidence exists.
   - **Runtime-validation failed**: evidence exists but the run failed.
5. **If one or more candidates are positively validated, select the highest-ranked
   validated candidate.**
6. **If no candidate is validated but pending candidates exist, return
   `validation-required`** with a `validationOrder` of ranked pending candidates.
7. **If every compatible candidate failed validation, return
   `runtime-validation-failed`**.

Ranking:

- Primary score (higher is better):
  ```
  0.50 * primaryPromptPassRate +
  0.25 * safetyClassificationAccuracy +
  0.15 * rawFieldAccuracy +
  0.10 * pipelineFieldAccuracy
  ```
- For an exact correctness-score tie, use lower local whole-app peak memory
  only if every candidate in the tied group has the same nonblank
  `comparisonGroupId` and the metric. Otherwise skip memory for the entire
  group and try `p95WallClockMs`, then `p95TrueTTFTMs`, with the same rule.
- Break remaining ties by `fallbackPriority` (lower first) and then a stable
  ordinal `modelId` comparison (not `localeCompare`).

Output `ModelSelectionResult` kinds:

- `selected` — a positively validated, compatible certified candidate is chosen.
  `fallbackOrder` contains only other positively validated candidates.
  `validationOrder` contains pending candidates (if any).
- `validation-required` — compatible certified candidates exist but none have
  been validated. `validationOrder` is the ranked list to validate; no candidate
  appears in `fallbackOrder`.
- `no-certified-profiles` — the registry contains no `certified: true` entries.
- `no-compatible-certified` — certified profiles exist but none support the
  requested `runtime` and `platform`.
- `runtime-validation-failed` — every compatible certified candidate has failed
  validation.
- `invalid-input` — registry, evidence or call arguments are malformed.

Important constraints:

- The selector does **not** invoke Tauri, Ollama, hardware probes, `nvidia-smi`,
  `fetch`, environment variables or persistence.
- The selector does **not** statically disqualify candidates by raw hardware.
  OOM, load failure, eviction and failed smoothness are runtime-validation
  failures, not proof of insufficient hardware.
- Uncertified, pending, failed and incompatible candidates never appear in
  `fallbackOrder`.
- No minimum-VRAM threshold is implemented; `qwen3:8b` is not claimed to be
  universally compatible with every 8 GB system.

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

## E. Smallest public interface

These are the public surface and supporting types implemented by Chapter 2B.2.

```ts
// ---------------------------------------------------------------------------
// Model selection domain
// ---------------------------------------------------------------------------

interface CertifiedModelProfile {
  modelId: string;
  ollamaTag: string;
  certificationVersion: string;
  benchmarkSuiteVersion: string;
  certified: boolean;
  certificationDate: string;
  reasonWhenNotCertified?: string;
  controlledContextSize: number;
  thinking: boolean;
  primaryPromptPassRate: number;
  safetyClassificationAccuracy: number;
  rawFieldAccuracy: number;
  pipelineFieldAccuracy: number;
  measuredModelSizeHuman?: string;
  supportedRuntimes: string[];
  supportedOperatingSystems: string[];
  measuredWholeRuntimeMemoryMiB?: number;
  avgTokensPerSecond?: number;
  p95WallClockMs?: number;
  p95TrueTTFTMs?: number;
  conservativeRecommendedHardware?: string;
  measuredHardwareReferences: string[];
  fallbackPriority?: number;
}

interface RuntimeValidationEvidence {
  modelId: string;
  ollamaTag: string;
  certificationVersion: string;
  benchmarkSuiteVersion: string;
  controlledContextSize: number;
  thinking: boolean;
  keepAlive: string;
  runtime: string;
  platform: string;
  comparisonGroupId: string;

  loadSuccess: boolean;
  loadFailureReason?: string;
  oom: boolean;
  cpuOffload: boolean;
  evicted: boolean;
  measuredWholeAppPeakMemoryMiB?: number;
  avgTokensPerSecond?: number;
  p95WallClockMs?: number;
  p95TrueTTFTMs?: number;
  smoothnessOk: boolean;
}

type CandidateDispositionCode =
  | 'uncertified'
  | 'runtime-incompatible'
  | 'platform-incompatible'
  | 'validation-pending'
  | 'validation-passed'
  | 'load-failed'
  | 'oom'
  | 'evicted'
  | 'smoothness-failed'
  | 'invalid-evidence';

interface CandidateDisposition {
  modelId: string;
  ollamaTag: string;
  codes: CandidateDispositionCode[];
  explanation: string;
}

type ModelSelectionResult =
  | { kind: 'selected'; selected: CertifiedModelProfile; fallbackOrder: CertifiedModelProfile[]; validationOrder: CertifiedModelProfile[]; dispositions: CandidateDisposition[]; reason: string }
  | { kind: 'validation-required'; validationOrder: CertifiedModelProfile[]; fallbackOrder: CertifiedModelProfile[]; dispositions: CandidateDisposition[]; reason: string }
  | { kind: 'no-certified-profiles'; dispositions: CandidateDisposition[]; reason: string }
  | { kind: 'no-compatible-certified'; dispositions: CandidateDisposition[]; reason: string }
  | { kind: 'runtime-validation-failed'; dispositions: CandidateDisposition[]; reason: string }
  | { kind: 'invalid-input'; reason: string; issues: string[]; dispositions: CandidateDisposition[] };

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

declare function selectCertifiedModel(input: {
  registry: CertifiedModelProfile[];
  runtime: string;
  platform: string;
  runtimeValidationEvidence?: Record<string, RuntimeValidationEvidence>;
}): ModelSelectionResult;
```

---

## Open questions

- When the registry gains evidence-backed machine-readable minimum hardware
  requirements, how should the pure selector incorporate them without
  reintroducing ad-hoc thresholds derived from a single workstation?
- Should the registry ship inside the app bundle or be fetched from a
  pinned, signed update endpoint? Design decision for a later phase.
- How do we define "smoothness"? A concrete latency budget (e.g. p95 TTFT
  < 250 ms and p95 wall-clock < 1200 ms) should be set after profiling, then
  represented as validated `smoothnessOk` evidence.

---

## Notes

- This document does **not** create active production configuration.
- `selectCertifiedModel` is pure and I/O-free; it does not download, warm,
  persist or switch models. Those operations belong to later 2B integration and
  Chapter 2C.
- No static VRAM/headroom threshold is implemented. Selection is based on
  declared runtime/platform compatibility and precomputed runtime validation.
- No certified lighter fallback tier currently exists. `qwen3:4b-instruct` is
  measured but not certified and must not be automatically selected.
- The optional `orion-certified-models.example.json` file contains only the
  values directly supported by the completed measurements.
- No SQLite, database files or telemetry upload are introduced by this design.
