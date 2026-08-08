// =============================================================================
// runtimeValidationWorkload.ts — frozen Slice 2A workload contract for the
// Chapter 2B runtime validator.
//
// This module performs no I/O. It owns the versioned, production-derived
// messages and the cold/warm request shapes that the eventual Ollama adapter
// will use to collect identity-bound, candidate-scoped runtime evidence.
//
// The approved smoothness policy (warm sample count and latency thresholds)
// remains owned by `runtimeValidationOrchestrator.ts`; this file only consumes
// it and must not redefine it.
// =============================================================================

import { buildIntentExtractionPrompt } from './agent/intent';
import type {
  DeepReadonly,
  RuntimeValidationCandidateInput,
} from './runtimeValidationOrchestrator';

/**
 * Immutable workload version. Any change to messages, options, timeouts,
 * sample handling or the percentile contract requires a new version.
 */
export const RUNTIME_VALIDATION_WORKLOAD_VERSION = 'orion-runtime-validation-v1' as const;

/**
 * The exact first primary compound prompt from the certified benchmark suite.
 * Source: `frontend/benchmark/orion/bakeoff-suite.ts` PRIMARY_PROMPTS[0].
 */
export const RUNTIME_VALIDATION_USER_PROMPT =
  'Could you set me up on Nvidia for the prior trading session, use fifteen-minute bars, park the replay at quarter past eleven and tell me what candle I am on?';

/**
 * Ollama chat generation options used for runtime validation.
 */
export interface RuntimeValidationChatRequestDescription {
  /** Candidate-scoped model tag; never the active override model. */
  readonly model: string;
  /** Frozen production-derived system + user messages. */
  readonly messages: ReadonlyArray<Readonly<{ readonly role: 'system' | 'user'; readonly content: string }>>;
  /** Streaming is required for truthful first-token timing. */
  readonly stream: true;
  /** Validation uses the same JSON intent format as production. */
  readonly format: 'json';
  /** Mirrors the certified profile's thinking flag. */
  readonly think: boolean;
  /** Mirrors the certified profile's keep-alive policy. */
  readonly keepAlive: string;
  /** Mirrors the certified profile's controlled context size. */
  readonly numCtx: number;
  /** Certified validation temperature: always 0. */
  readonly temperature: 0;
  /** Certified validation seed: always 42. */
  readonly seed: 42;
  /** Phase-specific output-token ceiling. */
  readonly numPredict: number;
  /** Phase-specific per-call timeout in milliseconds. */
  readonly timeoutMs: number;
}

const COLD_NUM_PREDICT = 1;
const WARM_NUM_PREDICT = 160;
const COLD_TIMEOUT_MS = 300_000;
const WARM_TIMEOUT_MS = 120_000;

/**
 * Cached system prompt from the production full-schema/no-context intent
 * extraction prompt. Strings are immutable, so this is safe to share; message
 * arrays and message objects are still newly allocated for each call.
 */
const WORKLOAD_SYSTEM_PROMPT = buildIntentExtractionPrompt();

function newFrozenMessages(): ReadonlyArray<Readonly<{ role: 'system' | 'user'; content: string }>> {
  const messages = [
    Object.freeze({ role: 'system' as const, content: WORKLOAD_SYSTEM_PROMPT }),
    Object.freeze({ role: 'user' as const, content: RUNTIME_VALIDATION_USER_PROMPT }),
  ];
  return Object.freeze(messages);
}

/**
 * Return the frozen, production-derived workload messages.
 *
 * The array and each message object are newly allocated and recursively
 * frozen, so callers cannot mutate the workload or leak aliases.
 */
export function buildRuntimeValidationMessages(): ReadonlyArray<
  Readonly<{ role: 'system' | 'user'; content: string }>
> {
  return newFrozenMessages();
}

/**
 * Build a frozen, candidate-scoped runtime-validation request description for
 * one cold-load call or one warm sample.
 *
 * - Uses the certified profile's `ollamaTag`, `thinking`, `keepAlive` and
 *   `controlledContextSize` directly. Never resolves the active model or
 *   environment overrides.
 * - Cold phase uses `numPredict: 1` to probe model loading only.
 * - Warm phase uses `numPredict: 160` (the canonical bake-off ceiling) for a
 *   representative generation sample. Actual token throughput comes from the
 *   final streaming chunk's `eval_count` / `eval_duration`, not from 160.
 */
export function buildRuntimeValidationRequest(
  candidateInput: DeepReadonly<RuntimeValidationCandidateInput>,
  phase: 'cold' | 'warm'
): DeepReadonly<RuntimeValidationChatRequestDescription> {
  const isCold = phase === 'cold';

  // Clone the frozen messages so this request owns its own allocation and
  // cannot leak aliases to other requests.
  const messages = newFrozenMessages().map((m) => Object.freeze({ ...m }));
  Object.freeze(messages);

  const request: RuntimeValidationChatRequestDescription = {
    model: candidateInput.profile.ollamaTag,
    messages,
    stream: true,
    format: 'json',
    think: candidateInput.profile.thinking,
    keepAlive: candidateInput.profile.keepAlive,
    numCtx: candidateInput.profile.controlledContextSize,
    temperature: 0,
    seed: 42,
    numPredict: isCold ? COLD_NUM_PREDICT : WARM_NUM_PREDICT,
    timeoutMs: isCold ? COLD_TIMEOUT_MS : WARM_TIMEOUT_MS,
  };

  return Object.freeze(request) as DeepReadonly<RuntimeValidationChatRequestDescription>;
}

/**
 * Pure nearest-rank percentile, matching the canonical benchmark algorithm.
 *
 * Sorts a copy ascending and returns the element at index
 * `ceil((percentile / 100) * count) - 1` clamped to `[0, count - 1]`.
 *
 * Requirements:
 * - rejects empty samples;
 * - rejects non-finite or negative samples;
 * - rejects percentiles outside `(0, 100]`;
 * - never mutates the caller's array.
 */
export function percentileNearestRank(
  samples: ReadonlyArray<number>,
  percentile: number
): number {
  if (samples.length === 0) {
    throw new RangeError('Cannot compute percentile of an empty sample set');
  }
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new RangeError('Percentile must be a finite number in (0, 100]');
  }

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!Number.isFinite(s) || s < 0) {
      throw new RangeError(`Sample at index ${i} is not a finite, non-negative number`);
    }
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
