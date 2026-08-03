// =============================================================================
// Intent-to-AgentPlan compiler.
//
// Takes a validated SemanticIntent and produces a deterministic AgentPlan using
// only the existing V1 capability registry. Runtime anchors (today's date for
// relative trading-date requests) are supplied from TypeScript, never from the
// model.
// =============================================================================

import type { AgentPlan, AgentStep } from './types';
import type { ChartActionIntent, SemanticPlayback } from './intent';
import { getCapability } from './capabilities';

export interface CompileOptions {
  /** Anchor for relative_trading dates (YYYY-MM-DD). Defaults to today. */
  anchorDate?: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isMutating(capability: string): boolean {
  return getCapability(capability)?.kind === 'mutate';
}

function planKind(steps: AgentStep[]): AgentPlan['kind'] {
  const anyMutate = steps.some((s) => isMutating(s.capability));
  const anyRead = steps.some((s) => !isMutating(s.capability));
  if (anyMutate && anyRead) return 'mixed';
  if (anyMutate) return 'action';
  return 'query';
}

function argRef(stepId: string, path?: string): Record<string, unknown> {
  return { $ref: stepId, ...(path ? { path } : {}) };
}

export function compileChartActionIntent(
  intent: ChartActionIntent,
  options: CompileOptions = {}
): AgentPlan {
  const anchorDate = options.anchorDate ?? today();
  const steps: AgentStep[] = [];
  let lastStepId: string | undefined;

  // Helper to push a step and chain it onto the previous one.
  function pushStep(step: AgentStep): void {
    if (lastStepId && !step.dependsOn) {
      step.dependsOn = [lastStepId];
    }
    steps.push(step);
    lastStepId = step.id;
  }

  // 1. Previous symbol (no args, relies on session history).
  if (intent.previousSymbol) {
    pushStep({
      id: 'step-previous',
      capability: 'session.switch_to_previous_symbol',
      args: {},
      required: true,
    });
  }

  // 2. Resolve symbol when present (and not previous).
  let resolveSymbolId: string | undefined;
  if (intent.symbol) {
    resolveSymbolId = 'step-resolve-symbol';
    pushStep({
      id: resolveSymbolId,
      capability: 'session.resolve_symbol',
      args: { name: intent.symbol },
      required: true,
    });
  }

  // 3. Resolve trading date when present.
  if (intent.date) {
    if (intent.previousSymbol) {
      throw new Error('compileChartActionIntent: date cannot be combined with previousSymbol.');
    }
    if (!resolveSymbolId) {
      throw new Error('compileChartActionIntent: date requires a symbol.');
    }
    const resolveDateId = 'step-resolve-date';
    const dateStep: AgentStep = {
      id: resolveDateId,
      capability: 'session.resolve_trading_date',
      args: {
        symbol: argRef(resolveSymbolId, 'symbol'),
        input:
          intent.date.kind === 'absolute'
            ? { kind: 'explicit', date: intent.date.value }
            : {
                kind: 'relative_trading',
                sessions: intent.date.count ?? 1,
                direction: intent.date.direction ?? 'backward',
                from: anchorDate,
              },
      },
      required: true,
      dependsOn: [resolveSymbolId],
    };
    steps.push(dateStep);
    lastStepId = resolveDateId;

    // 4. Switch symbol using resolved symbol and date.
    pushStep({
      id: 'step-switch',
      capability: 'session.switch_symbol',
      args: {
        symbol: argRef(resolveSymbolId, 'symbol'),
        date: argRef(resolveDateId, 'date'),
      },
      required: true,
      dependsOn: [resolveDateId],
    });
  } else if (resolveSymbolId) {
    // 4a. Switch to the resolved symbol with no date.
    pushStep({
      id: 'step-switch',
      capability: 'session.switch_symbol',
      args: { symbol: argRef(resolveSymbolId, 'symbol') },
      required: true,
      dependsOn: [resolveSymbolId],
    });
  }

  // 5. Set timeframe.
  if (intent.timeframeMinutes !== undefined) {
    pushStep({
      id: 'step-timeframe',
      capability: 'chart.set_timeframe',
      args: { timeframe: intent.timeframeMinutes },
      required: true,
    });
  }

  // 6a. Relative seek.
  if (intent.relativeSeekMinutes !== undefined) {
    pushStep({
      id: 'step-seek-relative',
      capability: 'playback.seek_relative',
      args: { minutes: intent.relativeSeekMinutes },
      required: true,
    });
  }

  // 6b. Seek to an absolute time.
  if (intent.seekTime !== undefined) {
    pushStep({
      id: 'step-seek-time',
      capability: 'playback.seek_to_time',
      args: { time: intent.seekTime },
      required: true,
    });
  }

  // 7. Playback control.
  if (intent.playback) {
    pushStep(compilePlaybackStep(intent.playback));
  }

  // 8. Final query.
  if (intent.finalQuery === 'current_candle') {
    pushStep({
      id: 'step-current-candle',
      capability: 'chart.get_current_candle',
      args: {},
      required: false,
    });
  } else if (intent.finalQuery === 'candle_at_time') {
    pushStep({
      id: 'step-candle-at-time',
      capability: 'chart.get_candle_at_time',
      args: { time: intent.queryTime! },
      required: false,
    });
  }

  // Compact summary.
  const fragments: string[] = [];
  if (intent.previousSymbol) fragments.push('previous symbol');
  if (intent.symbol) fragments.push(intent.symbol);
  if (intent.date?.kind === 'relative_trading') fragments.push(`${intent.date.count} session(s) ${intent.date.direction}`);
  if (intent.date?.kind === 'absolute') fragments.push(intent.date.value!);
  if (intent.timeframeMinutes) fragments.push(`${intent.timeframeMinutes}m`);
  if (intent.seekTime) fragments.push(`@${intent.seekTime}`);
  if (intent.relativeSeekMinutes !== undefined) fragments.push(`${intent.relativeSeekMinutes}m relative`);
  if (intent.playback) fragments.push(intent.playback.action);
  if (intent.finalQuery) fragments.push(intent.finalQuery);
  const summary = fragments.length > 0 ? fragments.join(' · ') : 'Chart action';

  return {
    id: `plan-intent-${Date.now()}`,
    kind: planKind(steps),
    summary,
    steps,
    meta: { planner: 'compact-intent' },
  };
}

function compilePlaybackStep(playback: SemanticPlayback): AgentStep {
  if (playback.action === 'pause') {
    return {
      id: 'step-pause',
      capability: 'playback.pause',
      args: {},
      required: true,
    };
  }

  // play and play_until both map to playback.play_until.
  const args: Record<string, unknown> = {};
  if (playback.speed !== undefined) args.speed = playback.speed;
  if (playback.untilTime !== undefined) {
    args.untilTime = playback.untilTime;
  }
  return {
    id: playback.action === 'play_until' ? 'step-play-until' : 'step-play',
    capability: 'playback.play_until',
    args,
    required: true,
  };
}
