// =============================================================================
// Orchestrator — single shared entry point for Orion terminal input.
//
// Routing policy
//   1. Short interjections/hesitations are handled offline, instantly.
//   2. Conversation-classified inputs go to the chat path (offline or Ollama).
//   3. Deterministic chart parser is tried next.  A fast path is only taken
//      when the parse is a supported intent and has all required fields.
//   4. Incomplete switch requests (parser sees switch but no symbol, or the
//      whole parse is unknown and the user seems to be naming a symbol) are
//      converted into a resolve_symbol plan.  That produces a structured
//      SYMBOL_UNAVAILABLE / SYMBOL_AMBIGUOUS receipt when appropriate.
//   5. Anything not handled falls back to chat.
//
// Every request logs routing timing when ORION_AGENT_DEBUG is enabled.
// =============================================================================

import type { AgentContext, AgentPlan, AgentExecutionResult, CancellationToken } from './types';
import { createCancellationSource, type CancellationSource } from './types';
import { parseChartCommand, extractDateInput, type ChartCommand } from '../planner';
import { SYMBOL_ALIASES } from '../symbolAliases';
import { classifyOrionIntent } from '../router';
import { orionChat } from '../client';
import { buildWorldState, renderWorldStateForPrompt, type WorldState } from '../worldState';
import { commonSenseReply } from '../commonSense';
import type { SymbolResolution } from './resolveSymbol';
import { chartCommandToPlan } from './planner-adapter';
import { executeAgentPlan } from './executor';
import { extractSemanticIntent } from './intent';
import { compileChartActionIntent } from './intentCompiler';
import { validateAgentPlan } from './validatePlan';
import { agentTrace } from './config';

export interface OrchestratorOptions {
  /** Whether Ollama/chat model is ready. */
  setupReady: boolean;
  /** Original user text. */
  text: string;
  /** Current agent context (state, send, dispatch, chartRef, etc.). */
  ctx: AgentContext;
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
  route: 'chat' | 'deterministic' | 'resolve' | 'llm-plan' | 'clarification' | 'unsupported' | 'unrecognized' | 'error';
}

let planCounter = 0;

function makePlanId(): string {
  return `plan-${++planCounter}-${Date.now().toString(36)}`;
}

let activeCancellation: CancellationSource | null = null;

function cancelPreviousPlan(): void {
  if (activeCancellation && !activeCancellation.cancelled) {
    activeCancellation.cancel('new message received');
  }
}

function newCancellation(): CancellationSource {
  cancelPreviousPlan();
  activeCancellation = createCancellationSource();
  return activeCancellation;
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
  'yes?': 'What would you like to do?',
  'no?': 'No problem. Let me know what you need.',
  'really?': 'Really. What do you need?',
};

function shortInterjectionReply(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/g, '');
  return INTERJECTIONS[t] ?? null;
}

function isConversation(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length <= 4) return true;
  if (/^(hi|hello|hey|um|uh|hmm|ok|okay|yes|no|what|why|how|tell me|are you|is it|can you|could you|will you|would you|should i)\b/.test(t)) return true;
  return false;
}

function looksLikeSwitch(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(switch|go to|load|open|change to|show|pull)\b/.test(t);
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
    const last = ctx.lastResult;
    const recentContext = last
      ? `RECENT ACTION\n${last.ok ? 'Succeeded' : 'Failed'}: ${last.receipts.filter((r) => r.success || r.success === false).map((r) => r.message).join('; ')}`
      : 'No prior action recorded in this turn.';
    const systemPrompt = [
      'You are Orion, an observant, offline AI trading coach embedded in OpenRewind.',
      `The WORLD STATE below is a live snapshot of the current session, not a completed/ended session. Do not claim the session has ended unless sessionActive is explicitly false.`,
      'Only state facts that are present in the WORLD STATE or RECENT ACTION. Do not invent trades, profits, losses, or state changes.',
      'Be concise: 2-4 short sentences unless asked for detail. Use plain English only.',
      'Do not provide regulated investment advice.',
      '',
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
    });
    const total = now() - llmStart;
    agentTrace('llm chat end', { text, total, firstToken: total });
    return res.content.trim() || 'No response.';
  } catch (e) {
    const total = now() - llmStart;
    const err = e instanceof Error ? e.message : String(e);
    console.warn('[orchestrator] chat failed:', err);
    agentTrace('llm chat failed', { text, total, error: err });
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

async function resolveAndMaybeSwitch(
  text: string,
  ctx: AgentContext,
  cmd: ChartCommand,
  token: CancellationToken
): Promise<OrchestratorResult | null> {
  const query = extractSymbolCandidate(text);
  const resolvePlan = makeResolvePlan(query);
  resolvePlan.id = makePlanId();
  const resolveResult = await executeAgentPlan(resolvePlan, ctx, token);

  // Resolve failed cleanly: report structured failure and do not change state.
  const failingReceipt = resolveResult.receipts.find((rc) => !rc.success);
  if (failingReceipt) {
    return {
      ok: false,
      message: failingReceipt.message,
      wasChat: false,
      plan: resolvePlan,
      result: resolveResult,
      route: 'resolve',
    };
  }

  // Resolve succeeded: extract the symbol and attempt a switch.
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
  const switchPlan: AgentPlan = {
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

  if (!isDeterministicPlanComplete(switchPlan, text, cmd, ctx.getState().replayDate)) {
    agentTrace('route', 'resolve-incomplete', { text });
    return null;
  }

  const switchResult = await executeAgentPlan(switchPlan, ctx, token);

  // Combine receipts for the caller.
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

  return {
    ok: combinedResult.ok,
    message: composeResponse(combinedResult, ctx),
    wasChat: false,
    plan: switchPlan,
    result: combinedResult,
    route: 'resolve',
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

type ActionDimension = 'symbol' | 'date' | 'timeframe' | 'absoluteTime' | 'relativeSeek' | 'playbackControl' | 'candleQuery' | 'previousSymbol';

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
    if (cap === 'chart.get_current_candle' || cap === 'chart.get_candle_at_time' || cap === 'chart.candle_query') {
      covered.add('candleQuery');
      if (cap === 'chart.get_candle_at_time' && step.args?.time) covered.add('absoluteTime');
    }
    if (cap === 'session.switch_to_previous_symbol') {
      covered.add('previousSymbol');
      covered.add('symbol');
    }
  }
  return covered;
}


function textRequestsTimeframe(t: string): boolean {
  const hasContext = /\b(?:timeframe|time frame|tf|bars?|chart)\b/i.test(t);
  const numberWord = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty|sixty)';
  const unit = '(?:m|min|minute|minutes|h|hour|hours|d|day|days)';
  const explicit = new RegExp(`\\b${numberWord}\\s*(?:-?${unit})?(?:\\s*(?:bar(?:s)?|timeframe|tf))?\\b`, 'i');
  return hasContext ? explicit.test(t) : /\b\d+\s*m\b/i.test(t);
}

function textRequestsDate(t: string): boolean {
  return (
    /\b(?:prior|previous|last)\s+(?:trading\s+)?(?:session|day)s?\b/i.test(t) ||
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:trading\s+)?(?:session|day)s?\s+(?:ago|back|before)\b/i.test(t) ||
    /\b(?:yesterday|today|tomorrow)\b/i.test(t) ||
    /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(t) ||
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/.test(t)
  );
}

function textRequestsAbsoluteTime(t: string): boolean {
  return (
    /\b\d{1,2}:\d{2}\b/.test(t) ||
    /\b\d{1,2}\s*(?:am|pm)\b/i.test(t) ||
    /\b(?:noon|midnight|market\s+open|market\s+close)\b/i.test(t) ||
    /\b(?:quarter|half)\s+(?:past|to)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(t) ||
    /\bo\'clock\b/i.test(t)
  );
}

function textRequestsRelativeSeek(t: string): boolean {
  if (/\b(?:take me back|previous symbol|previous stock|stock i was just on|was just on)\b/i.test(t)) return false;
  return (
    /\b(?:\d+|half)\s*(?:an?\s+)?(?:minute|minutes|hour|hours|hr|hrs|min|mins)\s+(?:ago|earlier|later|before|after)\b/i.test(t) ||
    /\b(?:earlier|later)\b/i.test(t) ||
    /\b(?:go|move|skip|jump)\s+back\b/i.test(t) ||
    /\brewind\s+(?:\d+|half|a few)?\s*(?:minute|minutes|hour|hours)?/i.test(t)
  );
}

function textRequestsPlaybackControl(t: string): boolean {
  return /\b(?:play|pause|rewind|fast[-\s]?forward|fastforward|speed up|slow down|set\s+speed)\b/i.test(t);
}

function textRequestsCandleQuery(t: string): boolean {
  if (/\b(?:candle|bar|ohlc)\b/i.test(t)) return true;
  if (/\b(?:price|worth|value)\b/i.test(t)) {
    return /\b(?:what|tell|give|show|which|the)\s+(?:price|worth|value)\b/i.test(t) ||
      /\b(?:price|worth|value)\s+(?:at|of)\b/i.test(t);
  }
  return false;
}

function textRequestsPreviousSymbol(t: string): boolean {
  return /\b(?:take me back|previous symbol|previous stock|stock i was just on|was just on)\b/i.test(t);
}

function getRequestedDimensions(text: string, cmd: ChartCommand, baseDate?: string): Set<ActionDimension> {
  const t = text;
  const dims = new Set<ActionDimension>();

  if (cmd.symbol || cmd.intent === 'switch' || looksLikeSwitch(text)) {
    dims.add('symbol');
  }
  if (cmd.date || cmd.dateInput || extractDateInput(text, baseDate)) {
    dims.add('date');
  } else if (textRequestsDate(t)) {
    dims.add('date');
  }
  if (cmd.timeframe !== undefined) {
    dims.add('timeframe');
  } else if (textRequestsTimeframe(t)) {
    dims.add('timeframe');
  }
  if (cmd.startTime || cmd.endTime) {
    dims.add('absoluteTime');
  } else if (textRequestsAbsoluteTime(t)) {
    dims.add('absoluteTime');
  }
  if (cmd.relativeMinutes !== undefined) {
    dims.add('relativeSeek');
  } else if (textRequestsRelativeSeek(t)) {
    dims.add('relativeSeek');
  }
  if (cmd.speed !== undefined || ['play', 'pause', 'rewind', 'fast_forward', 'set_speed', 'seek'].includes(cmd.intent)) {
    dims.add('playbackControl');
  } else if (textRequestsPlaybackControl(t)) {
    dims.add('playbackControl');
  }
  if (cmd.intent === 'candle_query') {
    dims.add('candleQuery');
    if (cmd.startTime || cmd.endTime) dims.add('absoluteTime');
  } else if (textRequestsCandleQuery(t)) {
    dims.add('candleQuery');
  }
  if (textRequestsPreviousSymbol(t)) {
    dims.add('previousSymbol');
  }
  return dims;
}

function isDeterministicPlanComplete(plan: AgentPlan, text: string, cmd: ChartCommand, baseDate?: string): boolean {
  const requested = getRequestedDimensions(text, cmd, baseDate);
  const covered = planCoversDimensions(plan);
  agentTrace('deterministic completeness', { requested: Array.from(requested), covered: Array.from(covered) });
  for (const dim of requested) {
    if (!covered.has(dim)) {
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
  // play / fast_forward / rewind need an active session, but we let the capability
  // decide whether it can run; the parse itself is valid.
  return true;
}

export async function handleOrionMessage(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  const { text, ctx, setupReady } = opts;
  const routeStart = now();

  cancelPreviousPlan();
  const token = newCancellation();

  agentTrace('handleOrionMessage start', text, { tickers: ctx.availableTickers.length });

  // 1. Instant interjections.
  const interjection = shortInterjectionReply(text);
  if (interjection) {
    agentTrace('route', 'interjection', { elapsed: elapsed(routeStart) });
    return { ok: true, message: interjection, wasChat: true, route: 'chat' };
  }

  // 2. Conversation heuristics / classifier.
  const routeChat = isConversation(text);
  const classification = classifyOrionIntent(text);
  if (
    routeChat &&
    classification.intent === 'chat' &&
    !looksLikePlayOrPause(text) &&
    !looksLikeSwitch(text) &&
    !looksLikeChartQuery(text)
  ) {
    agentTrace('route', 'chat', { elapsed: elapsed(routeStart) });
    const message = await runChat(text, ctx, setupReady, routeStart);
    return { ok: true, message, wasChat: true, route: 'chat' };
  }

  // 3. Deterministic chart parser.
  const parseStart = now();
  const cmd: ChartCommand = parseChartCommand(text, ctx.availableTickers, SYMBOL_ALIASES, ctx.getState().replayDate);
  agentTrace('parsed chart command', cmd, { parseElapsed: elapsed(parseStart) });

  if (isFastPathReady(cmd)) {
    const plan = chartCommandToPlan(cmd);
    if (plan && isDeterministicPlanComplete(plan, text, cmd, ctx.getState().replayDate)) {
      plan.id = plan.id || makePlanId();
      const result = await executeAgentPlan(plan, ctx, token);
      agentTrace('route', 'deterministic', { elapsed: elapsed(routeStart), result: result.ok });
      return {
        ok: result.ok,
        message: composeResponse(result, ctx),
        wasChat: false,
        plan,
        result,
        route: 'deterministic',
      };
    }
    if (plan) {
      agentTrace('route', 'deterministic-incomplete', { elapsed: elapsed(routeStart) });
    }
  }

  // 4. Incomplete or unresolved switch: let resolve_symbol handle it.
  if ((cmd.intent === 'switch' && !cmd.symbol) || (cmd.intent === 'unknown' && looksLikeSwitch(text))) {
    const resolveStart = now();
    const resolved = await resolveAndMaybeSwitch(text, ctx, cmd, token);
    agentTrace('route', 'resolve', { elapsed: elapsed(resolveStart) });
    if (resolved) return resolved;
  }

  // 5. Compact semantic-intent extraction for unfamiliar or compound actionable language.
  if (setupReady && (classification.intent === 'agent' || !routeChat)) {
    const llmStart = now();
    agentTrace('route', 'llm-intent-start', { elapsed: elapsed(routeStart) });
    const semantic = await extractSemanticIntent(text);
    agentTrace('llm intent end', { elapsed: elapsed(llmStart), result: semantic.ok ? 'intent' : semantic.kind });

    if (semantic.ok) {
      const plan = compileChartActionIntent(semantic.intent, {
        anchorDate: ctx.getState().replayDate || new Date().toISOString().slice(0, 10),
      });
      const validation = validateAgentPlan(plan);
      if (!validation.ok) {
        agentTrace('route', 'error', { elapsed: elapsed(routeStart), error: validation.error });
        return { ok: false, message: `I could not build a valid plan: ${validation.error}`, wasChat: false, route: 'error' };
      }
      plan.id = plan.id || makePlanId();
      const result = await executeAgentPlan(plan, ctx, token);
      agentTrace('route', 'llm-plan', { elapsed: elapsed(routeStart), result: result.ok });
      return {
        ok: result.ok,
        message: composeResponse(result, ctx),
        wasChat: false,
        plan,
        result,
        route: 'llm-plan',
      };
    }

    const { kind, message } = semantic;
    if (kind === 'clarification') {
      agentTrace('route', 'clarification', { elapsed: elapsed(routeStart) });
      return { ok: true, message, wasChat: true, route: 'clarification' };
    }

    if (kind === 'unsupported') {
      agentTrace('route', 'unsupported', { elapsed: elapsed(routeStart) });
      return { ok: false, message, wasChat: false, route: 'unsupported' };
    }

    if (kind === 'invalid') {
      agentTrace('route', 'error', { elapsed: elapsed(routeStart), error: message });
      return { ok: false, message, wasChat: false, route: 'error' };
    }

    // offline / model unreachable
    agentTrace('route', 'error', { elapsed: elapsed(routeStart), error: message });
    return { ok: false, message, wasChat: false, route: 'error' };
  }

  // 6. Final chat fallback.
  agentTrace('route', 'fallback-chat', { elapsed: elapsed(routeStart) });
  const message = await runChat(text, ctx, setupReady, routeStart);
  return { ok: true, message, wasChat: true, route: 'chat' };
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

function composeResponse(result: AgentExecutionResult, ctx: AgentContext): string {
  if (result.ok) {
    const successMessages = result.receipts.filter((r) => r.success).map((r) => r.message);
    const final = result.finalWorldState as WorldState;

    const compound = final ? composeCompoundSummary(result, final) : null;
    if (compound) return compound;

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
