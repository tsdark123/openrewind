import { z } from 'zod';

export const analysisWindowSchema = z.union([
  z.object({ kind: z.literal('whole_session') }),
  z.object({ kind: z.literal('up_to_cursor') }),
  z.object({
    kind: z.literal('time_range'),
    fromTime: z.string().regex(/^\d{2}:\d{2}$/),
    toTime: z.string().regex(/^\d{2}:\d{2}$/),
  }),
]);

export type AnalysisWindow = z.infer<typeof analysisWindowSchema>;

export const analysisRequestSchema = z.union([
  z.object({
    kind: z.literal('window_ohlc'),
    window: analysisWindowSchema.optional(),
  }),
  z.object({
    kind: z.literal('window_change'),
    window: analysisWindowSchema.optional(),
  }),
  z.object({
    kind: z.literal('window_volume'),
    window: analysisWindowSchema.optional(),
  }),
  z.object({
    kind: z.literal('window_compare'),
    left: analysisWindowSchema.optional(),
    right: analysisWindowSchema.optional(),
  }),
  z.object({
    kind: z.literal('candle_shape'),
    source: z.enum(['current_chart_candle', 'market_time']),
    marketTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }),
  z.object({
    kind: z.literal('window_summary'),
    window: analysisWindowSchema.optional(),
  }),
]);

export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;

export const semanticDateSchema = z.object({
  kind: z.enum(['absolute', 'relative_trading', 'relative_calendar']),
  value: z.string().optional(),
  count: z.number().int().optional(),
  direction: z.enum(['backward', 'forward']).optional(),
});

export type SemanticDate = z.infer<typeof semanticDateSchema>;

export const playbackActionSchema = z.enum(['play', 'pause', 'play_until']);

export const semanticPlaybackSchema = z.object({
  action: playbackActionSchema,
  speed: z.number().int().optional(),
  untilTime: z.string().optional(),
  direction: z.enum(['forward', 'backward']).optional(),
});

export type SemanticPlayback = z.infer<typeof semanticPlaybackSchema>;

export const contextReferenceSchema = z.object({
  source: z.enum(['latest_successful_action', 'latest_failed_action', 'latest_returned_candle']),
  mode: z.enum(['repeat', 'inherit', 'use_as_target', 'anchor_relative_date']).optional(),
  inherit: z.array(z.string()).optional(),
});

export type ContextReference = z.infer<typeof contextReferenceSchema>;

export const compareSideSchema = z.object({
  source: z.enum(['latest_returned_candle', 'previous_returned_candle', 'current_chart_candle', 'market_time']),
  marketTime: z.string().optional(),
});

export type CompareSide = z.infer<typeof compareSideSchema>;

export const compareSidesSchema = z.object({
  left: compareSideSchema,
  right: compareSideSchema,
});

export type CompareSides = z.infer<typeof compareSidesSchema>;

export const actionTemplateSchema = z.object({
  kind: z.literal('chart_action').default('chart_action'),
  symbol: z.string().optional(),
  date: semanticDateSchema.optional(),
  timeframeMinutes: z.number().int().optional(),
  seekTime: z.string().optional(),
  relativeSeekMinutes: z.number().int().optional(),
  playback: semanticPlaybackSchema.optional(),
  finalQuery: z.enum(['current_candle', 'candle_at_time', 'compare_candles']).optional(),
  queryTime: z.string().optional(),
  previousSymbol: z.boolean().optional(),
  contextReference: contextReferenceSchema.optional(),
  compare: compareSidesSchema.optional(),
  analysisRequests: z.array(analysisRequestSchema).optional(),
});

export type ActionTemplate = z.infer<typeof actionTemplateSchema>;

export const agentStepSchema = z.object({
  id: z.string(),
  capability: z.string(),
  args: z.record(z.unknown()).default({}),
  required: z.boolean().optional(),
  dependsOn: z.array(z.string()).optional(),
  rationale: z.string().optional(),
});

export type AgentStep = z.infer<typeof agentStepSchema>;

export const planKindSchema = z.enum(['chat', 'query', 'action', 'mixed']);

export const agentPlanSchema = z.object({
  id: z.string(),
  kind: planKindSchema,
  summary: z.string(),
  steps: z.array(agentStepSchema).default([]),
  chat: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});

export type AgentPlan = z.infer<typeof agentPlanSchema>;

export const routeSchema = z.enum([
  'llm-plan',
  'deterministic',
  'clarification',
  'unsupported',
  'chat',
  'error',
  'resolve',
  'recent-action-summary',
  'unrecognized',
  'aborted',
  'ui-action',
]);

export type Route = z.infer<typeof routeSchema>;

export const exactInvariantsSchema = z.object({
  symbol: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timeframe: z.number().int().optional(),
  marketOpen: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  marketClose: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezoneOffsetHours: z.number().int().optional(),
  window: analysisWindowSchema.optional(),
  seekTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  marketTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

export type ExactInvariants = z.infer<typeof exactInvariantsSchema>;

export const receiptCheckSchema = z.object({
  turnId: z.string().optional(),
  capability: z.string(),
  success: z.boolean().optional(),
  errorCode: z.string().optional(),
  messageRegex: z.string().optional(),
  dataShape: z.record(z.unknown()).optional(),
});

export type ReceiptCheck = z.infer<typeof receiptCheckSchema>;

export const numericTruthToleranceSchema = z.object({
  absolute: z.number().optional(),
  relative: z.number().optional(),
});

export type NumericTruthTolerance = z.infer<typeof numericTruthToleranceSchema>;

export const numericTruthComputedSchema = z.object({
  source: z.enum(['engine', 'fixture']).default('fixture'),
  capability: z.string(),
  symbol: z.string().optional(),
  date: z.string().optional(),
  timeframe: z.number().int().optional(),
  window: analysisWindowSchema.optional(),
  left: analysisWindowSchema.optional(),
  right: analysisWindowSchema.optional(),
  marketTime: z.string().optional(),
});

export type NumericTruthComputed = z.infer<typeof numericTruthComputedSchema>;

export const numericTruthCheckSchema = z.object({
  turnId: z.string().optional(),
  receiptCapability: z.string(),
  computed: numericTruthComputedSchema,
  tolerance: numericTruthToleranceSchema.default({}),
});

export type NumericTruthCheck = z.infer<typeof numericTruthCheckSchema>;

export const numericEquivalenceConfigSchema = z.object({
  priceAbsolute: z.number().default(0.005),
  priceRelative: z.number().default(0.001),
  volumeAbsolute: z.number().default(1),
  volumeRelative: z.number().default(0.001),
  percentAbsolute: z.number().default(0.05),
  percentRelative: z.number().default(0.001),
  approximateRelative: z.number().default(0.02),
  approximateWords: z.array(z.string()).default(['about', 'around', 'approximately', '~', 'roughly', 'nearly']),
  compactSuffixes: z.record(z.number()).default({ K: 1e3, M: 1e6, B: 1e9, k: 1e3, m: 1e6, b: 1e9 }),
});

export type NumericEquivalenceConfig = z.infer<typeof numericEquivalenceConfigSchema>;

export const consumerResponseExpectationsSchema = z.object({
  mustContain: z.array(z.string()).default([]),
  mustNotContain: z.array(z.string()).default([]),
  mustMatch: z.array(z.string()).default([]),
  forbiddenTopics: z.array(z.string()).default([]),
  maxLength: z.number().int().optional(),
  numericEquivalence: numericEquivalenceConfigSchema.optional(),
});

export type ConsumerResponseExpectations = z.infer<typeof consumerResponseExpectationsSchema>;

export const inheritanceEdgeSchema = z.object({
  fromTurn: z.string(),
  toTurn: z.string(),
  mode: z.enum(['repeat', 'inherit', 'use_as_target', 'anchor_relative_date']),
  fields: z.array(z.string()).default([]),
  expectedAnalysisRequests: z.array(analysisRequestSchema).optional(),
});

export type InheritanceEdge = z.infer<typeof inheritanceEdgeSchema>;

export const unsupportedCheckSchema = z.object({
  utterance: z.string(),
  expectedRoute: z.enum(['unsupported', 'clarification']).default('unsupported'),
  expectedMessageRegex: z.string().optional(),
  mustNotExecuteCapabilities: z.boolean().default(true),
});

export type UnsupportedCheck = z.infer<typeof unsupportedCheckSchema>;

export const latencyLimitsSchema = z.object({
  maxMsPerTurn: z.number().int().optional(),
  maxMsPlanCompile: z.number().int().optional(),
  maxMsExecution: z.number().int().optional(),
  maxMsTTFT: z.number().int().optional(),
  maxMsTotal: z.number().int().optional(),
});

export type LatencyLimits = z.infer<typeof latencyLimitsSchema>;

export const expectedFinalWorldStateSchema = z.object({
  symbol: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timeframe: z.number().int().optional(),
  cursor: z.number().int().optional(),
  totalCandles: z.number().int().optional(),
  isPlaying: z.boolean().optional(),
  speed: z.number().int().optional(),
  direction: z.enum(['forward', 'backward']).optional(),
  currentPrice: z.number().optional(),
  sessionActive: z.boolean().optional(),
}).optional();

export type ExpectedFinalWorldState = z.infer<typeof expectedFinalWorldStateSchema>;

export const turnSchema = z.object({
  id: z.string(),
  utterance: z.string(),
  expectedOk: z.boolean().default(true),
  expectedRoute: routeSchema.optional(),
  assertExactRoute: z.boolean().default(false),
  expectedPlan: agentPlanSchema.optional(),
  assertExactPlan: z.boolean().default(false),
  expectedCapabilities: z.array(z.string()).default([]),
  permittedActions: z.array(z.string()).optional(),
  forbiddenActions: z.array(z.string()).optional(),
  exactInvariants: exactInvariantsSchema.optional(),
  expectedContextAfter: actionTemplateSchema.optional(),
  expectedContextUnchanged: z.boolean().default(false),
  expectedReceipts: z.array(receiptCheckSchema).default([]),
  expectedFinalWorldState: expectedFinalWorldStateSchema,
  numericalTruthChecks: z.array(numericTruthCheckSchema).default([]),
  consumerResponseExpectations: consumerResponseExpectationsSchema.optional(),
  latencyMs: z.number().int().optional(),
});

export type Turn = z.infer<typeof turnSchema>;

export const candleDataSchema = z.object({
  timestamp: z.number().int(),
  marketTime: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

export type CandleData = z.infer<typeof candleDataSchema>;

export const worldStateSessionSchema = z.object({
  symbol: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeframe: z.number().int(),
  cursor: z.number().int(),
  totalCandles: z.number().int(),
  isPlaying: z.boolean(),
  speed: z.number().int(),
  direction: z.enum(['forward', 'backward']),
  currentPrice: z.number(),
  sessionActive: z.boolean(),
});

export type WorldStateSession = z.infer<typeof worldStateSessionSchema>;

export const groundTruthSchema = z.object({
  source: z.enum(['engine', 'fixture']),
  fixture: z.string().optional(),
  note: z.string().optional(),
});

export type GroundTruth = z.infer<typeof groundTruthSchema>;

export const worldStateSchema = z.object({
  session: worldStateSessionSchema,
  availableTickers: z.array(z.string()).default([]),
  recentCandles: z.array(candleDataSchema).default([]),
  groundTruth: groundTruthSchema.optional(),
});

export type WorldState = z.infer<typeof worldStateSchema>;

export const dataSetSchema = z.object({
  symbol: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeframe: z.number().int(),
});

export type DataSet = z.infer<typeof dataSetSchema>;

export const scenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  version: z.string().default('2.0.0'),
  familyId: z.string().optional(),
  seedId: z.string().optional(),
  variantOf: z.string().optional(),
  tags: z.array(z.string()).default([]),
  dataSet: dataSetSchema,
  initialWorldState: worldStateSchema,
  exactInvariants: exactInvariantsSchema.default({}),
  expectedCapabilities: z.array(z.string()).default([]),
  permittedActions: z.array(z.string()).default([]),
  forbiddenActions: z.array(z.string()).default([]),
  expectedContextInheritance: z.array(inheritanceEdgeSchema).default([]),
  consumerResponseExpectations: consumerResponseExpectationsSchema.optional(),
  knownUnsupportedBehavior: z.array(unsupportedCheckSchema).default([]),
  latencyLimits: latencyLimitsSchema.default({}),
  turns: z.array(turnSchema).min(1),
  meta: z.record(z.unknown()).optional(),
});

export type Scenario = z.infer<typeof scenarioSchema>;
