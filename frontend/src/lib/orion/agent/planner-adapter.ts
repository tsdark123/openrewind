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
    case 'switch': {
      if (!cmd.symbol) return null;
      return {
        id: `plan-switch-${Date.now()}`,
        kind: 'action',
        summary: `Switch to ${cmd.symbol}${cmd.date ? ' on ' + cmd.date : ''}`,
        steps: [
          {
            id: makeStepId(0, 'switch'),
            capability: 'session.switch_symbol',
            args: { symbol: cmd.symbol, date: cmd.date },
            required: true,
          },
        ],
      };
    }

    case 'play': {
      const steps: AgentStep[] = [
        {
          id: makeStepId(0, 'play'),
          capability: 'playback.play_until',
          args: {
            speed: cmd.speed ?? 1,
            direction: cmd.direction === 'backward' ? 'backward' : 'forward',
            until: cmd.endTime ? toEngineTsHelper(cmd, cmd.endTime) : undefined,
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

function toEngineTsHelper(cmd: ChartCommand, t: ParsedTime): number | undefined {
  if (!cmd.date) return undefined;
  // Keep the date helper local; do not import planner's toEngineTs to avoid a cycle.
  const [y, mo, d] = cmd.date.split('-').map((n) => parseInt(n, 10));
  if (Number.isNaN(y) || Number.isNaN(mo) || Number.isNaN(d)) return undefined;
  const firstSunday = (year: number, month0: number) => {
    const firstDayEpoch = Math.floor(Date.UTC(year, month0, 1) / 86400000);
    const dow = (firstDayEpoch + 4) % 7;
    return 1 + ((7 - dow) % 7);
  };
  const dstStart = (year: number) => firstSunday(year, 2) + 7;
  const dstEnd = (year: number) => firstSunday(year, 10);
  const isDst =
    (mo > 3 && mo < 11) ||
    (mo === 3 && d >= dstStart(y)) ||
    (mo === 11 && d < dstEnd(y));
  const offsetHours = isDst ? 4 : 5;
  return Math.floor(Date.UTC(y, mo - 1, d, t.hour, t.minute, 0) / 1000) + offsetHours * 60 * 60;
}

export function resolveNaturalLanguagePlan(text: string, opts: AdapterOptions): AgentPlan | null {
  const r = resolveSymbol(text, { availableTickers: opts.availableTickers });
  if (r.ok) {
    return buildSwitchPlan(r.symbol, undefined, { ...opts, originalText: text });
  }
  return null;
}
