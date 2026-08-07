// =============================================================================
// certifiedModelSelector.ts — pure certified model selector for Chapter 2B.2.
//
// This module is I/O-free, synchronous and testable with in-memory fixtures.
// It does not call Tauri, Ollama, hardware probes or environment variables.
//
// Inputs:
//   - certified-model registry
//   - target runtime and platform
//   - optional precomputed RuntimeValidationEvidence map
//
// Output: a discriminated ModelSelectionResult.
//
// Design constraints enforced here:
//   - Only certified, compatible and positively validated candidates may be
//     selected.
//   - fallbackOrder contains only other positively validated candidates.
//   - validationOrder contains only pending candidates.
//   - Raw hardware never statically disqualifies a candidate.
//   - No thresholds, no env reads, no persistence, no Ollama calls.
// =============================================================================

import type { CertifiedModelProfile } from './certifiedModels';

export type CandidateDispositionCode =
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

export interface CandidateDisposition {
  modelId: string;
  ollamaTag: string;
  codes: CandidateDispositionCode[];
  explanation: string;
}

export interface RuntimeValidationEvidence {
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
  comparisonGroupId: string;

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

export interface CertifiedModelSelectorInput {
  registry: CertifiedModelProfile[];
  runtime: string;
  platform: string;
  runtimeValidationEvidence?: Record<string, RuntimeValidationEvidence>;
}

export type ModelSelectionResult =
  | {
      kind: 'selected';
      selected: CertifiedModelProfile;
      fallbackOrder: CertifiedModelProfile[];
      validationOrder: CertifiedModelProfile[];
      dispositions: CandidateDisposition[];
      reason: string;
    }
  | {
      kind: 'validation-required';
      validationOrder: CertifiedModelProfile[];
      fallbackOrder: CertifiedModelProfile[];
      dispositions: CandidateDisposition[];
      reason: string;
    }
  | {
      kind: 'no-certified-profiles';
      dispositions: CandidateDisposition[];
      reason: string;
    }
  | {
      kind: 'no-compatible-certified';
      dispositions: CandidateDisposition[];
      reason: string;
    }
  | {
      kind: 'runtime-validation-failed';
      dispositions: CandidateDisposition[];
      reason: string;
    }
  | {
      kind: 'invalid-input';
      reason: string;
      issues: string[];
      dispositions: CandidateDisposition[];
    };

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNonBlankString(v: unknown): v is string {
  return isString(v) && v.trim().length > 0;
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

function isFiniteNumber(v: unknown): v is number {
  return isNumber(v) && Number.isFinite(v);
}

function isNonNegativeFiniteNumber(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

function isPositiveFiniteInteger(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0 && Number.isInteger(v);
}

function isNumberInRange(v: unknown, min: number, max: number): v is number {
  return isFiniteNumber(v) && v >= min && v <= max;
}

function isArrayOfNonBlankStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isNonBlankString);
}

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Disposition helpers
// ---------------------------------------------------------------------------

function createDisposition(
  modelId: string,
  ollamaTag: string,
  codes: CandidateDispositionCode[] = [],
  explanation = ''
): CandidateDisposition {
  return { modelId, ollamaTag: isNonBlankString(ollamaTag) ? ollamaTag : '', codes, explanation };
}

function addDispositionCode(
  map: Map<string, CandidateDisposition>,
  modelId: string,
  ollamaTag: string,
  code: CandidateDispositionCode,
  explanation = ''
): void {
  let d = map.get(modelId);
  if (!d) {
    d = createDisposition(modelId, ollamaTag);
    map.set(modelId, d);
  }
  if (!d.codes.includes(code)) {
    d.codes.push(code);
  }
  if (explanation) {
    d.explanation = d.explanation ? `${d.explanation}; ${explanation}` : explanation;
  }
}

function sortedDispositions(map: Map<string, CandidateDisposition>): CandidateDisposition[] {
  return Array.from(map.values()).sort((a, b) => compareOrdinal(a.modelId, b.modelId));
}

// ---------------------------------------------------------------------------
// Ordinal string comparison (locale-independent)
// ---------------------------------------------------------------------------

function compareOrdinal(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Correctness score and ranking
// ---------------------------------------------------------------------------

const CORRECTNESS_WEIGHTS = {
  primaryPromptPassRate: 0.5,
  safetyClassificationAccuracy: 0.25,
  rawFieldAccuracy: 0.15,
  pipelineFieldAccuracy: 0.1,
} as const;

function correctnessScore(profile: CertifiedModelProfile): number {
  // These metrics are validated to be present and finite in [0, 1] for every
  // certified profile before ranking, so the non-null assertions are safe.
  return (
    CORRECTNESS_WEIGHTS.primaryPromptPassRate * profile.primaryPromptPassRate! +
    CORRECTNESS_WEIGHTS.safetyClassificationAccuracy * profile.safetyClassificationAccuracy! +
    CORRECTNESS_WEIGHTS.rawFieldAccuracy * profile.rawFieldAccuracy! +
    CORRECTNESS_WEIGHTS.pipelineFieldAccuracy * profile.pipelineFieldAccuracy!
  );
}

function compareFallback(a: CertifiedModelProfile, b: CertifiedModelProfile): number {
  const prioA = a.fallbackPriority ?? Infinity;
  const prioB = b.fallbackPriority ?? Infinity;
  if (prioA !== prioB) return prioA - prioB;
  return compareOrdinal(a.modelId, b.modelId);
}

function sortByFallback(candidates: CertifiedModelProfile[]): CertifiedModelProfile[] {
  return [...candidates].sort(compareFallback);
}

type MetricName = 'measuredWholeAppPeakMemoryMiB' | 'p95WallClockMs' | 'p95TrueTTFTMs';

function getMetric(
  profile: CertifiedModelProfile,
  evidenceById: Record<string, RuntimeValidationEvidence>,
  metric: MetricName
): number | undefined {
  const ev = evidenceById[profile.modelId];
  if (!ev) return undefined;
  const v = ev[metric];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function isMetricComparableForGroup(
  group: CertifiedModelProfile[],
  evidenceById: Record<string, RuntimeValidationEvidence>,
  metric: MetricName
): boolean {
  let groupId: string | undefined;
  for (const p of group) {
    const ev = evidenceById[p.modelId];
    if (!ev) return false;
    if (!isNonBlankString(ev.comparisonGroupId)) return false;
    if (!isFiniteNumber(ev[metric])) return false;
    if (groupId === undefined) {
      groupId = ev.comparisonGroupId;
    } else if (groupId !== ev.comparisonGroupId) {
      return false;
    }
  }
  return group.length > 0;
}

function rankScoreGroupByMetrics(
  group: CertifiedModelProfile[],
  evidenceById: Record<string, RuntimeValidationEvidence>,
  metrics: MetricName[]
): CertifiedModelProfile[] {
  if (group.length <= 1 || metrics.length === 0) {
    return sortByFallback(group);
  }
  const [metric, ...rest] = metrics;

  if (!isMetricComparableForGroup(group, evidenceById, metric)) {
    return rankScoreGroupByMetrics(group, evidenceById, rest);
  }

  const sorted = [...group].sort((a, b) => {
    const ma = getMetric(a, evidenceById, metric) as number;
    const mb = getMetric(b, evidenceById, metric) as number;
    return ma - mb; // lower is better
  });

  // Further tie-break within equal-metric subgroups.
  const result: CertifiedModelProfile[] = [];
  let subGroup: CertifiedModelProfile[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const prevMetric = getMetric(prev, evidenceById, metric) as number;
    const curMetric = getMetric(cur, evidenceById, metric) as number;
    if (prevMetric === curMetric) {
      subGroup.push(cur);
    } else {
      result.push(...rankScoreGroupByMetrics(subGroup, evidenceById, rest));
      subGroup = [cur];
    }
  }
  result.push(...rankScoreGroupByMetrics(subGroup, evidenceById, rest));
  return result;
}

const LOCAL_METRICS: MetricName[] = ['measuredWholeAppPeakMemoryMiB', 'p95WallClockMs', 'p95TrueTTFTMs'];

function rankCandidates(
  candidates: CertifiedModelProfile[],
  evidenceById: Record<string, RuntimeValidationEvidence>,
  canUseLocalMetrics: boolean
): CertifiedModelProfile[] {
  // Group by correctness score to keep group-wide comparability checks safe.
  const byScore = new Map<number, CertifiedModelProfile[]>();
  for (const c of candidates) {
    const score = correctnessScore(c);
    if (!byScore.has(score)) byScore.set(score, []);
    byScore.get(score)!.push(c);
  }

  const scores = Array.from(byScore.keys()).sort((a, b) => b - a);
  const result: CertifiedModelProfile[] = [];
  const metrics = canUseLocalMetrics ? LOCAL_METRICS : [];

  for (const score of scores) {
    const group = byScore.get(score)!;
    result.push(...rankScoreGroupByMetrics(group, evidenceById, metrics));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

function validateCorrectnessMetrics(profile: CertifiedModelProfile): string[] {
  const issues: string[] = [];
  if (!isNumberInRange(profile.primaryPromptPassRate, 0, 1)) {
    issues.push('primaryPromptPassRate must be a number in [0, 1]');
  }
  if (!isNumberInRange(profile.safetyClassificationAccuracy, 0, 1)) {
    issues.push('safetyClassificationAccuracy must be a number in [0, 1]');
  }
  if (!isNumberInRange(profile.rawFieldAccuracy, 0, 1)) {
    issues.push('rawFieldAccuracy must be a number in [0, 1]');
  }
  if (!isNumberInRange(profile.pipelineFieldAccuracy, 0, 1)) {
    issues.push('pipelineFieldAccuracy must be a number in [0, 1]');
  }
  return issues;
}

function validateProfileStructure(
  profile: unknown,
  index: number,
  seenModelIds: Set<string>,
  dispositionMap: Map<string, CandidateDisposition>,
  issues: string[]
): CertifiedModelProfile | null {
  if (!isNonNullObject(profile)) {
    issues.push(`registry[${index}] is not a plain object`);
    return null;
  }

  const p = profile as Record<string, unknown>;
  const modelId = p.modelId;

  if (!isNonBlankString(modelId)) {
    issues.push(`registry[${index}] has missing or non-string modelId`);
    return null;
  }

  const ollamaTag = p.ollamaTag;

  if (seenModelIds.has(modelId)) {
    issues.push(`duplicate modelId: ${modelId}`);
    addDispositionCode(dispositionMap, modelId, isString(ollamaTag) ? ollamaTag : '', 'invalid-evidence', 'duplicate modelId in registry');
    return null;
  }
  seenModelIds.add(modelId);

  const fieldIssues: string[] = [];

  if (!isNonBlankString(ollamaTag)) fieldIssues.push('ollamaTag missing or blank');
  if (!isBoolean(p.certified)) fieldIssues.push('certified is not a boolean');
  if (!isNonBlankString(p.certificationVersion)) fieldIssues.push('certificationVersion missing or blank');
  if (!isNonBlankString(p.benchmarkSuiteVersion)) fieldIssues.push('benchmarkSuiteVersion missing or blank');
  if (!isPositiveFiniteInteger(p.controlledContextSize)) fieldIssues.push('controlledContextSize must be a positive finite integer');
  if (!isBoolean(p.thinking)) fieldIssues.push('thinking is not a boolean');
  if (!isNonBlankString(p.keepAlive)) fieldIssues.push('keepAlive missing or blank');
  if (!isArrayOfNonBlankStrings(p.supportedRuntimes)) fieldIssues.push('supportedRuntimes must be an array of nonblank strings');
  if (!isArrayOfNonBlankStrings(p.supportedOperatingSystems)) fieldIssues.push('supportedOperatingSystems must be an array of nonblank strings');

  if (p.fallbackPriority !== undefined && p.fallbackPriority !== null && !isNonNegativeFiniteNumber(p.fallbackPriority)) {
    fieldIssues.push('fallbackPriority must be a finite nonnegative number');
  }

  const asCertified = p as unknown as CertifiedModelProfile;
  if (p.certified === true) {
    fieldIssues.push(...validateCorrectnessMetrics(asCertified).map(m => `correctness metrics: ${m}`));
  }

  if (fieldIssues.length > 0) {
    issues.push(...fieldIssues.map(m => `${modelId}: ${m}`));
    addDispositionCode(
      dispositionMap,
      modelId,
      isString(ollamaTag) ? ollamaTag : '',
      'invalid-evidence',
      fieldIssues.join('; ')
    );
    return null;
  }

  return asCertified;
}

function validateEvidenceStructure(
  evidence: unknown,
  key: string,
  safeProfiles: CertifiedModelProfile[],
  runtime: string,
  platform: string,
  dispositionMap: Map<string, CandidateDisposition>,
  issues: string[]
): void {
  if (!isNonNullObject(evidence)) {
    issues.push(`runtimeValidationEvidence[${key}] is not a plain object`);
    return;
  }

  const ev = evidence as Record<string, unknown>;

  if (key !== ev.modelId) {
    issues.push(`runtimeValidationEvidence key ${key} does not match evidence modelId ${ev.modelId}`);
  }

  const modelId = isNonBlankString(ev.modelId) ? ev.modelId : undefined;
  const ollamaTag = isString(ev.ollamaTag) ? ev.ollamaTag : '';

  const fieldIssues: string[] = [];

  if (!isNonBlankString(ev.modelId)) fieldIssues.push('modelId missing or blank');
  if (!isNonBlankString(ev.ollamaTag)) fieldIssues.push('ollamaTag missing or blank');
  if (!isNonBlankString(ev.certificationVersion)) fieldIssues.push('certificationVersion missing or blank');
  if (!isNonBlankString(ev.benchmarkSuiteVersion)) fieldIssues.push('benchmarkSuiteVersion missing or blank');
  if (!isPositiveFiniteInteger(ev.controlledContextSize)) fieldIssues.push('controlledContextSize must be a positive finite integer');
  if (!isBoolean(ev.thinking)) fieldIssues.push('thinking is not a boolean');
  if (!isNonBlankString(ev.keepAlive)) fieldIssues.push('keepAlive missing or blank');
  if (!isNonBlankString(ev.runtime)) fieldIssues.push('runtime missing or blank');
  if (!isNonBlankString(ev.platform)) fieldIssues.push('platform missing or blank');
  if (!isNonBlankString(ev.comparisonGroupId)) fieldIssues.push('comparisonGroupId missing or blank');

  if (!isBoolean(ev.loadSuccess)) fieldIssues.push('loadSuccess is not a boolean');
  if (!isBoolean(ev.oom)) fieldIssues.push('oom is not a boolean');
  if (!isBoolean(ev.cpuOffload)) fieldIssues.push('cpuOffload is not a boolean');
  if (!isBoolean(ev.evicted)) fieldIssues.push('evicted is not a boolean');
  if (!isBoolean(ev.smoothnessOk)) fieldIssues.push('smoothnessOk is not a boolean');

  if (ev.loadFailureReason !== undefined && !isString(ev.loadFailureReason)) {
    fieldIssues.push('loadFailureReason must be a string when present');
  }

  if (ev.measuredWholeAppPeakMemoryMiB !== undefined && !isNonNegativeFiniteNumber(ev.measuredWholeAppPeakMemoryMiB)) {
    fieldIssues.push('measuredWholeAppPeakMemoryMiB must be a finite nonnegative number');
  }
  if (ev.avgTokensPerSecond !== undefined && !isNonNegativeFiniteNumber(ev.avgTokensPerSecond)) {
    fieldIssues.push('avgTokensPerSecond must be a finite nonnegative number');
  }
  if (ev.p95WallClockMs !== undefined && !isNonNegativeFiniteNumber(ev.p95WallClockMs)) {
    fieldIssues.push('p95WallClockMs must be a finite nonnegative number');
  }
  if (ev.p95TrueTTFTMs !== undefined && !isNonNegativeFiniteNumber(ev.p95TrueTTFTMs)) {
    fieldIssues.push('p95TrueTTFTMs must be a finite nonnegative number');
  }

  // Structural invariants for booleans.
  if (
    ev.smoothnessOk === true &&
    (ev.loadSuccess !== true || ev.oom === true || ev.evicted === true)
  ) {
    fieldIssues.push('smoothnessOk=true requires loadSuccess=true, oom=false and evicted=false');
  }
  if (ev.loadFailureReason !== undefined && (ev.loadFailureReason as string).length > 0 && ev.loadSuccess !== false) {
    fieldIssues.push('loadFailureReason requires loadSuccess=false');
  }

  if (fieldIssues.length > 0) {
    issues.push(...fieldIssues.map(m => `${modelId ?? key}: evidence ${m}`));
    if (modelId) {
      addDispositionCode(dispositionMap, modelId, ollamaTag, 'invalid-evidence', fieldIssues.join('; '));
    }
    return;
  }

  // Binding to a certified profile.
  if (!modelId) return;

  const candidate = safeProfiles.find((p) => p.modelId === modelId);
  if (!candidate) {
    issues.push(`${modelId}: runtimeValidationEvidence references a model not in the registry`);
    addDispositionCode(dispositionMap, modelId, ollamaTag, 'invalid-evidence', 'references a model not in the registry');
    return;
  }

  const bindIssues: string[] = [];
  if (ev.ollamaTag !== candidate.ollamaTag) bindIssues.push('ollamaTag does not match profile');
  if (ev.certificationVersion !== candidate.certificationVersion) bindIssues.push('certificationVersion does not match profile');
  if (ev.benchmarkSuiteVersion !== candidate.benchmarkSuiteVersion) bindIssues.push('benchmarkSuiteVersion does not match profile');
  if (ev.controlledContextSize !== candidate.controlledContextSize) bindIssues.push('controlledContextSize does not match profile');
  if (ev.thinking !== candidate.thinking) bindIssues.push('thinking does not match profile');
  if (ev.keepAlive !== candidate.keepAlive) bindIssues.push('keepAlive does not match profile');
  if (ev.runtime !== runtime) bindIssues.push(`runtime ${ev.runtime} does not match selector runtime ${runtime}`);
  if (ev.platform !== platform) bindIssues.push(`platform ${ev.platform} does not match selector platform ${platform}`);
  if (!candidate.certified) bindIssues.push('evidence provided for an uncertified profile');

  if (bindIssues.length > 0) {
    issues.push(...bindIssues.map((m) => `${modelId}: evidence ${m}`));
    addDispositionCode(dispositionMap, modelId, candidate.ollamaTag, 'invalid-evidence', bindIssues.join('; '));
  }
}

// ---------------------------------------------------------------------------
// Candidate classification
// ---------------------------------------------------------------------------

function classifyCandidates(
  safeProfiles: CertifiedModelProfile[],
  runtime: string,
  platform: string,
  evidenceById: Record<string, RuntimeValidationEvidence>,
  dispositionMap: Map<string, CandidateDisposition>
): void {
  for (const p of safeProfiles) {
    if (!p.certified) {
      addDispositionCode(dispositionMap, p.modelId, p.ollamaTag, 'uncertified', 'profile is not certified');
      continue;
    }

    const codes: CandidateDispositionCode[] = [];
    const explanations: string[] = [];

    if (!p.supportedRuntimes.includes(runtime)) {
      codes.push('runtime-incompatible');
      explanations.push(`runtime ${runtime} not in supported runtimes`);
    }
    if (!p.supportedOperatingSystems.includes(platform)) {
      codes.push('platform-incompatible');
      explanations.push(`platform ${platform} not in supported operating systems`);
    }

    if (codes.length > 0) {
      addDispositionCode(dispositionMap, p.modelId, p.ollamaTag, codes[0], explanations.join('; '));
      for (let i = 1; i < codes.length; i++) {
        addDispositionCode(dispositionMap, p.modelId, p.ollamaTag, codes[i]);
      }
      continue;
    }

    const ev = evidenceById[p.modelId];
    if (!ev) {
      addDispositionCode(dispositionMap, p.modelId, p.ollamaTag, 'validation-pending', 'no runtime validation evidence provided');
      continue;
    }

    // Evidence already structurally validated if we reached this point.
    const positive =
      ev.loadSuccess === true && ev.oom === false && ev.evicted === false && ev.smoothnessOk === true;

    if (positive) {
      addDispositionCode(dispositionMap, p.modelId, p.ollamaTag, 'validation-passed', 'runtime validation passed');
      continue;
    }

    const failureCodes: CandidateDispositionCode[] = [];
    const failureExplanations: string[] = [];
    if (ev.loadSuccess === false) {
      failureCodes.push('load-failed');
      failureExplanations.push(ev.loadFailureReason ?? 'initial load failed');
    }
    if (ev.oom === true) {
      failureCodes.push('oom');
      failureExplanations.push('out of memory during validation');
    }
    if (ev.evicted === true) {
      failureCodes.push('evicted');
      failureExplanations.push('model was evicted during validation');
    }
    if (ev.smoothnessOk === false) {
      failureCodes.push('smoothness-failed');
      failureExplanations.push('smoothness check failed');
    }

    const fullExplanation = failureExplanations.join('; ');
    for (let i = 0; i < failureCodes.length; i++) {
      addDispositionCode(dispositionMap, p.modelId, p.ollamaTag, failureCodes[i], i === 0 ? fullExplanation : '');
    }
  }
}

// ---------------------------------------------------------------------------
// Main selector
// ---------------------------------------------------------------------------

export function selectCertifiedModel(input: CertifiedModelSelectorInput): ModelSelectionResult {
  // Basic input validation.
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { kind: 'invalid-input', reason: 'selector input must be a non-null object', issues: ['input missing or not an object'], dispositions: [] };
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const registry = rawInput.registry;
  const runtimeRaw = rawInput.runtime;
  const platformRaw = rawInput.platform;
  const runtimeValidationEvidenceRaw = rawInput.runtimeValidationEvidence;

  const issues: string[] = [];
  const dispositions = new Map<string, CandidateDisposition>();

  if (!Array.isArray(registry)) issues.push('registry must be an array');
  if (!isNonBlankString(runtimeRaw)) issues.push('runtime must be a non-empty string');
  if (!isNonBlankString(platformRaw)) issues.push('platform must be a non-empty string');
  if (
    runtimeValidationEvidenceRaw !== undefined &&
    (runtimeValidationEvidenceRaw === null ||
      Array.isArray(runtimeValidationEvidenceRaw) ||
      typeof runtimeValidationEvidenceRaw !== 'object')
  ) {
    issues.push('runtimeValidationEvidence must be a non-null, non-array record');
  }

  if (issues.length > 0) {
    return {
      kind: 'invalid-input',
      reason: 'selector input is malformed',
      issues,
      dispositions: [],
    };
  }

  const runtime = (runtimeRaw as string).trim();
  const platform = (platformRaw as string).trim();
  const evidenceById =
    (runtimeValidationEvidenceRaw as Record<string, RuntimeValidationEvidence>) ?? {};

  const safeProfiles: CertifiedModelProfile[] = [];
  const seenModelIds = new Set<string>();
  const registryArray = registry as unknown[];

  for (let i = 0; i < registryArray.length; i++) {
    const safe = validateProfileStructure(registryArray[i], i, seenModelIds, dispositions, issues);
    if (safe) safeProfiles.push(safe);
  }

  if (Object.keys(evidenceById).length > 0) {
    for (const [key, ev] of Object.entries(evidenceById)) {
      validateEvidenceStructure(ev, key, safeProfiles, runtime, platform, dispositions, issues);
    }
  }

  // Classify all safe profiles for dispositions.
  classifyCandidates(safeProfiles, runtime, platform, evidenceById, dispositions);

  if (issues.length > 0) {
    return {
      kind: 'invalid-input',
      reason: 'selector input contains invalid registry entries or runtime evidence',
      issues,
      dispositions: sortedDispositions(dispositions),
    };
  }

  const certified = safeProfiles.filter((p) => p.certified === true);
  if (certified.length === 0) {
    return {
      kind: 'no-certified-profiles',
      dispositions: sortedDispositions(dispositions),
      reason: 'no profile in the registry is marked certified',
    };
  }

  const compatible = certified.filter(
    (p) => p.supportedRuntimes.includes(runtime) && p.supportedOperatingSystems.includes(platform)
  );
  if (compatible.length === 0) {
    return {
      kind: 'no-compatible-certified',
      dispositions: sortedDispositions(dispositions),
      reason: `no certified profile supports runtime=${runtime} and platform=${platform}`,
    };
  }

  const validated: CertifiedModelProfile[] = [];
  const pending: CertifiedModelProfile[] = [];
  const failed: CertifiedModelProfile[] = [];

  for (const p of compatible) {
    const ev = evidenceById[p.modelId];
    if (!ev) {
      pending.push(p);
    } else {
      const positive =
        ev.loadSuccess === true && ev.oom === false && ev.evicted === false && ev.smoothnessOk === true;
      if (positive) validated.push(p);
      else failed.push(p);
    }
  }

  if (validated.length > 0) {
    const rankedValidated = rankCandidates(validated, evidenceById, true);
    const selected = rankedValidated[0];
    const fallbackOrder = rankedValidated.slice(1);
    const validationOrder = rankCandidates(pending, evidenceById, false);
    return {
      kind: 'selected',
      selected,
      fallbackOrder,
      validationOrder,
      dispositions: sortedDispositions(dispositions),
      reason: `selected ${selected.modelId} from positively validated candidates`,
    };
  }

  if (pending.length > 0) {
    const validationOrder = rankCandidates(pending, evidenceById, false);
    return {
      kind: 'validation-required',
      validationOrder,
      fallbackOrder: [],
      dispositions: sortedDispositions(dispositions),
      reason: `no validated candidate; runtime validation required for ${pending.map((p) => p.modelId).join(', ')}`,
    };
  }

  return {
    kind: 'runtime-validation-failed',
    dispositions: sortedDispositions(dispositions),
    reason: 'all compatible certified candidates failed runtime validation',
  };
}
