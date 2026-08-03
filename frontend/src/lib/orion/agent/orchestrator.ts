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
import { parseChartCommand, type ChartCommand } from '../planner';
import { SYMBOL_ALIASES } from '../symbolAliases';
import { classifyOrionIntent } from '../router';
import { orionChat } from '../client';
import { buildWorldState, renderWorldStateForPrompt } from '../worldState';
import { commonSenseReply } from '../commonSense';
import type { SymbolResolution } from './resolveSymbol';
import { chartCommandToPlan } from './planner-adapter';
import { executeAgentPlan } from './executor';
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
  route: 'chat' | 'deterministic' | 'resolve' | 'natural-language' | 'unrecognized' | 'error';
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
  if (/^(hi|hello|hey|um|uh|hmm|ok|okay|yes|no|what|why|how|tell me|show me|are you|is it|can you|could you|will you|would you|should i)\b/.test(t)) return true;
  return false;
}

function looksLikeSwitch(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(switch|go to|load|open|change to|show)\b/.test(t);
}

function looksLikePlayOrPause(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(play|pause|stop|resume|go)\b/.test(t);
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
    const threadScope = ctx.getState().sessionActive
      ? `This message is about the current session: ${ctx.getState().symbol} ${ctx.getState().replayDate}.`
      : 'There is no active session; the user may be asking general questions.';
    const systemPrompt = [
      'You are Orion, an observant, offline AI trading coach embedded in OpenRewind.',
      threadScope,
      'Be concise: 2-4 short sentences unless asked for detail. Use plain English only.',
      'Do not provide regulated investment advice.',
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

function makeResolvePlan(text: string): AgentPlan {
  return {
    id: makePlanId(),
    kind: 'action',
    summary: 'Resolve requested symbol',
    steps: [
      {
        id: 'resolve-1',
        capability: 'session.resolve_symbol',
        args: { name: text },
        required: true,
      },
    ],
  };
}

async function resolveAndMaybeSwitch(
  text: string,
  ctx: AgentContext,
  token: CancellationToken
): Promise<OrchestratorResult | null> {
  const resolvePlan = makeResolvePlan(text);
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

function supportedIntent(intent: string): boolean {
  return ['switch', 'play', 'pause', 'set_timeframe', 'seek', 'fast_forward', 'rewind'].includes(intent);
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
  if (routeChat || (classification.intent === 'chat' && !looksLikePlayOrPause(text))) {
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
    if (plan) {
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
  }

  // 4. Incomplete or unresolved switch: let resolve_symbol handle it.
  if (cmd.intent === 'switch' || (cmd.intent === 'unknown' && looksLikeSwitch(text))) {
    const resolveStart = now();
    const resolved = await resolveAndMaybeSwitch(text, ctx, token);
    agentTrace('route', 'resolve', { elapsed: elapsed(resolveStart) });
    if (resolved) return resolved;
  }

  // 5. Fallback to chat.
  agentTrace('route', 'fallback-chat', { elapsed: elapsed(routeStart) });
  const message = await runChat(text, ctx, setupReady, routeStart);
  return { ok: true, message, wasChat: true, route: 'chat' };
}

function composeResponse(result: AgentExecutionResult, ctx: AgentContext): string {
  if (result.ok) {
    const successMessages = result.receipts.filter((r) => r.success).map((r) => r.message);
    const final = result.finalWorldState as ReturnType<typeof buildWorldState>;
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
