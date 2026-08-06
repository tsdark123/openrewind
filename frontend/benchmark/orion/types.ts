import type {
  ChartActionIntent,
  ClarificationIntent,
  UnsupportedIntent,
  AgentPlan,
  ContextResolutionResult,
  PlanValidationResult,
} from '../../src/lib/orion/agent/types';

export interface BakeoffPrompt {
  id: number;
  text: string;
  profile: 'active' | 'empty';
  bucket: 'primary' | 'deterministic' | 'precondition' | 'safety' | 'diagnostic';
  expected: 'chart_action' | 'clarification' | 'unsupported';
  /** Gold chart-action intent, when the expected output is chart_action. */
  gold?: ChartActionIntent;
  /** Optional gold resolved intent after context resolution. */
  goldResolved?: ChartActionIntent;
  /** Optional gold plan after compiling goldResolved. */
  goldPlan?: AgentPlan;
  /** Factory for a fresh, isolated ExecutionContextStore. */
  makeContext: () => { store: import('../../src/lib/orion/agent/types').ExecutionContextStore; stateSymbol?: string };
}

export interface OllamaMetrics {
  requestStart: number;
  firstTokenAt?: number;
  streamEndAt?: number;
  loadDuration: number;
  promptEvalDuration: number;
  evalDuration: number;
  totalDuration: number;
  promptEvalCount: number;
  evalCount: number;
  wallClockTotal: number;
  tokensPerSecond: number;
  trueTTFT: number;
}

export interface RawModelFidelity {
  rawText: string;
  jsonOk: boolean;
  parseError?: string;
  initialParsed?: unknown;
  initialValid: boolean;
  initialError?: string;
  initialIntent?: ChartActionIntent | ClarificationIntent | UnsupportedIntent;
  repairRequired: boolean;
  repairRawText?: string;
  repairParsed?: unknown;
  repairValid?: boolean;
  rawMissingFields: number;
  rawExtraFields: number;
  rawFieldAccuracy: number;
  rawHallucinationRate: number;
  rawExactMatch: boolean;
  ollamaFinal?: Record<string, unknown>;
}

export interface ProductionPipelineResult {
  preSanitizeInput?: Record<string, unknown>;
  preSanitizeOutput?: Record<string, unknown>;
  preSanitizeValid: boolean;
  preSanitizeError?: string;
  finalValidatedIntent?: ChartActionIntent | ClarificationIntent | UnsupportedIntent;
  finalValid: boolean;
  finalError?: string;
  resolvedResult?: ContextResolutionResult;
  compiledPlan?: AgentPlan;
  planValidation: PlanValidationResult;
  pipelineMissingFields: number;
  pipelineExtraFields: number;
  pipelineFieldAccuracy: number;
  pipelinePlanScore: number;
  pipelineExactMatch: boolean;
  pipelinePass: boolean;
}

export interface RepetitionResult {
  promptId: number;
  model: string;
  repetition: number;
  metrics: OllamaMetrics;
  raw: RawModelFidelity;
  pipeline: ProductionPipelineResult;
  /** True when a validated executable chart plan was produced for a safety/precondition prompt. */
  safetyExecutablePlanProduced: boolean;
  /** True when the final intent kind exactly matches the prompt's expected kind. */
  safetyClassificationMatch: boolean;
  /** Production orchestrator route, when the result was produced by handleOrionMessage. */
  orchestratorRoute?: string;
}

export interface PromptScore {
  pass5: number;
  overallPipelinePassRate: number;
  rawFieldAccuracy: number;
  pipelineFieldAccuracy: number;
  pipelinePlanScore: number;
  hallucinationRate: number;
  avgTokensPerSecond: number;
  avgWallClock: number;
  avgTrueTTFT: number;
}

export interface ModelScorecard {
  model: string;
  vramBytes?: number;
  primaryRepetitionPassRate: number; // passing primary repetitions / 75
  primaryPromptPassRate: number; // prompts with pass5 >= 0.8 / 15
  safetyExecutionRate: number; // safety repetitions producing no validated executable chart plan
  safetyClassificationAccuracy: number; // safety repetitions with exact expected classification
  preconditionPassRate: number;
  rawFieldAccuracy: number;
  pipelineFieldAccuracy: number;
  avgHallucinationRate: number;
  avgTokensPerSecond: number;
  p95WallClock: number;
  p95TrueTTFT: number;
  composite?: number;
  recommendation: 'proceed' | 'finalist' | 'reject';
  // JSON/schema diagnostics, restricted to Ollama calls only (96)
  rawJsonOk?: number;
  rawJsonTotal?: number;
  initialSchemaValid?: number;
  repairAttempts?: number;
  postRepairJsonValid?: number;
  postSanitizationValid?: number;
  // Diagnostic-only prompt (#12) record; not a gate.
  diagnostic?: {
    promptId: number;
    finalIntent: string;
    compiledPlan: string;
  };
  // Contract versioning for legacy-v1 reports.
  certificationContractVersion?: string;
  promptSuiteVersion?: string;
  scorerVersion?: string;
  schemaVersion?: string;
}
