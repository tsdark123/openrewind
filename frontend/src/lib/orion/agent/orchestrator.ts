// =============================================================================
// Orchestrator — single shared entry point for Orion terminal input.
//
// Routing policy
//   1. Short interjections/hesitations are handled offline, instantly.
//   2. "What action did you just perform?" is answered from the execution log
//      with no LLM call.
//   3. Conversation-classified inputs go to the chat path.
//   4. Deterministic chart parser is tried next.  A fast path is only taken
//      when the parse is a supported intent and has all required fields.
//   5. Incomplete switch requests are converted into a resolve_symbol plan.
//   6. Anything not handled falls back to compact semantic-intent extraction,
//      with bounded execution context rendered into the prompt.
//
// Phase 5 changes:
//   - Every return path flows through finalizeTurn(), recording the turn in
//     the verified execution context.
//   - ChartActionIntent is the reusable ActionTemplate. Full AgentPlans are not
//     stored in the context.
//   - contextReference lets anaphoric requests ("do that again", "same
//     timeframe", "go back to the candle") be resolved structurally.
// =============================================================================

import type {
  AgentContext,
  AgentPlan,
  AgentExecutionResult,
  CancellationToken,
  ChartActionIntent,
  CandleSnapshot,
  CompactStateSnapshot,
  ExecutionContextEntry,
} from './types';
import { createCancellationSource, type CancellationSource } from './types';
import { parseChartCommand, extractTimes, clampTimeframe, SUPPORTED_TIMEFRAMES, type ChartCommand, type ParsedTime } from '../planner';
import {
  type ActionDimension,
  ALL_ACTION_DIMENSIONS,
  INHERIT_FIELD_TO_DIMENSION,
  getRequestedDimensions,
  looksLikeSwitch,
  textRequestsCandleQuery,
  textRequestsPlaybackControl,
  textRequestsAnalysis,
  textRequestsCandleShape,
  textRequestsContextReference,
  textRequestsUnsupportedIndicator,
} from './dimensions';
import { SYMBOL_ALIASES } from '../symbolAliases';
import { classifyOrionIntent } from '../router';
import { orionChat } from '../client';
import { buildWorldState, renderWorldStateForPrompt, type WorldState } from '../worldState';
import { commonSenseReply } from '../commonSense';
import type { SymbolResolution } from './resolveSymbol';
import { chartCommandToPlan, chartCommandToActionTemplate } from './planner-adapter';
import { executeAgentPlan } from './executor';
import { extractSemanticIntent, validateSemanticIntent } from './intent';
import { compileChartActionIntent, resolveContextReference } from './intentCompiler';
import { validateAgentPlan } from './validatePlan';
import { agentTrace } from './config';
import {
  buildCompactStateSnapshot,
  buildCandleSnapshot,
} from './executionContext';
import type { CandleData } from '../../../types';

export interface OrchestratorOptions {
  /** Whether Ollama/chat model is ready. */
  setupReady: boolean;
  /** Original user text. */
  text: string;
  /** Current agent context (state, send, dispatch, chartRef, etc.). */
  ctx: AgentContext;
  /** Optional caller AbortSignal so the component can cancel this request. */
  signal?: AbortSignal;
}

export interface OrchestratorResult {
  ok: boolean;
  message: string;
  /** True if this was a chat response rather than an action plan. */
  wasChat: boolean;
  /** Plan that was generated, if any. */
  plan?: AgentPlan;
  /** Execution result, if an action plan ran. */
  result?: AgentExecutionResult;
  /** Route chosen for diagnostics. */
  route: 'chat' | 'deterministic' | 'resolve' | 'llm-plan' | 'clarification' | 'unsupported' | 'unrecognized' | 'recent-action-summary' | 'error' | 'aborted';
}

interface RouteOutput {
  ok: boolean;
  message: string;
  wasChat: boolean;
  route: OrchestratorResult['route'];
  plan?: AgentPlan;
  result?: AgentExecutionResult;
  /** The normalized ActionTemplate when the turn produced a replayable action. */
  template?: ChartActionIntent;
}

let planCounter = 0;

function makePlanId(): string {
  return `plan-${++planCounter}-${Date.now().toString(36)}`;
}

let activeCancellation: CancellationSource | null = null;
let activeAbortController: AbortController | null = null;

function cancelPreviousPlan(): void {
  if (activeCancellation && !activeCancellation.cancelled) {
    activeCancellation.cancel('new message received');
  }
  if (activeAbortController) {
    try { activeAbortController.abort(); } catch { /* ignore */ }
    activeAbortController = null;
  }
}

function newCancellation(): CancellationSource {
  cancelPreviousPlan();
  activeCancellation = createCancellationSource();
  activeAbortController = new AbortController();
  return activeCancellation;
}

function currentAbortSignal(): AbortSignal | undefined {
  return activeAbortController?.signal;
}

function now(): number {
  return Date.now();
}

function elapsed(start: number): number {
  return now() - start;
}

// ---------------------------------------------------------------------------
// Conversation heuristics
// ---------------------------------------------------------------------------

const INTERJECTIONS: Record<string, string> = {
  'um?': "Yeah—what's up?",
  'um': "Yeah—what's up?",
  'huh?': 'Sorry, what did you mean?',
  'huh': 'Sorry, what did you mean?',
  'wait': 'Take your time.',
  'ok?': 'Ready when you are.',
  'okay?': 'Ready when you are.',
  'what?': 'What would you like me to do?',
  'yeah?': "Yeah—what's up?",
  'yes?': 'What would you like me to do?',
  'no?': 'No problem. Let me know what you need.',
  'really?': 'Really. What do you need?',
};

function shortInterjectionReply(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/g, '');
  return INTERJECTIONS[t] ?? null;
}

function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bwut\b/g, 'what')
    .replace(/\b[u]\b/g, 'you')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isConversation(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length <= 4) return true;
  if (/^(hi|hello|hey|um|uh|hmm|ok|okay|yes|no|what|why|how|tell me|are you|is it|can you|could you|will you|would you|should i)\b/.test(t)) return true;
  return false;
}

function isRecentActionQuestion(text: string): boolean {
  const t = normalizeQuery(text);
  // Avoid historical questions like "what did you do yesterday"
  if (/\b(yesterday|last week|last month|last year|ago)\b/.test(t)) return false;
  const patterns = [
    /^what action did you just (do|perform)$/,
    /^what did you just do$/,
    /^what was the last thing you did$/,
    /^what did orion just do$/,
    /^what happened just now$/,
    /^what did (the agent|it|orion) do$/,
    /^what just happened$/,
  ];
  return patterns.some((re) => re.test(t));
}

function isCanonicalRepeat(text: string): boolean {
  const t = normalizeQuery(text);
  const patterns = [
    /^do (that|it|this) again$/,
    /^do the last action again$/,
    /^run (that|it) again$/,
    /^repeat (that|it)$/,
    /^again$/,
    /^do it over$/,
  ];
  return patterns.some((re) => re.test(t));
}

async function handleCanonicalRepeat(
  text: string,
  ctx: AgentContext,
  token: CancellationToken
): Promise<RouteOutput | null> {
  const prior = ctx.executionLog.latestSuccessfulAction();
  if (!prior?.template) {
    agentTrace('route', 'canonical-repeat', { text, found: false });
    return {
      ok: true,
      message: 'There is no replayable action yet.',
      wasChat: true,
      route: 'clarification',
    };
  }

  agentTrace('route', 'canonical-repeat', {
    text,
    prior: prior.originalRequest,
    template: prior.template,
  });

  // Resolve the stored template again so context-dependent fields (e.g.
  // compare_candles) are re-bound to the current execution log.
  const resolution = resolveContextReference(prior.template, ctx);
  if (!resolution.ok) {
    return {
      ok: false,
      message: `I couldn't repeat that: ${resolution.error}`,
      wasChat: true,
      route: 'clarification',
    };
  }

  const plan = compileChartActionIntent(resolution.intent, {
    anchorDate:
      resolution.anchorDate ||
      ctx.getState().replayDate ||
      new Date().toISOString().slice(0, 10),
    resolvedCandle: resolution.resolvedCandle,
    resolvedCompare: resolution.resolvedCompare,
    stateSymbol: ctx.getState().symbol,
  });

  const validation = validateAgentPlan(plan);
  if (!validation.ok) {
    agentTrace('route', 'canonical-repeat-invalid', { error: validation.error });
    return {
      ok: false,
      message: `I couldn't repeat that: ${validation.error}`,
      wasChat: false,
      route: 'error',
    };
  }

  plan.id = plan.id || makePlanId();
  const result = await executeAgentPlan(plan, ctx, token);
  agentTrace('route', 'canonical-repeat-executed', { ok: result.ok });

  return {
    ok: result.ok,
    message: composeResponse(result, ctx),
    wasChat: false,
    plan,
    result,
    route: 'deterministic',
    template: resolution.intent,
  };
}

function looksLikeContextReference(text: string, ctx: AgentContext): boolean {
  const hasPriorAction = ctx.executionLog.latestSuccessfulAction() !== null;
  return textRequestsContextReference(text, hasPriorAction);
}

function looksLikePlayOrPause(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(play|pause|stop|resume|go|rewind|fast[- ]?forward|fastforward)\b/.test(t);
}

function looksLikeChartQuery(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(price|candle|cost|worth|value|ohlcv)\b/.test(t) &&
    (/\b\d{1,2}:\d{2}|\b\d{1,2}\s*(am|pm)\b|\bmarket\s+(open|close)\b|\bnoon\b|\bmidnight\b/).test(t);
}

function buildWorldStateForChat(ctx: AgentContext): string {
  const ws = buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog);
  return renderWorldStateForPrompt(ws);
}

function buildRecentActionSummary(log: AgentContext['executionLog'], text: string): string {
  const latest = log.latest();
  if (!latest) return "We haven't done anything in this session yet.";

  const successful = log.latestSuccessfulAction();
  const failed = log.latestFailedAction();
  const action = successful; // answer the most recent successful action by default

  if (isRecentActionQuestion(text)) {
    if (latest.route === 'ui-action' && latest.actionKind === 'chart_reset') {
      const prior = log.latestSuccessfulAction();
      if (prior) {
        return `You just reset the chart. The latest Orion action before that was "${prior.originalRequest}" (${prior.planSummary ?? prior.route}).`;
      }
      if (failed) {
        return `You just reset the chart. The previous action "${failed.originalRequest}" had failed: ${failed.errorMessage ?? 'unknown error'}.`;
      }
      return 'You just reset the chart.';
    }

    if (latest.template) {
      if (latest.ok === true) {
        const detail = latest.planSummary ?? latest.route;
        const receipts = latest.receipts.filter((r) => r.success).map((r) => r.message).join(' ');
        return `I just ran "${latest.originalRequest}" (${detail}). It succeeded. ${receipts}`;
      }
      if (latest.ok === false) {
        const fail = latest.receipts.find((r) => !r.success);
        return `I attempted "${latest.originalRequest}" (${latest.planSummary ?? latest.route}) but it failed: ${fail?.message ?? latest.errorMessage ?? 'unknown error'}.`;
      }
    }
    // latest turn was chat/clarification; report the most recent successful action instead
    if (action) {
      return `We were just chatting. The last action before that was "${action.originalRequest}" (${action.planSummary ?? action.route}) and it succeeded.`;
    }
    if (failed) {
      return `We were just chatting. The last action before that was "${failed.originalRequest}" and it failed: ${failed.errorMessage ?? 'unknown error'}.`;
    }
    return "We haven't executed an action yet; we've just been talking.";
  }

  // Generic "what did you just do" style — should not normally reach here because
  // the specific question is handled, but keep a safe fallback.
  if (action) {
    return `The most recent successful action was "${action.originalRequest}" (${action.planSummary ?? action.route}).`;
  }
  return "I haven't completed a successful action yet in this session.";
}

// ---------------------------------------------------------------------------
// Chat path
// ---------------------------------------------------------------------------

async function runChat(text: string, ctx: AgentContext, setupReady: boolean, start: number): Promise<string> {
  const interjection = shortInterjectionReply(text);
  if (interjection) {
    agentTrace('chat interjection', text, { elapsed: elapsed(start), reply: interjection });
    return interjection;
  }

  const common = commonSenseReply(text, setupReady);
  if (common) {
    agentTrace('common sense reply', text, { elapsed: elapsed(start), reply: common });
    return common;
  }

  if (!setupReady) {
    return "I'm here. What would you like to do?";
  }

  const llmStart = now();
  agentTrace('llm chat start', text);
  try {
    const world = buildWorldStateForChat(ctx);
    const recentContext = ctx.executionLog.renderForPrompt({ maxActions: 3, includeCandles: true });
    const systemPrompt = [
      'You are Orion, an observant, offline AI trading coach embedded in OpenRewind.',
      `The WORLD STATE below is a live snapshot of the current session, not a completed/ended session. Do not claim the session has ended unless sessionActive is explicitly false.`,
      'Only state facts that are present in the WORLD STATE or RECENT ACTIONS. Do not invent trades, profits, losses, or state changes.',
      'Be concise: 2-4 short sentences unless asked for detail. Use plain English only.',
      'Do not provide regulated investment advice.',
      '',
      'RECENT ACTIONS',
      '--------------',
      recentContext,
      '',
      'WORLD STATE',
      '-----------',
      world,
    ].join('\n');
    const res = await orionChat({
      tier: 'chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      signal: currentAbortSignal(),
    });
    const total = now() - llmStart;
    agentTrace('llm chat end', { text, total, firstToken: total });
    return res.content.trim() || 'No response.';
  } catch (e) {
    const total = now() - llmStart;
    const err = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code;
    console.warn('[orchestrator] chat failed:', err);
    agentTrace('llm chat failed', { text, total, error: err, code });
    if (code === 'ABORTED') {
      throw Object.assign(new Error('superseded'), { code: 'ABORTED' });
    }
    if (code === 'TIMEOUT') {
      return 'The local model did not respond in time. Please try again.';
    }
    return `I'm here, but my chat model is not responding right now (${err}). What would you like to do?`;
  }
}

// ---------------------------------------------------------------------------
// Resolve path
// ---------------------------------------------------------------------------

const SWITCH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'and', 'or', 'for', 'of', 'in', 'on', 'at', 'from', 'with',
  'switch', 'go', 'load', 'open', 'show', 'pull', 'up', 'change', 'pick', 'select',
  'me', 'please', 'stock', 'stocks', 'ticker', 'symbol', 'company', 'shares',
]);

function extractSymbolCandidate(text: string): string {
  const tokens = text.split(/[^a-zA-Z0-9-]+/).filter(Boolean);
  const first = tokens.find((t) => !SWITCH_STOP_WORDS.has(t.toLowerCase()));
  return first ?? text.trim();
}

function makeResolvePlan(query: string): AgentPlan {
  return {
    id: makePlanId(),
    kind: 'action',
    summary: 'Resolve requested symbol',
    steps: [
      {
        id: 'resolve-1',
        capability: 'session.resolve_symbol',
        args: { name: query },
        required: true,
      },
    ],
  };
}

function makeSwitchPlan(symbol: string): AgentPlan {
  return {
    id: makePlanId(),
    kind: 'action',
    summary: `Switch to ${symbol} (resolved)`,
    steps: [
      {
        id: 'switch-1',
        capability: 'session.switch_symbol',
        args: { symbol },
        required: true,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Deterministic planning completeness
// ---------------------------------------------------------------------------

function planCoversDimensions(plan: AgentPlan): Set<ActionDimension> {
  const covered = new Set<ActionDimension>();
  for (const step of plan.steps) {
    const cap = step.capability;
    if (cap === 'session.resolve_symbol' || cap === 'session.switch_symbol') covered.add('symbol');
    if (cap === 'session.resolve_trading_date' || cap === 'session.resolve_calendar_date') covered.add('date');
    if (cap === 'session.switch_symbol' && (step.args?.date || step.args?.$ref)) covered.add('date');
    if (cap === 'chart.set_timeframe') covered.add('timeframe');
    if (cap === 'playback.seek_to_time') {
      covered.add('absoluteTime');
      covered.add('playbackControl');
    }
    if (cap === 'playback.play_until') {
      covered.add('playbackControl');
      if (step.args?.untilTime) covered.add('absoluteTime');
    }
    if (cap === 'playback.seek_relative') {
      covered.add('relativeSeek');
      covered.add('playbackControl');
    }
    if (cap === 'playback.play' || cap === 'playback.pause') covered.add('playbackControl');
    if (cap === 'chart.get_current_candle' || cap === 'chart.get_candle_at_time' || cap === 'analysis.compare_candles') {
      covered.add('candleQuery');
      if (cap === 'chart.get_candle_at_time' && step.args?.time) covered.add('absoluteTime');
    }
    if (/^analysis\./.test(cap) && cap !== 'analysis.compare_candles') {
      covered.add('analysisRequest');
    }
    if (cap === 'session.switch_to_previous_symbol') {
      covered.add('previousSymbol');
      covered.add('symbol');
    }
  }
  return covered;
}

function stateCoversDimension(
  dim: ActionDimension,
  cmd: ChartCommand,
  state: ReturnType<AgentContext['getState']>
): boolean {
  if (dim === 'symbol') return !!cmd.symbol && state.symbol === cmd.symbol;
  if (dim === 'date') return !!cmd.date && state.replayDate === cmd.date;
  if (dim === 'timeframe') return cmd.timeframe !== undefined && state.timeframe === cmd.timeframe;
  return false;
}

function formatParsedTime(t: ParsedTime): string {
  return `${t.hour.toString().padStart(2, '0')}:${t.minute.toString().padStart(2, '0')}`;
}



function isCurrentCandleRequest(text: string): boolean {
  return /\b(?:current|now|latest)\s+(?:candle|price|bar)\b/i.test(text);
}

interface IntentSanitizationResult {
  ok: boolean;
  intent?: ChartActionIntent;
  reason?: string;
  trace: {
    kept: string[];
    stripped: string[];
    defaults: string[];
  };
}

function formatDateForTrace(d: ChartActionIntent['date']): string {
  if (!d) return '';
  if (d.kind === 'absolute') return d.value ?? '';
  return `${d.kind}:${d.count ?? 1}:${d.direction ?? 'backward'}`;
}

/**
 * Overlay deterministic, parser-grounded fields onto a model/context intent.
 * Deterministic values win over the LLM and over inherited context values.
 * The result is re-validated so malformed deterministic values (e.g. an
 * unsupported timeframe) are rejected before planning.
 */
function overlayGroundedIntent(model: ChartActionIntent, grounded: ChartActionIntent): ChartActionIntent {
  const merged: ChartActionIntent = { ...model };
  for (const key of Object.keys(grounded) as (keyof ChartActionIntent)[]) {
    if (key === 'kind') continue;
    const value = grounded[key];
    if (value !== undefined) {
      (merged as any)[key] = value;
    }
  }
  // If the deterministic template supplies a finalQuery but no queryTime, do
  // not keep a stale model queryTime (the two are a matched pair).
  if (grounded.finalQuery !== undefined && grounded.queryTime === undefined) {
    delete (merged as any).queryTime;
  }
  return merged;
}

/**
 * Field-level semantic-safety sanitizer. After the compact model emits a
 * ChartActionIntent (and after context references have been resolved), each
 * actionable field is checked independently:
 *   1. Keep it if the current request explicitly grounds it.
 *   2. Keep it if a valid contextReference authorizes it.
 *   3. Strip it as a safe state default if it only repeats the current state.
 *   4. Strip it if it is an unsupported optional field.
 * If no meaningful grounded action remains, the entire intent is rejected.
 */
export function sanitizeIntentGrounding(
  resolved: ChartActionIntent,
  text: string,
  originalContextReference: ChartActionIntent['contextReference'],
  ctx: AgentContext
): IntentSanitizationResult {
  const cmd = parseChartCommand(text, ctx.availableTickers, SYMBOL_ALIASES, ctx.getState().replayDate);
  const baseDate = ctx.getState().replayDate;
  const requested = getRequestedDimensions(text, cmd, baseDate);
  const anaphoric = originalContextReference !== undefined;
  const state = ctx.getState();

  const allowed = new Set<ActionDimension>(requested);
  if (anaphoric && originalContextReference) {
    const { mode, inherit } = originalContextReference;
    if (mode === 'repeat') {
      for (const d of ALL_ACTION_DIMENSIONS) allowed.add(d);
    } else if (mode === 'inherit' && inherit) {
      for (const f of inherit) {
        const dim = INHERIT_FIELD_TO_DIMENSION[f];
        if (dim) allowed.add(dim);
      }
    } else if (mode === 'use_as_target') {
      allowed.add('absoluteTime');
      allowed.add('symbol');
      allowed.add('date');
      allowed.add('timeframe');
      allowed.add('candleQuery');
    } else if (mode === 'anchor_relative_date') {
      allowed.add('date');
    }
  }

  if (resolved.finalQuery === 'compare_candles' && (anaphoric || textRequestsCandleQuery(text))) {
    allowed.add('candleQuery');
  }

  const extractedTimes = extractTimes(text).map(formatParsedTime);
  const trace: IntentSanitizationResult['trace'] = { kept: [], stripped: [], defaults: [] };

  // Work on a deep copy; contextReference is consumed by resolveContextReference.
  let sanitized = JSON.parse(JSON.stringify(resolved)) as ChartActionIntent;
  delete (sanitized as unknown as Record<string, unknown>).contextReference;

  // Deterministic grounded fields are authoritative over model/context values.
  const groundedTemplate = chartCommandToActionTemplate(cmd);
  if (groundedTemplate) {
    sanitized = overlayGroundedIntent(sanitized, groundedTemplate);
    const validation = validateSemanticIntent(sanitized);
    if (!validation.ok) {
      return { ok: false, reason: validation.error, trace: { kept: [], stripped: [], defaults: [] } };
    }
    if (validation.intent.kind !== 'chart_action') {
      return { ok: false, reason: 'Expected a chart action intent.', trace: { kept: [], stripped: [], defaults: [] } };
    }
    sanitized = validation.intent;
  }

  // Symbol
  if (sanitized.symbol !== undefined) {
    if (allowed.has('symbol')) {
      trace.kept.push(`symbol:${sanitized.symbol}`);
    } else if (sanitized.symbol === state.symbol && state.symbol) {
      delete sanitized.symbol;
      trace.defaults.push(`symbol:${state.symbol}`);
    } else {
      const v = sanitized.symbol;
      delete sanitized.symbol;
      trace.stripped.push(`symbol:${v}`);
    }
  }

  // Previous symbol
  if (sanitized.previousSymbol) {
    if (allowed.has('previousSymbol')) {
      trace.kept.push('previousSymbol');
    } else {
      delete sanitized.previousSymbol;
      trace.stripped.push('previousSymbol');
    }
  }

  // Date
  if (sanitized.date) {
    const dateTrace = formatDateForTrace(sanitized.date);
    if (allowed.has('date')) {
      trace.kept.push(`date:${dateTrace}`);
    } else if (sanitized.date.kind === 'absolute' && sanitized.date.value === state.replayDate) {
      delete sanitized.date;
      trace.defaults.push(`date:${state.replayDate}`);
    } else {
      delete sanitized.date;
      trace.stripped.push(`date:${dateTrace}`);
    }
  }

  // Timeframe
  if (sanitized.timeframeMinutes !== undefined) {
    const tf = sanitized.timeframeMinutes;
    if (allowed.has('timeframe')) {
      trace.kept.push(`timeframe:${tf}m`);
    } else if (tf === state.timeframe) {
      delete sanitized.timeframeMinutes;
      trace.defaults.push(`timeframe:${tf}m`);
    } else {
      delete sanitized.timeframeMinutes;
      trace.stripped.push(`timeframe:${tf}m`);
    }
  }

  // Absolute time
  if (sanitized.seekTime !== undefined) {
    const t = sanitized.seekTime;
    if (allowed.has('absoluteTime')) {
      trace.kept.push(`seekTime:${t}`);
    } else {
      delete sanitized.seekTime;
      trace.stripped.push(`seekTime:${t}`);
    }
  }

  // Query time (used by candle_at_time)
  if (sanitized.queryTime !== undefined) {
    const t = sanitized.queryTime;
    const timeGrounded = extractedTimes.includes(t) ||
      (anaphoric && originalContextReference && (originalContextReference.mode === 'repeat' || originalContextReference.mode === 'use_as_target'));
    if (timeGrounded && allowed.has('absoluteTime')) {
      trace.kept.push(`queryTime:${t}`);
    } else {
      delete sanitized.queryTime;
      trace.stripped.push(`queryTime:${t}`);
    }
  }

  // Relative seek
  if (sanitized.relativeSeekMinutes !== undefined) {
    const m = sanitized.relativeSeekMinutes;
    if (allowed.has('relativeSeek')) {
      trace.kept.push(`relativeSeek:${m}m`);
    } else {
      delete sanitized.relativeSeekMinutes;
      trace.stripped.push(`relativeSeek:${m}m`);
    }
  }

  // Playback
  if (sanitized.playback) {
    const pb = sanitized.playback;
    if (allowed.has('playbackControl')) {
      trace.kept.push(`playback:${pb.action}`);
      if (pb.untilTime !== undefined) {
        const t = pb.untilTime;
        if (extractedTimes.includes(t) || allowed.has('absoluteTime')) {
          trace.kept.push(`playback.untilTime:${t}`);
        } else {
          delete pb.untilTime;
          trace.stripped.push(`playback.untilTime:${t}`);
        }
      }
      if (pb.speed !== undefined) {
        const s = pb.speed;
        if (cmd.speed === s || s === 1 || originalContextReference?.mode === 'repeat') {
          trace.kept.push(`playback.speed:${s}`);
        } else {
          delete pb.speed;
          trace.stripped.push(`playback.speed:${s}`);
        }
      }
      if (pb.direction !== undefined) {
        const d = pb.direction;
        if (cmd.direction === d || originalContextReference?.mode === 'repeat' || textRequestsPlaybackControl(text)) {
          trace.kept.push(`playback.direction:${d}`);
        } else {
          delete pb.direction;
          trace.stripped.push(`playback.direction:${d}`);
        }
      }
    } else {
      delete sanitized.playback;
      trace.stripped.push('playback');
    }
  }

  // Compare
  if (sanitized.compare) {
    if (sanitized.finalQuery === 'compare_candles' && (anaphoric || textRequestsCandleQuery(text) || allowed.has('candleQuery'))) {
      trace.kept.push('compare');
    } else {
      delete sanitized.compare;
      trace.stripped.push('compare');
    }
  }

  // Analysis requests
  if (sanitized.analysisRequests && sanitized.analysisRequests.length > 0) {
    if (allowed.has('analysisRequest') || anaphoric) {
      trace.kept.push(`analysisRequests:${sanitized.analysisRequests.length}`);
    } else {
      const count = sanitized.analysisRequests.length;
      delete sanitized.analysisRequests;
      trace.stripped.push(`analysisRequests:${count}`);
    }
  }

  // Fallback: a model that emits a candle query for a clearly candle-shape
  // request should be corrected to analysisRequests before we discard it.
  if (
    sanitized.finalQuery &&
    !sanitized.finalQuery.startsWith('compare') &&
    !sanitized.analysisRequests?.length &&
    textRequestsCandleShape(text)
  ) {
    const marketTime = sanitized.queryTime;
    sanitized.analysisRequests = [
      marketTime
        ? { kind: 'candle_shape', source: 'market_time', marketTime }
        : { kind: 'candle_shape', source: 'current_chart_candle' },
    ];
    trace.stripped = trace.stripped.filter((s) => !s.startsWith('finalQuery:'));
    trace.kept.push('analysisRequests:1 (candle_shape fallback)');
    delete sanitized.finalQuery;
    delete sanitized.queryTime;
  }

  // Final query
  if (sanitized.finalQuery) {
    const fq = sanitized.finalQuery;
    if (fq === 'compare_candles') {
      if (sanitized.compare && (anaphoric || textRequestsCandleQuery(text) || allowed.has('candleQuery'))) {
        trace.kept.push(`finalQuery:${fq}`);
      } else {
        delete sanitized.finalQuery;
        trace.stripped.push(`finalQuery:${fq}`);
      }
    } else if (fq === 'candle_at_time') {
      if ((allowed.has('candleQuery') || textRequestsCandleQuery(text)) && allowed.has('absoluteTime') && (sanitized.queryTime !== undefined || sanitized.seekTime !== undefined)) {
        trace.kept.push(`finalQuery:${fq}`);
      } else {
        delete sanitized.finalQuery;
        trace.stripped.push(`finalQuery:${fq}`);
      }
    } else if (fq === 'current_candle') {
      if (allowed.has('candleQuery') || textRequestsCandleQuery(text) || isCurrentCandleRequest(text)) {
        trace.kept.push(`finalQuery:${fq}`);
      } else {
        delete sanitized.finalQuery;
        trace.stripped.push(`finalQuery:${fq}`);
      }
    } else {
      delete sanitized.finalQuery;
      trace.stripped.push(`finalQuery:${fq}`);
    }
  }

  // A sanitized intent must still be meaningful. A date without a symbol is
  // only actionable when an active session symbol exists.
  const hasAction =
    sanitized.symbol !== undefined ||
    sanitized.previousSymbol ||
    sanitized.timeframeMinutes !== undefined ||
    sanitized.seekTime !== undefined ||
    sanitized.queryTime !== undefined ||
    sanitized.relativeSeekMinutes !== undefined ||
    sanitized.playback !== undefined ||
    sanitized.finalQuery !== undefined ||
    (sanitized.analysisRequests && sanitized.analysisRequests.length > 0) ||
    (sanitized.date && (sanitized.symbol !== undefined || state.symbol));

  if (!hasAction) {
    const reason = trace.stripped.length > 0
      ? `Nothing left after stripping: ${trace.stripped.join(', ')}`
      : 'No actionable fields were grounded';
    agentTrace('grounding', {
      ok: false,
      kept: trace.kept,
      stripped: trace.stripped,
      defaults: trace.defaults,
      reason,
    });
    return { ok: false, reason, trace };
  }

  agentTrace('grounding', {
    ok: true,
    kept: trace.kept,
    stripped: trace.stripped,
    defaults: trace.defaults,
    finalIntent: sanitized,
  });

  return { ok: true, intent: sanitized, trace };
}

function isDeterministicPlanComplete(plan: AgentPlan, text: string, cmd: ChartCommand, ctx: AgentContext): boolean {
  const requested = getRequestedDimensions(text, cmd, ctx.getState().replayDate);
  const covered = planCoversDimensions(plan);
  const state = ctx.getState();
  agentTrace('deterministic completeness', { requested: Array.from(requested), covered: Array.from(covered) });
  for (const dim of requested) {
    if (!covered.has(dim) && !stateCoversDimension(dim, cmd, state)) {
      agentTrace('deterministic incomplete', { dim, text });
      return false;
    }
  }
  return true;
}

function supportedIntent(intent: string): boolean {
  return ['switch', 'play', 'pause', 'set_timeframe', 'seek', 'fast_forward', 'rewind', 'candle_query'].includes(intent);
}

function isFastPathReady(cmd: ChartCommand): boolean {
  if (!supportedIntent(cmd.intent)) return false;
  if (cmd.intent === 'switch' && !cmd.symbol) return false;
  if (cmd.intent === 'set_timeframe' && cmd.timeframe === undefined) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Execution context recording
// ---------------------------------------------------------------------------

function finalizeTurn(
  ctx: AgentContext,
  input: {
    text: string;
    route: OrchestratorResult['route'];
    template?: ChartActionIntent;
    planSummary?: string;
    plan?: AgentPlan;
    result?: AgentExecutionResult;
    before: CompactStateSnapshot;
    after: CompactStateSnapshot;
    returnedCandles: CandleSnapshot[];
  }
): void {
  const result = input.result;
  const entry: ExecutionContextEntry = {
    sequenceId: 0,
    timestamp: Date.now(),
    originalRequest: input.text,
    route: input.route,
    template: input.template,
    planSummary: input.planSummary,
    planId: input.plan?.id ?? result?.planId,
    ok: result?.ok,
    receipts: result?.receipts ?? [],
    stoppedAtStepId: result?.stoppedAtStepId,
    errorCode: result?.errorCode,
    errorMessage: result?.errorMessage,
    before: input.before,
    after: input.after,
    returnedCandles: input.returnedCandles,
  };
  ctx.executionLog.record(entry);
}

function extractReturnedCandles(
  result: AgentExecutionResult | undefined,
  snapshotId: number,
  coords: CompactStateSnapshot
): CandleSnapshot[] {
  if (!result || !coords.symbol || !coords.date || coords.timeframe === undefined) return [];
  const candles: CandleSnapshot[] = [];
  for (const r of result.receipts) {
    if (!r.success) continue;
    if (r.capability === 'analysis.compare_candles') {
      // A comparison is not a new returned candle; it only references earlier ones.
      continue;
    }
    if (r.capability !== 'chart.get_current_candle' && r.capability !== 'chart.get_candle_at_time') continue;
    const data = r.data as { candle?: CandleData } & Partial<CandleData> | undefined;
    const candle: CandleData | undefined =
      data?.candle ??
      (data && typeof data.timestamp === 'number' && typeof data.close === 'number'
        ? (data as CandleData)
        : undefined);
    if (!candle) continue;
    candles.push(
      buildCandleSnapshot(
        snapshotId,
        { symbol: coords.symbol, date: coords.date, timeframe: coords.timeframe },
        candle,
        r.capability === 'chart.get_current_candle' ? 'current_candle' : 'candle_at_time'
      )
    );
  }
  return candles;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function routeMessage(
  text: string,
  ctx: AgentContext,
  setupReady: boolean,
  token: CancellationToken
): Promise<RouteOutput> {
  // 1. Instant interjections.
  const interjection = shortInterjectionReply(text);
  if (interjection) {
    agentTrace('route', 'interjection', { text });
    return { ok: true, message: interjection, wasChat: true, route: 'chat' };
  }

  // 2. "What action did you just perform?" — deterministic and grounded.
  if (isRecentActionQuestion(text)) {
    agentTrace('route', 'recent-action-summary');
    const message = buildRecentActionSummary(ctx.executionLog, text);
    return { ok: true, message, wasChat: true, route: 'recent-action-summary' };
  }

  // 2b. Canonical bare repeat requests — replay the latest successful action
  // without waiting for the model.
  if (isCanonicalRepeat(text)) {
    const repeat = await handleCanonicalRepeat(text, ctx, token);
    if (repeat) return repeat;
  }

  // 3b. Anaphoric / context-reference requests should not be answered by the
  // deterministic chart parser because it has no access to execution context.
  const anaphoric = looksLikeContextReference(text, ctx);

  // 3. Conversation heuristics / classifier.
  let routeChat = isConversation(text);
  let classification = classifyOrionIntent(text);
  if (textRequestsAnalysis(text)) {
    routeChat = false;
    classification = { intent: 'agent', confidence: 1, reasons: ['analysis request'] };
  }

  if (textRequestsUnsupportedIndicator(text)) {
    agentTrace('route', 'unsupported', { text });
    return {
      ok: false,
      message: 'I can only answer window OHLC, volume, change, compare, and candle-shape questions right now.',
      wasChat: false,
      route: 'unsupported',
    };
  }

  // Candle comparison is a read-only query, but it is not chat.
  if (/\bcompare\b.*\bcandle\b/i.test(text)) {
    classification = { intent: 'agent', confidence: 1, reasons: ['candle comparison override'] };
  }
  if (anaphoric) {
    routeChat = false;
    classification = { intent: 'agent', confidence: 1, reasons: ['context reference'] };
  }

  if (
    routeChat &&
    classification.intent === 'chat' &&
    !looksLikePlayOrPause(text) &&
    !looksLikeSwitch(text) &&
    !looksLikeChartQuery(text) &&
    !textRequestsAnalysis(text)
  ) {
    agentTrace('route', 'chat', { text });
    const message = await runChat(text, ctx, setupReady, now());
    return { ok: true, message, wasChat: true, route: 'chat' };
  }

  // 4. Deterministic chart parser.
  const baseDate = ctx.getState().replayDate;
  const cmd = parseChartCommand(text, ctx.availableTickers, SYMBOL_ALIASES, baseDate);
  agentTrace('parsed chart command', cmd);

  // Reject explicit timeframe requests with malformed or unsupported values
  // before any plan runs.  This keeps zero-minute, 7m, etc. from partially
  // executing or reaching the model with a value the engine cannot satisfy.
  if (cmd.timeframe !== undefined && getRequestedDimensions(text, cmd, baseDate).has('timeframe')) {
    const clamped = clampTimeframe(cmd.timeframe);
    if (clamped === undefined) {
      const msg = cmd.timeframe < 1
        ? 'timeframeMinutes must be a positive integer.'
        : `Unsupported timeframe. Supported values are: ${SUPPORTED_TIMEFRAMES.join(', ')}.`;
      agentTrace('route', 'error', { error: msg });
      return { ok: false, message: msg, wasChat: false, route: 'error' };
    }
  }

  if (!anaphoric && isFastPathReady(cmd)) {
    const plan = chartCommandToPlan(cmd);
    if (plan && isDeterministicPlanComplete(plan, text, cmd, ctx)) {
      plan.id = plan.id || makePlanId();
      const template = chartCommandToActionTemplate(cmd);
      const result = await executeAgentPlan(plan, ctx, token);
      agentTrace('route', 'deterministic', { ok: result.ok });
      return {
        ok: result.ok,
        message: composeResponse(result, ctx),
        wasChat: false,
        plan,
        result,
        route: 'deterministic',
        template,
      };
    }
    if (plan) {
      agentTrace('route', 'deterministic-incomplete', { text });
    }
  }

  // 5. Incomplete or unresolved switch: let resolve_symbol handle it.
  if (!anaphoric && !textRequestsAnalysis(text) && ((cmd.intent === 'switch' && !cmd.symbol) || (cmd.intent === 'unknown' && looksLikeSwitch(text)))) {
    const query = extractSymbolCandidate(text);
    const resolvePlan = makeResolvePlan(query);
    const resolveResult = await executeAgentPlan(resolvePlan, ctx, token);

    const failingReceipt = resolveResult.receipts.find((rc) => !rc.success);
    if (failingReceipt) {
      // We tried to resolve the user's symbol request. Record the failed action meaning.
      const template: ChartActionIntent | undefined = query ? { kind: 'chart_action', symbol: query } : undefined;
      return {
        ok: false,
        message: failingReceipt.message,
        wasChat: false,
        plan: resolvePlan,
        result: resolveResult,
        route: 'resolve',
        template,
      };
    }

    const resolveData = resolveResult.receipts[0]?.data as SymbolResolution | undefined;
    if (!resolveData || !resolveData.ok || !resolveData.symbol) {
      return {
        ok: false,
        message: 'Resolved a symbol, but the result was missing.',
        wasChat: false,
        plan: resolvePlan,
        result: resolveResult,
        route: 'resolve',
      };
    }

    const symbol = resolveData.symbol;
    const switchPlan = makeSwitchPlan(symbol);
    const switchResult = await executeAgentPlan(switchPlan, ctx, token);

    const combinedResult: AgentExecutionResult = {
      ok: resolveResult.ok && switchResult.ok,
      planId: switchPlan.id,
      receipts: [...resolveResult.receipts, ...switchResult.receipts],
      finalWorldState: switchResult.finalWorldState ?? resolveResult.finalWorldState,
      stoppedAtStepId: switchResult.stoppedAtStepId ?? resolveResult.stoppedAtStepId,
      errorCode: !switchResult.ok ? switchResult.errorCode : resolveResult.errorCode,
      errorMessage: !switchResult.ok ? switchResult.errorMessage : resolveResult.errorMessage,
    };

    if (token.cancelled) {
      return {
        ok: false,
        message: 'Orion cancelled the request because a new one started.',
        wasChat: false,
        plan: switchPlan,
        result: combinedResult,
        route: 'error',
      };
    }

    const template: ChartActionIntent = { kind: 'chart_action', symbol };
    return {
      ok: combinedResult.ok,
      message: composeResponse(combinedResult, ctx),
      wasChat: false,
      plan: switchPlan,
      result: combinedResult,
      route: 'resolve',
      template,
    };
  }

  // 6. Compact semantic-intent extraction for unfamiliar or compound actionable language.
  if (setupReady && (classification.intent === 'agent' || !routeChat)) {
    const baseDate = ctx.getState().replayDate;
    const requested = getRequestedDimensions(text, cmd, baseDate);
    const parserCovered = new Set<ActionDimension>();
    if (cmd.symbol) parserCovered.add('symbol');
    if (cmd.date || cmd.dateInput) parserCovered.add('date');
    if (cmd.timeframe !== undefined) parserCovered.add('timeframe');
    if (cmd.startTime || cmd.endTime) parserCovered.add('absoluteTime');
    if (cmd.relativeMinutes !== undefined) parserCovered.add('relativeSeek');
    if (cmd.speed !== undefined) parserCovered.add('playbackControl');
    if (cmd.intent === 'candle_query') parserCovered.add('candleQuery');
    const missing = Array.from(requested).filter((d) => !parserCovered.has(d));
    agentTrace('route', 'llm-intent-start', { text });
    const extraction = await extractSemanticIntent(text, {
      executionLog: ctx.executionLog,
      requestContext: {
        dimensions: Array.from(requested),
        missing,
        baseDate,
      },
      signal: currentAbortSignal(),
    });
    agentTrace('llm intent end', { ok: extraction.ok ? 'intent' : extraction.kind });

    if (extraction.ok) {
      const resolution = resolveContextReference(extraction.intent, ctx);
      if (!resolution.ok) {
        agentTrace('route', 'clarification', { reason: resolution.error });
        return {
          ok: true,
          message: resolution.error,
          wasChat: true,
          route: 'clarification',
        };
      }

      const sanitization = sanitizeIntentGrounding(resolution.intent, text, extraction.intent.contextReference, ctx);
      if (!sanitization.ok) {
        agentTrace('grounding', 'rejected ungrounded chart action', { reason: sanitization.reason });
        return {
          ok: true,
          message: "I'm not sure what you want me to do. Could you specify the symbol, date, timeframe, or time?",
          wasChat: true,
          route: 'clarification',
        };
      }

      const sanitizedIntent = sanitization.intent!;
      const plan = compileChartActionIntent(sanitizedIntent, {
        anchorDate:
          resolution.anchorDate ||
          ctx.getState().replayDate ||
          new Date().toISOString().slice(0, 10),
        resolvedCandle: resolution.resolvedCandle,
        resolvedCompare: resolution.resolvedCompare,
        stateSymbol: ctx.getState().symbol,
      });
      const validation = validateAgentPlan(plan);
      if (!validation.ok) {
        agentTrace('route', 'error', { error: validation.error });
        return {
          ok: false,
          message: `I could not build a valid plan: ${validation.error}`,
          wasChat: false,
          route: 'error',
        };
      }
      plan.id = plan.id || makePlanId();
      const result = await executeAgentPlan(plan, ctx, token);
      agentTrace('route', 'llm-plan', { ok: result.ok });
      return {
        ok: result.ok,
        message: composeResponse(result, ctx),
        wasChat: false,
        plan,
        result,
        route: 'llm-plan',
        template: sanitizedIntent,
      };
    }

    const { kind, message } = extraction;
    if (kind === 'aborted') {
      agentTrace('route', 'aborted');
      return { ok: false, message: '', wasChat: false, route: 'aborted' };
    }

    if (kind === 'clarification') {
      agentTrace('route', 'clarification');
      return { ok: true, message, wasChat: true, route: 'clarification' };
    }

    if (kind === 'unsupported') {
      agentTrace('route', 'unsupported');
      return { ok: false, message, wasChat: false, route: 'unsupported' };
    }

    if (kind === 'invalid') {
      agentTrace('route', 'error', { error: message });
      return { ok: false, message, wasChat: false, route: 'error' };
    }

    // offline / model unreachable
    agentTrace('route', 'error', { error: message });
    return { ok: false, message, wasChat: false, route: 'error' };
  }

  // 7. Final chat fallback.
  agentTrace('route', 'fallback-chat', { text });
  const message = await runChat(text, ctx, setupReady, now());
  return { ok: true, message, wasChat: true, route: 'chat' };
}

export async function handleOrionMessage(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  const { text, ctx, setupReady, signal } = opts;

  cancelPreviousPlan();
  const token = newCancellation();
  const thisController = activeAbortController;

  // Wire the optional caller signal into this request's cancellation so a
  // component unmount or a newer prompt can abort the in-flight model call.
  if (signal) {
    signal.addEventListener('abort', () => {
      token.cancel('aborted-by-caller');
      thisController?.abort();
    }, { once: true });
  }

  agentTrace('handleOrionMessage start', text, { tickers: ctx.availableTickers.length });

  const before = buildCompactStateSnapshot(ctx.getState(), ctx.chartRef);

  let routeOutput: RouteOutput;
  try {
    routeOutput = await routeMessage(text, ctx, setupReady, token);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code;
    if (code === 'ABORTED') {
      agentTrace('route', 'aborted');
      routeOutput = { ok: false, message: '', wasChat: false, route: 'aborted' };
    } else {
      console.error('[orchestrator] route failed:', e);
      agentTrace('route', 'error', { error: err, code });
      routeOutput = { ok: false, message: `Internal error: ${err}`, wasChat: false, route: 'error' };
    }
  } finally {
    if (activeAbortController === thisController) {
      activeAbortController = null;
    }
  }

  const after = buildCompactStateSnapshot(ctx.getState(), ctx.chartRef);

  finalizeTurn(ctx, {
    text,
    route: routeOutput.route,
    template: routeOutput.template,
    planSummary: routeOutput.plan?.summary,
    plan: routeOutput.plan,
    result: routeOutput.result,
    before,
    after,
    returnedCandles: extractReturnedCandles(
      routeOutput.result,
      0, // store will reassign sequenceId and snapshotIds
      after
    ),
  });

  const { template, ...result } = routeOutput;
  return result;
}

function formatHumanDate(iso: string): string {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const parts = iso.split('-').map((s) => parseInt(s, 10));
  if (parts.length !== 3) return iso;
  const month = months[parts[1] - 1] ?? iso;
  return `${month} ${parts[2]}`;
}

function composeCompoundSummary(result: AgentExecutionResult, final: WorldState): string | null {
  const play = result.receipts.find((r) => r.success && r.capability === 'playback.play_until');
  const switched = result.receipts.find((r) => r.success && r.capability === 'session.switch_symbol');
  if (!play || !switched || !final.session.sessionActive) return null;

  const seek = result.receipts.find((r) => r.success && r.capability === 'playback.seek_to_time');
  const tf = result.receipts.find((r) => r.success && r.capability === 'chart.set_timeframe');

  const playData = (play.data as { speed?: number; finalTime?: string } | undefined) ?? {};
  const seekData = (seek?.data as { time?: string } | undefined) ?? {};
  const tfData = (tf?.data as { timeframe?: number } | undefined) ?? {};

  const speed = playData.speed ?? final.session.speed;
  const startTime = seekData.time;
  const endTime = playData.finalTime;
  const timeframe = tfData.timeframe;

  const fragments: string[] = [];
  fragments.push(`Loaded ${final.session.symbol} on ${formatHumanDate(final.session.date)}`);
  if (timeframe && timeframe > 0) fragments.push(`switched to ${timeframe}-minute candles`);
  if (startTime && endTime && speed) {
    fragments.push(`replayed from ${startTime} to ${endTime} at ${speed}x and stopped at ${endTime}`);
  } else if (endTime && speed) {
    fragments.push(`played until ${endTime} at ${speed}x and stopped at ${endTime}`);
  } else if (endTime) {
    fragments.push(`played until ${endTime} and stopped at ${endTime}`);
  } else {
    fragments.push(play.message);
  }
  return fragments.join(', ') + '.';
}

export function composeResponse(result: AgentExecutionResult, ctx: AgentContext): string {
  if (result.ok) {
    const final = result.finalWorldState as WorldState;

    const compound = final ? composeCompoundSummary(result, final) : null;
    if (compound) return compound;

    const analysisReceipts = result.receipts.filter(
      (r) => r.success && typeof r.capability === 'string' && r.capability.startsWith('analysis.')
    );
    const failedAnalysis = result.receipts.filter(
      (r) => !r.success && typeof r.capability === 'string' && r.capability.startsWith('analysis.')
    );

    if (analysisReceipts.length > 0 || failedAnalysis.length > 0) {
      const parts = analysisReceipts.map((r) => r.message);
      for (const r of failedAnalysis) {
        const name = r.capability.replace(/^analysis\./, '');
        parts.push(`${name} failed: ${r.message}`);
      }
      return parts.join(' ');
    }

    const successMessages = result.receipts.filter((r) => r.success).map((r) => r.message);
    if (final && final.session.symbol) {
      return successMessages[successMessages.length - 1] ?? `Done. ${final.session.symbol} is active.`;
    }
    return successMessages.join(' ') || 'Done.';
  }

  const failing = result.receipts.find((r) => !r.success);
  if (failing) return failing.message;
  if (result.errorMessage) return result.errorMessage;

  const world = buildWorldState(ctx.getState(), ctx.chartRef, ctx.performanceLog);
  return `I couldn't do that. Current session is ${world.session.symbol ?? 'none'} ${world.session.date ?? ''}.`;
}
