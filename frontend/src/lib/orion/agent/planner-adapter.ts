// =============================================================================
// Planner adapter — converts the deterministic `ChartCommand` into a V1
// `AgentPlan` so the new executor can run it.
//
// This is a thin bridge: it does not rewrite parsing. It only translates the
// existing command shape into the step/receipt protocol.
// =============================================================================

import type { ChartCommand, ParsedTime } from '../planner';
import type { AgentPlan, AgentStep } from './types';
import { resolveSymbol } from './resolveSymbol';
import { makeStepId } from './types';

function parseTimeToString(t?: ParsedTime): string | undefined {
  if (!t) return undefined;
  const h = t.hour.toString().padStart(2, '0');
  const m = t.minute.toString().padStart(2, '0');
  return `${h}:${m}`;
}

export interface AdapterOptions {
  /** Original user text (used for the resolve_symbol step). */
  originalText: string;
  availableTickers: string[];
}

export function buildSwitchPlan(symbol: string, date?: string, opts?: AdapterOptions): AgentPlan {
  const steps: AgentStep[] = [];
  if (opts?.originalText) {
    steps.push({
      id: makeStepId(0, 'resolve'),
      capability: 'session.resolve_symbol',
      args: { name: opts.originalText },
      required: true,
    });
  }
  steps.push({
    id: makeStepId(steps.length, 'switch'),
    capability: 'session.switch_symbol',
    args: { symbol, date },
    required: true,
    ...(steps.length > 0 ? { dependsOn: [steps[steps.length - 1].id] } : {}),
  });
  return {
    id: `plan-switch-${Date.now()}`,
    kind: 'action',
    summary: `Switch to ${symbol}${date ? ' on ' + date : ''}`,
    steps,
  };
}

export function chartCommandToPlan(cmd: ChartCommand): AgentPlan | null {
  if (cmd.intent === 'unknown') return null;

  switch (cmd.intent) {
    case 'switch':
      return buildSwitchCommandPlan(cmd);

    case 'fast_forward':
      return buildFastForwardPlan(cmd);

    case 'rewind':
      return buildRewindPlan(cmd);

    case 'candle_query':
      return buildCandleQueryPlan(cmd);

    case 'play': {
      const steps: AgentStep[] = [
        {
          id: makeStepId(0, 'play'),
          capability: 'playback.play_until',
          args: {
            speed: cmd.speed ?? 1,
            direction: cmd.direction === 'backward' ? 'backward' : 'forward',
            ...(cmd.endTime ? { untilTime: parseTimeToString(cmd.endTime) } : {}),
          },
          required: true,
        },
      ];
      return {
        id: `plan-play-${Date.now()}`,
        kind: 'action',
        summary: `Play${cmd.speed ? ` at ${cmd.speed}x` : ''}${cmd.endTime ? ' until ' + parseTimeToString(cmd.endTime) : ''}`,
        steps,
      };
    }

    case 'pause':
      return {
        id: `plan-pause-${Date.now()}`,
        kind: 'action',
        summary: 'Pause playback',
        steps: [{ id: makeStepId(0, 'pause'), capability: 'playback.pause', args: {}, required: true }],
      };

    case 'seek': {
      if (!cmd.endTime) return null;
      return {
        id: `plan-seek-${Date.now()}`,
        kind: 'action',
        summary: `Seek to ${parseTimeToString(cmd.endTime)}`,
        steps: [
          {
            id: makeStepId(0, 'seek'),
            capability: 'playback.seek_to_time',
            args: { time: parseTimeToString(cmd.endTime) },
            required: true,
          },
        ],
      };
    }

    case 'set_timeframe': {
      if (cmd.timeframe === undefined) return null;
      return {
        id: `plan-tf-${Date.now()}`,
        kind: 'action',
        summary: `Set ${cmd.timeframe}m timeframe`,
        steps: [
          {
            id: makeStepId(0, 'tf'),
            capability: 'chart.set_timeframe',
            args: { timeframe: cmd.timeframe },
            required: true,
          },
        ],
      };
    }

    default:
      return null;
  }
}

function toTradingDateInput(input: NonNullable<ChartCommand['dateInput']>): import('./resolveTradingDate').TradingDateInput {
  if (input.kind === 'explicit') {
    return { kind: 'explicit', date: input.date ?? '' };
  }
  if (input.kind === 'relative_trading') {
    return {
      kind: 'relative_trading',
      sessions: input.count ?? 1,
      direction: input.direction ?? 'backward',
      from: input.from ?? new Date().toISOString().slice(0, 10),
    };
  }
  return {
    kind: 'relative_calendar',
    days: input.count ?? 1,
    direction: input.direction ?? 'backward',
    from: input.from ?? new Date().toISOString().slice(0, 10),
  };
}

function buildSwitchCommandPlan(cmd: ChartCommand): AgentPlan | null {
  if (!cmd.symbol) return null;
  const steps: AgentStep[] = [];
  let lastStep: AgentStep | undefined;

  if (cmd.dateInput) {
    const resolveStep: AgentStep = {
      id: makeStepId(steps.length, 'resolve-date'),
      capability: 'session.resolve_trading_date',
      args: { symbol: cmd.symbol, input: toTradingDateInput(cmd.dateInput) },
      required: true,
    };
    steps.push(resolveStep);
    lastStep = resolveStep;
  }

  const switchStep: AgentStep = {
    id: makeStepId(steps.length, 'switch'),
    capability: 'session.switch_symbol',
    args: {
      symbol: cmd.symbol,
      ...(cmd.dateInput && lastStep ? { date: { $ref: lastStep.id, path: 'date' } } : { date: cmd.date }),
    },
    required: true,
    ...(lastStep ? { dependsOn: [lastStep.id] } : {}),
  };
  steps.push(switchStep);
  lastStep = switchStep;

  if (cmd.timeframe !== undefined) {
    const tfStep: AgentStep = {
      id: makeStepId(steps.length, 'tf'),
      capability: 'chart.set_timeframe',
      args: { timeframe: cmd.timeframe },
      required: true,
      dependsOn: [lastStep.id],
    };
    steps.push(tfStep);
    lastStep = tfStep;
  }

  return {
    id: `plan-switch-${Date.now()}`,
    kind: 'action',
    summary: `Switch to ${cmd.symbol}${cmd.date ? ' on ' + cmd.date : ''}`,
    steps,
  };
}

function buildFastForwardPlan(cmd: ChartCommand): AgentPlan | null {
  if (!cmd.symbol) return null;
  const steps: AgentStep[] = [];
  let lastStep: AgentStep | undefined;

  if (cmd.dateInput) {
    const resolveStep: AgentStep = {
      id: makeStepId(steps.length, 'resolve-date'),
      capability: 'session.resolve_trading_date',
      args: { symbol: cmd.symbol, input: toTradingDateInput(cmd.dateInput) },
      required: true,
    };
    steps.push(resolveStep);
    lastStep = resolveStep;
  }

  const switchStep: AgentStep = {
    id: makeStepId(steps.length, 'switch'),
    capability: 'session.switch_symbol',
    args: {
      symbol: cmd.symbol,
      ...(cmd.dateInput && lastStep ? { date: { $ref: lastStep.id, path: 'date' } } : { date: cmd.date }),
    },
    required: true,
    ...(lastStep ? { dependsOn: [lastStep.id] } : {}),
  };
  steps.push(switchStep);
  lastStep = switchStep;

  const confirmStep: AgentStep = {
    id: makeStepId(steps.length, 'candle'),
    capability: 'chart.get_current_candle',
    args: {},
    required: true,
    dependsOn: [lastStep.id],
  };
  steps.push(confirmStep);
  lastStep = confirmStep;

  if (cmd.timeframe !== undefined) {
    const tfStep: AgentStep = {
      id: makeStepId(steps.length, 'tf'),
      capability: 'chart.set_timeframe',
      args: { timeframe: cmd.timeframe },
      required: true,
      dependsOn: [lastStep.id],
    };
    steps.push(tfStep);
    lastStep = tfStep;
  }

  if (cmd.startTime) {
    const seekStep: AgentStep = {
      id: makeStepId(steps.length, 'seek'),
      capability: 'playback.seek_to_time',
      args: { time: parseTimeToString(cmd.startTime) },
      required: true,
      dependsOn: [lastStep.id],
    };
    steps.push(seekStep);
    lastStep = seekStep;
  }

  const playStep: AgentStep = {
    id: makeStepId(steps.length, 'play'),
    capability: 'playback.play_until',
    args: {
      speed: cmd.speed ?? 10,
      direction: cmd.direction === 'backward' ? 'backward' : 'forward',
      ...(cmd.endTime ? { untilTime: parseTimeToString(cmd.endTime) } : {}),
    },
    required: true,
    dependsOn: [lastStep.id],
  };
  steps.push(playStep);

  return {
    id: `plan-ff-${Date.now()}`,
    kind: 'action',
    summary: `Fast-forward ${cmd.symbol}${cmd.date ? ' on ' + cmd.date : ''}`,
    steps,
  };
}

function buildRewindPlan(cmd: ChartCommand): AgentPlan | null {
  const minutes = cmd.relativeMinutes;
  if (minutes === undefined) return null;
  const seekStep: AgentStep = {
    id: makeStepId(0, 'seek'),
    capability: 'playback.seek_relative',
    args: { minutes: -minutes },
    required: true,
  };
  const candleStep: AgentStep = {
    id: makeStepId(1, 'candle'),
    capability: 'chart.get_current_candle',
    args: {},
    required: true,
    dependsOn: [seekStep.id],
  };
  return {
    id: `plan-rewind-${Date.now()}`,
    kind: 'action',
    summary: `Rewind ${minutes} minutes`,
    steps: [seekStep, candleStep],
  };
}

function buildCandleQueryPlan(cmd: ChartCommand): AgentPlan | null {
  const time = cmd.endTime ?? cmd.startTime;
  if (!time) return null;
  return {
    id: `plan-candle-${Date.now()}`,
    kind: 'query',
    summary: `Candle at ${parseTimeToString(time)}`,
    steps: [
      {
        id: makeStepId(0, 'candle'),
        capability: 'chart.get_candle_at_time',
        args: { time: parseTimeToString(time) },
        required: true,
      },
    ],
  };
}

export function resolveNaturalLanguagePlan(text: string, opts: AdapterOptions): AgentPlan | null {
  const r = resolveSymbol(text, { availableTickers: opts.availableTickers });
  if (r.ok) {
    return buildSwitchPlan(r.symbol, undefined, { ...opts, originalText: text });
  }
  return null;
}
