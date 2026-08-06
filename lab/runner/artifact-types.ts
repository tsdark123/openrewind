import { z } from 'zod';

export const planSourceSchema = z.enum([
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

export type PlanSource = z.infer<typeof planSourceSchema>;

export const turnStatusSchema = z.enum(['pass', 'fail', 'skip', 'timeout', 'error']);

export type TurnStatus = z.infer<typeof turnStatusSchema>;

export const violationSchema = z.object({
  stage: z.string(),
  message: z.string(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});

export type Violation = z.infer<typeof violationSchema>;

export const turnResultSchema = z.object({
  turnId: z.string(),
  utterance: z.string(),
  status: turnStatusSchema,
  durationMs: z.number().int().optional(),
  route: planSourceSchema.optional(),
  plan: z.record(z.unknown()).optional(),
  capabilities: z.array(z.string()).default([]),
  receipts: z.array(z.record(z.unknown())).default([]),
  finalWorldState: z.record(z.unknown()).optional(),
  message: z.string().optional(),
  violations: z.array(violationSchema).default([]),
});

export type TurnResult = z.infer<typeof turnResultSchema>;

export const scenarioResultPayloadSchema = z.object({
  runId: z.string(),
  timestamp: z.string().datetime(),
  mode: z.enum(['fixture', 'production']),
  scenarioId: z.string(),
  repetition: z.number().int().default(1),
  model: z.string().optional(),
  engineUrl: z.string().optional(),
  dataSet: z.record(z.unknown()),
  status: turnStatusSchema,
  durationMs: z.number().int(),
  message: z.string().optional(),
  turns: z.array(turnResultSchema),
  note: z.string().default('fixture-mode lab validation; not real Orion certification'),
});

export type ScenarioResultPayload = z.infer<typeof scenarioResultPayloadSchema>;

export const scenarioResultEnvelopeSchema = z.object({
  type: z.literal('orion.scenario_result'),
  version: z.literal('1.0.0'),
  payload: scenarioResultPayloadSchema,
});

export type ScenarioResultEnvelope = z.infer<typeof scenarioResultEnvelopeSchema>;

export const runSummarySchema = z.object({
  runId: z.string(),
  mode: z.enum(['fixture', 'production']),
  timestamp: z.string().datetime(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  manifestSha: z.string().optional(),
  scenarioCount: z.number().int(),
  passCount: z.number().int(),
  failCount: z.number().int(),
  timeoutCount: z.number().int(),
  skipCount: z.number().int().default(0),
  model: z.string().optional(),
  engineUrl: z.string().optional(),
  ollamaUrl: z.string().optional(),
  note: z.string().default('fixture-mode lab validation; not real Orion certification'),
});

export type RunSummary = z.infer<typeof runSummarySchema>;

export const artifactEnvelopeSchema = z.union([
  scenarioResultEnvelopeSchema,
  z.object({
    type: z.literal('orion.run_summary'),
    version: z.literal('1.0.0'),
    payload: runSummarySchema,
  }),
]);

export type ArtifactEnvelope = z.infer<typeof artifactEnvelopeSchema>;

export function isScenarioResultEnvelope(
  value: unknown,
): value is ScenarioResultEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as Record<string, unknown>).type === 'orion.scenario_result'
  );
}
