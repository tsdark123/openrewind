import type {
  Scenario,
  Turn,
  NumericEquivalenceConfig,
  AnalysisWindow,
  ActionTemplate,
} from './scenario-types.ts';
import type { AgentTurnResult } from './adapters/agent-adapter.ts';
import type { TurnResult, Violation } from './artifact-types.ts';
import type { ReferenceCandle } from '../reference/types.ts';
import { computeCapability } from '../reference/calculator.ts';
import {
  allowedNumbersFromObject,
  checkConsumerNumericEquivalence,
} from './numeric-equivalence.ts';
import { validateCapabilityName } from './capability-registry.ts';

export interface EvaluateTurnOptions {
  scenario: Scenario;
  turn: Turn;
  turnResult: AgentTurnResult;
  previousResults: AgentTurnResult[];
  referenceCandles: ReferenceCandle[];
  durationMs?: number;
}

export function matchesGlob(value: string, glob: string): boolean {
  const parts = glob.split('.');
  const valueParts = value.split('.');
  if (parts.length !== valueParts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '*') continue;
    if (parts[i] !== valueParts[i]) return false;
  }
  return true;
}

export function matchesAnyGlob(value: string, globs: string[]): boolean {
  return globs.some((g) => matchesGlob(value, g));
}

function deepEqual(a: unknown, b: unknown, tolerance = 1e-9): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return Math.abs(a - (b as number)) <= tolerance;
  if (typeof a === 'string' || typeof a === 'boolean') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i], tolerance));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tolerance),
    );
  }
  return false;
}

function windowsEqual(a?: AnalysisWindow, b?: AnalysisWindow): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'time_range') {
    return a.fromTime === (b as { fromTime?: string }).fromTime && a.toTime === (b as { toTime?: string }).toTime;
  }
  return true;
}

function templateWindow(template?: ActionTemplate): AnalysisWindow | undefined {
  const first = template?.analysisRequests?.[0] as any;
  if (!first) return undefined;
  if (first.kind === 'window_compare') return first.left;
  return first.window;
}

function templateMarketTime(template?: ActionTemplate): string | undefined {
  const first = template?.analysisRequests?.[0] as { kind?: string; marketTime?: string } | undefined;
  if (first?.kind === 'candle_shape') return first.marketTime;
  return undefined;
}

function checkStatusAndSafety(
  turn: Turn,
  result: AgentTurnResult,
  violations: Violation[],
): void {
  if (turn.expectedOk !== undefined && result.ok !== turn.expectedOk) {
    violations.push({
      stage: 'status',
      message: `Expected ok=${turn.expectedOk}, got ok=${result.ok}`,
      expected: turn.expectedOk,
      actual: result.ok,
    });
  }
}

function checkForbiddenAndPermitted(
  turn: Turn,
  result: AgentTurnResult,
  violations: Violation[],
): void {
  for (const cap of result.capabilities) {
    if (turn.forbiddenActions && matchesAnyGlob(cap, turn.forbiddenActions)) {
      violations.push({
        stage: 'forbidden',
        message: `Capability ${cap} is forbidden`,
        actual: cap,
      });
    }
  }

  if (turn.permittedActions && turn.permittedActions.length > 0) {
    for (const cap of result.capabilities) {
      if (!matchesAnyGlob(cap, turn.permittedActions)) {
        violations.push({
          stage: 'permitted',
          message: `Capability ${cap} is not in permitted list`,
          actual: cap,
        });
      }
    }
  }
}

function checkRequiredCapabilities(
  turn: Turn,
  result: AgentTurnResult,
  violations: Violation[],
): void {
  for (const required of turn.expectedCapabilities ?? []) {
    if (!result.capabilities.some((c) => matchesGlob(c, required))) {
      violations.push({
        stage: 'required-capability',
        message: `Missing required capability ${required}`,
        expected: required,
        actual: result.capabilities,
      });
    }
  }
}

function checkGroundingInvariants(
  turn: Turn,
  result: AgentTurnResult,
  violations: Violation[],
): void {
  const invariants = turn.exactInvariants;
  if (!invariants) return;

  const template = result.template as ActionTemplate | undefined;
  const state = result.finalWorldState as Record<string, unknown> | undefined;

  if (invariants.symbol && template?.symbol !== invariants.symbol && state?.symbol !== invariants.symbol) {
    violations.push({
      stage: 'grounding',
      message: `Symbol invariant mismatch`,
      expected: invariants.symbol,
      actual: template?.symbol ?? state?.symbol,
    });
  }

  if (invariants.date) {
    const templateDate =
      template?.date?.kind === 'absolute' ? template.date.value : undefined;
    if (templateDate !== invariants.date && state?.date !== invariants.date) {
      violations.push({
        stage: 'grounding',
        message: `Date invariant mismatch`,
        expected: invariants.date,
        actual: templateDate ?? state?.date,
      });
    }
  }

  if (invariants.timeframe !== undefined) {
    if (template?.timeframeMinutes !== invariants.timeframe && state?.timeframe !== invariants.timeframe) {
      violations.push({
        stage: 'grounding',
        message: `Timeframe invariant mismatch`,
        expected: invariants.timeframe,
        actual: template?.timeframeMinutes ?? state?.timeframe,
      });
    }
  }

  if (invariants.window && !windowsEqual(templateWindow(template), invariants.window)) {
    violations.push({
      stage: 'grounding',
      message: `Window invariant mismatch`,
      expected: invariants.window,
      actual: templateWindow(template),
    });
  }

  if (invariants.marketTime && templateMarketTime(template) !== invariants.marketTime) {
    violations.push({
      stage: 'grounding',
      message: `MarketTime invariant mismatch`,
      expected: invariants.marketTime,
      actual: templateMarketTime(template),
    });
  }

  if (invariants.seekTime && template?.seekTime !== invariants.seekTime) {
    violations.push({
      stage: 'grounding',
      message: `SeekTime invariant mismatch`,
      expected: invariants.seekTime,
      actual: template?.seekTime,
    });
  }
}

function checkContextInheritance(
  scenario: Scenario,
  turn: Turn,
  result: AgentTurnResult,
  previousResults: AgentTurnResult[],
  violations: Violation[],
): void {
  if (turn.expectedContextUnchanged) {
    const previous = previousResults[previousResults.length - 1];
    const previousTemplate = previous?.template as ActionTemplate | undefined;

    if (result.capabilities && result.capabilities.length > 0) {
      violations.push({
        stage: 'context',
        message: `Context was expected to be unchanged, but capabilities were emitted: ${result.capabilities.join(', ')}`,
        actual: result.capabilities,
      });
    }

    if (result.receipts && result.receipts.length > 0) {
      violations.push({
        stage: 'context',
        message: `Context was expected to be unchanged, but execution receipts were produced`,
        actual: result.receipts.map((r) => (r as { capability?: string }).capability ?? 'unknown'),
      });
    }

    if (result.template && !deepEqual(result.template, previousTemplate ?? {})) {
      violations.push({
        stage: 'context',
        message: `Context was expected to be unchanged, but the template changed`,
        expected: previousTemplate,
        actual: result.template,
      });
    }
    return;
  }

  if (turn.expectedContextAfter) {
    if (!deepEqual(result.template, turn.expectedContextAfter)) {
      violations.push({
        stage: 'context',
        message: `Post-turn context template mismatch`,
        expected: turn.expectedContextAfter,
        actual: result.template,
      });
    }
  }

  for (const edge of scenario.expectedContextInheritance) {
    if (edge.toTurn !== turn.id) continue;
    const fromResult = previousResults.find((_r, i) => scenario.turns[i]?.id === edge.fromTurn);
    const fromTemplate = fromResult?.template as ActionTemplate | undefined;
    if (!fromTemplate) {
      violations.push({
        stage: 'context-inheritance',
        message: `Could not find source turn ${edge.fromTurn}`,
      });
      continue;
    }
    if (edge.expectedAnalysisRequests && !deepEqual(result.template?.analysisRequests, edge.expectedAnalysisRequests)) {
      violations.push({
        stage: 'context-inheritance',
        message: `Inherited analysisRequests mismatch`,
        expected: edge.expectedAnalysisRequests,
        actual: result.template?.analysisRequests,
      });
    }
  }
}

function matchesDataShape(data: unknown, shape: Record<string, unknown>): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  for (const key of Object.keys(shape)) {
    if (!(key in record)) return false;
  }
  return true;
}

function checkReceipts(
  turn: Turn,
  result: AgentTurnResult,
  violations: Violation[],
): void {
  for (const expected of turn.expectedReceipts ?? []) {
    const receipt = result.receipts.find(
      (r) => (r as { capability?: string }).capability === expected.capability,
    );
    if (!receipt) {
      violations.push({
        stage: 'receipt',
        message: `Missing receipt for capability ${expected.capability}`,
        expected: expected.capability,
      });
      continue;
    }
    if (expected.success !== undefined && (receipt as { success?: boolean }).success !== expected.success) {
      violations.push({
        stage: 'receipt',
        message: `Receipt success mismatch for ${expected.capability}`,
        expected: expected.success,
        actual: (receipt as { success?: boolean }).success,
      });
    }
    if (expected.errorCode && (receipt as { errorCode?: string }).errorCode !== expected.errorCode) {
      violations.push({
        stage: 'receipt',
        message: `Receipt errorCode mismatch for ${expected.capability}`,
        expected: expected.errorCode,
        actual: (receipt as { errorCode?: string }).errorCode,
      });
    }
    if (expected.messageRegex) {
      const message = String((receipt as { message?: string }).message ?? '');
      if (!new RegExp(expected.messageRegex).test(message)) {
        violations.push({
          stage: 'receipt',
          message: `Receipt message does not match ${expected.messageRegex}`,
          actual: message,
        });
      }
    }
    if (expected.dataShape && !matchesDataShape((receipt as { data?: unknown }).data, expected.dataShape)) {
      violations.push({
        stage: 'receipt',
        message: `Receipt data shape mismatch for ${expected.capability}`,
        expected: Object.keys(expected.dataShape),
        actual: Object.keys((receipt as { data?: Record<string, unknown> }).data ?? {}),
      });
    }
  }
}

function compareNumericFields(
  expected: Record<string, unknown>,
  actual: unknown,
  tolerance: { absolute?: number; relative?: number },
  prefix = '',
  violations: Violation[],
): void {
  if (typeof actual !== 'object' || actual === null) {
    violations.push({
      stage: 'numeric',
      message: `Receipt data is not an object at ${prefix || 'root'}`,
    });
    return;
  }
  const record = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) continue;
    if (typeof value === 'number') {
      if (!(key in record) || typeof record[key] !== 'number') {
        violations.push({
          stage: 'numeric',
          message: `Missing numeric field ${fullKey}`,
          expected: value,
          actual: record[key],
        });
        continue;
      }
      const actualValue = record[key] as number;
      const abs = tolerance.absolute ?? 1e-9;
      const rel = tolerance.relative ?? 1e-9;
      const tol = Math.max(abs, rel * Math.max(1, Math.abs(value)));
      if (Math.abs(value - actualValue) > tol) {
        violations.push({
          stage: 'numeric',
          message: `Numeric mismatch at ${fullKey}`,
          expected: value,
          actual: actualValue,
        });
      }
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      compareNumericFields(value as Record<string, unknown>, record[key], tolerance, fullKey, violations);
    }
  }
}

function checkNumericalTruth(
  turn: Turn,
  result: AgentTurnResult,
  referenceCandles: ReferenceCandle[],
  violations: Violation[],
): void {
  for (const check of turn.numericalTruthChecks ?? []) {
    const receipt = result.receipts.find(
      (r) => (r as { capability?: string }).capability === check.receiptCapability,
    );
    if (!receipt) {
      violations.push({
        stage: 'numeric',
        message: `Cannot run numerical truth: missing receipt ${check.receiptCapability}`,
      });
      continue;
    }

    const computed = check.computed;
    const window = computed.window
      ? (computed.window as { kind: string; fromTime?: string; toTime?: string })
      : { kind: 'whole_session' };
    const ref = computeCapability(referenceCandles, {
      capability: computed.capability,
      window: window as any,
      left: computed.left as any,
      right: computed.right as any,
      marketTime: computed.marketTime,
    });

    compareNumericFields(
      ref as unknown as Record<string, unknown>,
      (receipt as { data?: unknown }).data,
      check.tolerance,
      '',
      violations,
    );
  }
}

function checkFinalWorldState(
  turn: Turn,
  result: AgentTurnResult,
  previousResults: AgentTurnResult[],
  violations: Violation[],
): void {
  const state = result.finalWorldState as Record<string, unknown> | undefined;
  if (!state) return;

  const invariants = turn.exactInvariants;
  if (invariants?.symbol && state.symbol !== invariants.symbol) {
    violations.push({
      stage: 'final-world-state',
      message: `Final symbol mismatch`,
      expected: invariants.symbol,
      actual: state.symbol,
    });
  }
  if (invariants?.date && state.date !== invariants.date) {
    violations.push({
      stage: 'final-world-state',
      message: `Final date mismatch`,
      expected: invariants.date,
      actual: state.date,
    });
  }
  if (invariants?.timeframe !== undefined && state.timeframe !== invariants.timeframe) {
    violations.push({
      stage: 'final-world-state',
      message: `Final timeframe mismatch`,
      expected: invariants.timeframe,
      actual: state.timeframe,
    });
  }

  if (turn.expectedFinalWorldState) {
    const expected = turn.expectedFinalWorldState as Record<string, unknown> | undefined;
    for (const [key, expectedValue] of Object.entries(expected ?? {})) {
      if (expectedValue === undefined) continue;
      if (state[key] !== expectedValue) {
        violations.push({
          stage: 'final-world-state',
          message: `Final WorldState field ${key} mismatch`,
          expected: expectedValue,
          actual: state[key],
        });
      }
    }
  }

  if (turn.expectedContextUnchanged && previousResults.length > 0) {
    const previous = previousResults[previousResults.length - 1].finalWorldState as Record<string, unknown> | undefined;
    const stable = (obj: Record<string, unknown> | undefined) => {
      if (!obj) return obj;
      const { builtAt, ...rest } = obj;
      return rest;
    };
    if (!deepEqual(stable(state), stable(previous) ?? {})) {
      violations.push({
        stage: 'final-world-state',
        message: `WorldState was expected to remain unchanged`,
        expected: previous,
        actual: state,
      });
    }
  }
}

function containsInternalEngineIdentifier(message: string): boolean {
  // Engine-internal policy labels, plan IDs, and raw ISO timestamps with milliseconds.
  return (
    /\bengine_[\w_]+\b/i.test(message) ||
    /\bplan-[a-z0-9-]+\b/i.test(message) ||
    /\b\d{10,}\b/.test(message) ||
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(message)
  );
}

function looksLikeAnswerTime(message: string): string | undefined {
  // Detects a phrase that asserts a specific time as *the* requested time,
  // e.g. "The 11:49 candle", "candle at 11:49".
  const m = message.match(/(?:the |^)(\d{1,2}:\d{2})\s+(?:candle|bar)|(?:candle|bar)\s+(?:at|for)\s+(\d{1,2}:\d{2})/i);
  return m?.[1] ?? m?.[2];
}

function isContradictoryPhrase(phrase: string, message: string): boolean {
  if (/^\d{1,2}:\d{2}$/.test(phrase)) {
    const answerTime = looksLikeAnswerTime(message);
    if (answerTime && answerTime !== phrase) return true;
  }
  return false;
}

function isMessageGrounded(
  turn: Turn,
  result: AgentTurnResult,
  allowedNumbers: import('./numeric-equivalence.ts').AllowedNumber[],
): boolean {
  const message = result.message ?? '';
  if (message.trim().length === 0) return false;

  // Clarification/unsupported turns with no side effects are grounded if they
  // explain, ask a question, or do not claim an action.
  if (result.capabilities.length === 0 && result.receipts.length === 0) {
    const clarificationWords = /\b(what|how|would|can|can't|cannot|support|unsupported|clarify|explain|sorry)\b/i;
    return clarificationWords.test(message) || message.includes('?');
  }

  // Otherwise the message should contain a known anchor: symbol, date, an allowed
  // number, or analysis/receipt vocabulary.
  const symbol = (result.finalWorldState?.symbol ?? turn.exactInvariants?.symbol) as string | undefined;
  const date = (result.finalWorldState?.date ?? turn.exactInvariants?.date) as string | undefined;
  const hasSymbol = symbol ? message.toLowerCase().includes(symbol.toLowerCase()) : false;
  const hasDate = date ? message.includes(date) : false;
  const hasAllowedNumber = allowedNumbers.some((n) =>
    message.includes(String(n.value)) ||
    message.includes(n.value.toFixed(2)) ||
    message.includes(n.value.toFixed(0)),
  );
  const hasAnalysisTerms = /\b(open|high|low|close|volume|candle|bar|range|delta|session|summary)\b/i.test(message);
  const hasTime = /\b\d{1,2}:\d{2}\b/.test(message);

  return hasSymbol || hasDate || hasAllowedNumber || hasAnalysisTerms || hasTime;
}

function isEvasiveOrUnrelated(
  turn: Turn,
  result: AgentTurnResult,
  allowedNumbers: import('./numeric-equivalence.ts').AllowedNumber[],
): boolean {
  const message = result.message ?? '';
  if (message.trim().length === 0) return true;

  // A non-empty message that has no side effects and no clear relation to the
  // subject is evasive unless it is a clarification/unsupported response.
  if (result.capabilities.length === 0 && result.receipts.length === 0) {
    const clarificationWords = /\b(what|how|would|can|can't|cannot|support|unsupported|clarify|explain|sorry)\b/i;
    const hasQuestion = message.includes('?');
    return !(clarificationWords.test(message) || hasQuestion);
  }

  return !isMessageGrounded(turn, result, allowedNumbers);
}

function containsActionClaimWithoutReceipt(result: AgentTurnResult): boolean {
  const message = result.message ?? '';
  if (result.capabilities.length > 0 || result.receipts.length > 0) return false;
  // A message with no receipts/capabilities should not claim an action happened.
  const actionClaims = /\b(?:I\s+(?:set|sought|switched|changed|played|analyzed|compared)|(?:sought|switched|changed|played|analyzed|compared)\s+(?:the|to))\b/i;
  const negatedClaims = /\b(?:did\s+not|didn't|could\s+not|couldn't|failed|unable)\b/i;
  return actionClaims.test(message) && !negatedClaims.test(message);
}

function containsHiddenFailure(result: AgentTurnResult): boolean {
  const message = result.message ?? '';
  const hasFailedReceipt = result.receipts.some((r) => (r as { success?: boolean }).success === false);
  if (!hasFailedReceipt) return false;
  const failureWords = /\b(?:did\s+not|didn't|could\s+not|couldn't|failed|unable|error|not\s+confirm)\b/i;
  return !failureWords.test(message);
}

function checkConsumerResponse(
  turn: Turn,
  result: AgentTurnResult,
  allowedNumbers: import('./numeric-equivalence.ts').AllowedNumber[],
  failures: Violation[],
  warnings: Violation[],
): void {
  const expectations = turn.consumerResponseExpectations ?? scenarioDefaultConsumerResponse();
  const message = result.message ?? '';

  if (message.trim().length === 0) {
    failures.push({
      stage: 'consumer',
      message: 'Consumer response is empty or whitespace',
      actual: message,
    });
    // Empty messages cannot satisfy any further expectations.
    return;
  }

  if (isEvasiveOrUnrelated(turn, result, allowedNumbers)) {
    failures.push({
      stage: 'consumer',
      message: 'Consumer response is evasive or unrelated to the request',
      actual: message,
    });
  }

  for (const phrase of expectations.mustContain ?? []) {
    if (!message.toLowerCase().includes(phrase.toLowerCase())) {
      if (isContradictoryPhrase(phrase, message)) {
        failures.push({
          stage: 'consumer',
          message: `Response contradicts required phrase "${phrase}"`,
          expected: phrase,
          actual: message,
        });
      } else if (isMessageGrounded(turn, result, allowedNumbers)) {
        warnings.push({
          stage: 'consumer',
          message: `Response missing required phrase "${phrase}" but is semantically grounded`,
          expected: phrase,
          actual: message,
        });
      } else {
        failures.push({
          stage: 'consumer',
          message: `Response missing required phrase: "${phrase}"`,
          expected: phrase,
          actual: message,
        });
      }
    }
  }

  for (const phrase of expectations.mustNotContain ?? []) {
    if (message.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push({
        stage: 'consumer',
        message: `Response contains forbidden phrase: "${phrase}"`,
        actual: message,
      });
    }
  }

  for (const pattern of expectations.mustMatch ?? []) {
    if (!new RegExp(pattern, 'i').test(message)) {
      if (isMessageGrounded(turn, result, allowedNumbers)) {
        warnings.push({
          stage: 'consumer',
          message: `Response does not match regex "${pattern}" but is semantically grounded`,
          expected: pattern,
          actual: message,
        });
      } else {
        failures.push({
          stage: 'consumer',
          message: `Response does not match regex: ${pattern}`,
          actual: message,
        });
      }
    }
  }

  for (const topic of expectations.forbiddenTopics ?? []) {
    if (new RegExp(`\\b${topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message)) {
      failures.push({
        stage: 'consumer',
        message: `Response contains forbidden topic: ${topic}`,
        actual: message,
      });
    }
  }

  if (expectations.maxLength && message.length > expectations.maxLength) {
    failures.push({
      stage: 'consumer',
      message: `Response exceeds maxLength ${expectations.maxLength}`,
      expected: expectations.maxLength,
      actual: message.length,
    });
  }

  if (allowedNumbers.length > 0) {
    const numericCheck = checkConsumerNumericEquivalence(
      message,
      allowedNumbers,
      expectations.numericEquivalence ?? defaultNumericEquivalenceConfig(),
    );
    if (!numericCheck.ok) {
      failures.push({
        stage: 'consumer-numeric',
        message: `Unsupported or hallucinated numbers: ${numericCheck.unsupported.join(', ')}`,
        actual: numericCheck.unsupported,
      });
    }
  }

  if (containsInternalEngineIdentifier(message)) {
    warnings.push({
      stage: 'consumer',
      message: 'Response exposes internal engine identifiers or raw timestamps',
      actual: message,
    });
  }

  if (containsActionClaimWithoutReceipt(result)) {
    failures.push({
      stage: 'consumer',
      message: 'Response claims an action occurred but no receipt was produced',
      actual: message,
    });
  }

  if (containsHiddenFailure(result)) {
    failures.push({
      stage: 'consumer',
      message: 'Response hides a failed capability behind confident prose',
      actual: message,
    });
  }
}

function checkExactRouteAndPlan(
  turn: Turn,
  result: AgentTurnResult,
  violations: Violation[],
): void {
  if (turn.assertExactRoute && turn.expectedRoute && result.route !== turn.expectedRoute) {
    violations.push({
      stage: 'exact-route',
      message: `Route mismatch`,
      expected: turn.expectedRoute,
      actual: result.route,
    });
  }
  if (turn.assertExactPlan && turn.expectedPlan) {
    if (!deepEqual(result.plan, turn.expectedPlan)) {
      violations.push({
        stage: 'exact-plan',
        message: `Plan mismatch`,
        expected: turn.expectedPlan,
        actual: result.plan,
      });
    }
  }
}

export function defaultNumericEquivalenceConfig(): NumericEquivalenceConfig {
  return {
    priceAbsolute: 0.005,
    priceRelative: 0.001,
    volumeAbsolute: 1,
    volumeRelative: 0.001,
    percentAbsolute: 0.05,
    percentRelative: 0.001,
    approximateRelative: 0.02,
    approximateWords: ['about', 'around', 'approximately', '~', 'roughly', 'nearly'],
    compactSuffixes: { K: 1e3, M: 1e6, B: 1e9, k: 1e3, m: 1e6, b: 1e9 },
  };
}

function scenarioDefaultConsumerResponse(): import('./scenario-types.ts').ConsumerResponseExpectations {
  return {
    mustContain: [],
    mustNotContain: [],
    mustMatch: [],
    forbiddenTopics: [],
  };
}

function checkCapabilityNames(
  turn: Turn,
  result: AgentTurnResult,
  violations: Violation[],
): void {
  for (const cap of result.capabilities) {
    const errors = validateCapabilityName(cap, `scenario ${turn.id} turn result capabilities`);
    for (const err of errors) {
      violations.push({ stage: 'capability-name', message: err, actual: cap });
    }
  }
  for (const receipt of result.receipts) {
    const cap = (receipt as { capability?: string }).capability;
    if (!cap) continue;
    const errors = validateCapabilityName(cap, `scenario ${turn.id} receipt`);
    for (const err of errors) {
      violations.push({ stage: 'capability-name', message: err, actual: cap });
    }
  }
}

export function evaluateTurn(opts: EvaluateTurnOptions): TurnResult {
  const { scenario, turn, turnResult, previousResults, referenceCandles, durationMs } = opts;
  const coreViolations: Violation[] = [];

  checkStatusAndSafety(turn, turnResult, coreViolations);
  checkCapabilityNames(turn, turnResult, coreViolations);
  checkForbiddenAndPermitted(turn, turnResult, coreViolations);
  checkGroundingInvariants(turn, turnResult, coreViolations);
  checkRequiredCapabilities(turn, turnResult, coreViolations);
  checkContextInheritance(scenario, turn, turnResult, previousResults, coreViolations);
  checkReceipts(turn, turnResult, coreViolations);
  checkNumericalTruth(turn, turnResult, referenceCandles, coreViolations);
  checkFinalWorldState(turn, turnResult, previousResults, coreViolations);
  checkExactRouteAndPlan(turn, turnResult, coreViolations);

  const consumerFailures: Violation[] = [];
  const consumerWarnings: Violation[] = [];
  const allowedNumbers: import('./numeric-equivalence.ts').AllowedNumber[] = [];
  for (const receipt of turnResult.receipts) {
    allowedNumbersFromObject((receipt as { data?: unknown }).data, 'receipt', allowedNumbers);
  }
  checkConsumerResponse(turn, turnResult, allowedNumbers, consumerFailures, consumerWarnings);

  const coreSemanticStatus: import('./artifact-types.ts').CoreSemanticStatus =
    coreViolations.length === 0 ? 'pass' : 'fail';

  const hasConsumerExpectations =
    turn.consumerResponseExpectations !== undefined || consumerFailures.length > 0 || consumerWarnings.length > 0;

  let consumerQualityStatus: import('./artifact-types.ts').ConsumerQualityStatus;
  if (!hasConsumerExpectations) {
    consumerQualityStatus = 'not_evaluated';
  } else if (consumerFailures.length > 0) {
    consumerQualityStatus = 'fail';
  } else if (consumerWarnings.length > 0) {
    consumerQualityStatus = 'warn';
  } else {
    consumerQualityStatus = 'pass';
  }

  // Overall turn status reflects core semantics; consumer quality is reported
  // separately. Consumer warnings do not fail the overall turn.
  let status: import('./artifact-types.ts').TurnStatus;
  if (coreSemanticStatus !== 'pass') {
    status = 'fail';
  } else if (consumerQualityStatus === 'fail') {
    status = 'fail';
  } else {
    status = 'pass';
  }

  const violations = [...coreViolations, ...consumerFailures];

  return {
    turnId: turn.id,
    utterance: turn.utterance,
    status,
    coreSemanticStatus,
    consumerQualityStatus,
    durationMs,
    route: turnResult.route,
    plan: turnResult.plan,
    expectedCapabilities: turn.expectedCapabilities ?? [],
    permittedActions: turn.permittedActions,
    forbiddenActions: turn.forbiddenActions,
    capabilities: turnResult.capabilities,
    receipts: turnResult.receipts,
    finalWorldState: turnResult.finalWorldState,
    message: turnResult.message,
    violations,
    coreViolations,
    consumerViolations: consumerFailures,
    consumerQualityWarnings: consumerWarnings,
  };
}
