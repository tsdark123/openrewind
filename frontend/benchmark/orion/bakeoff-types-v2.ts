import type {
  ChartActionIntent,
  AgentPlan,
  SemanticDate,
  SemanticPlayback,
  AnalysisRequest,
  ContextReference,
  ExecutionContextStore,
} from '../../src/lib/orion/agent/types';
import type { RepetitionResult, PromptScore, ModelScorecard } from './types';

// =============================================================================
// Orion Chapter 2A V2 bake-off types
//
// These types describe the V2 semantic certification contract. They mirror the
// production Orion agent types where appropriate, but they are deliberately
// self-contained so the V2 contract can be versioned independently.
// =============================================================================

export type V2PromptKind = 'chart_action' | 'clarification' | 'unsupported';
export type V2Bucket = 'primary' | 'deterministic' | 'precondition' | 'safety' | 'diagnostic';
export type V2Profile = 'active' | 'empty';

export interface V2SemanticDate {
  kind: 'absolute' | 'relative_trading' | 'relative_calendar';
  value?: string;
  count?: number;
  direction?: 'backward' | 'forward';
}

export interface V2SemanticPlayback {
  action: 'play' | 'pause' | 'play_until';
  speed?: number;
  untilTime?: string;
  direction?: 'forward' | 'backward';
}

// Re-use the production AnalysisRequest / AnalysisWindow shape, which already
// matches the V2 design plan.
export type V2AnalysisRequest = AnalysisRequest;

export type V2ContextReference = ContextReference;

export interface V2AcceptableAlternative {
  description?: string;
  requiredCapabilities: string[];
}

/**
 * Semantic expectation for a single V2 prompt, as defined in the design plan.
 * Field names mirror `v2-design-plan.json` so the JSON can be loaded directly.
 */
export interface V2SemanticExpectation {
  id: number;
  text: string;
  bucket: V2Bucket;
  expectedKind: V2PromptKind;
  requiredCapabilities: string[];
  forbiddenCapabilities: string[];
  expectedSymbol: string | null;
  expectedDate: V2SemanticDate | null;
  expectedTimeframe: number | null;
  expectedSeekTime: string | null;
  expectedMarketTime: string | null;
  expectedPlayback: V2SemanticPlayback | null;
  expectedAnalysisRequests: V2AnalysisRequest[];
  expectedAnalysisKinds: string[];
  expectedWindow: unknown | null;
  expectedContextReference: V2ContextReference | null;
  notes?: string;
  acceptableAlternatives: V2AcceptableAlternative[];
  reasonForChangeFromLegacy?: string;

  // Augmented fields that are not in the raw JSON but are derived for scoring.
  expectedFinalQuery?: 'current_candle' | 'candle_at_time' | 'compare_candles';
  expectedRelativeSeekMinutes?: number;
}

export interface V2BakeoffPrompt {
  id: number;
  text: string;
  profile: V2Profile;
  bucket: V2Bucket;
  expected: V2PromptKind;
  semanticGold: V2SemanticExpectation;
  /** Factory for a fresh, isolated ExecutionContextStore. */
  makeContext: () => { store: ExecutionContextStore; stateSymbol?: string };

  // Resolved gold caches (computed at module load).
  resolvedGold?: ChartActionIntent;
  resolvedGoldPlan?: AgentPlan;
  resolvedCapabilitySet?: string[];
}

export interface V2ScoreDiagnostics {
  pass: boolean;
  classificationMatch: boolean;
  kindCorrect: boolean;
  symbolCorrect: boolean;
  dateCorrect: boolean;
  timeframeCorrect: boolean;
  seekTimeCorrect: boolean;
  relativeSeekCorrect: boolean;
  marketTimeCorrect: boolean;
  playbackCorrect: boolean;
  finalQueryCorrect: boolean;
  analysisRequestsCorrect: boolean;
  contextReferenceResolved: boolean;
  capabilitySetMatch: boolean;
  noForbiddenCapabilities: boolean;
  extraCapabilities?: string;
  missingCapabilities?: string;
  notes?: string[];
}

export interface V2RepetitionScore {
  pass: boolean;
  classificationMatch: boolean;
  diagnostics: V2ScoreDiagnostics;
}

export interface V2PromptScore {
  promptId: number;
  bucket: V2Bucket;
  pass5: number;
  classificationMatchRate: number;
  total: number;
  passed: number;
}

export interface V2RepetitionResult extends RepetitionResult {
  v2Score: V2RepetitionScore;
}

export interface V2BakeoffOptions {
  model: string;
  repetitions?: number;
  numCtx?: number;
  numPredict?: number;
  temperature?: number;
  seed?: number;
  verbose?: boolean;
  productionHead?: string;
  ollamaVersion?: string;
  modelDigest?: string;
}

export interface V2ReportMetadata {
  certificationContractVersion: string;
  promptSuiteVersion: string;
  productionHead: string;
  modelTag: string;
  modelDigest?: string;
  ollamaVersion?: string;
  runtimeOptions: V2BakeoffOptions;
  scorerVersion: string;
  schemaVersion: string;
  timestamp: string;
  repetitionCount: number;
}

export interface V2ModelScorecard extends V2ReportMetadata {
  model: string;
  primaryRepetitionPassRate: number;
  primaryPromptPassRate: number;
  safetyExecutionRate: number;
  safetyClassificationAccuracy: number;
  preconditionPassRate: number;
  diagnosticPassRate: number;
  deterministicPassRate: number;
  recommendation: 'proceed' | 'finalist' | 'reject';
}

export interface V2Report {
  metadata: V2ReportMetadata;
  results: V2RepetitionResult[];
  promptScores: V2PromptScore[];
  scorecard: V2ModelScorecard;
}

// Keep legacy compatibility by re-exporting the V2 types as the canonical
// current contract without changing the existing `types.ts`.
export type { ChartActionIntent, AgentPlan, SemanticDate, SemanticPlayback, AnalysisRequest, ContextReference };
export type { RepetitionResult, PromptScore, ModelScorecard };
