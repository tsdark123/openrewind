import { describe, it, expect } from 'vitest';
import type { AgentPlan } from '../types';
import { validateAgentPlan } from '../validatePlan';

function makePlan(steps: AgentPlan['steps'], overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: 'plan-test',
    kind: 'action',
    summary: 'test plan',
    steps,
    ...overrides,
  };
}

const resolveSymbol = { id: 'step-1', capability: 'session.resolve_symbol', args: { name: 'Nvidia' }, required: true };

const switchSymbol = {
  id: 'step-2',
  capability: 'session.switch_symbol',
  args: { symbol: 'NVDA' },
  required: true,
  dependsOn: ['step-1'],
};

const setTimeframe = {
  id: 'step-3',
  capability: 'chart.set_timeframe',
  args: { timeframe: 15 },
  required: true,
  dependsOn: ['step-2'],
};

const seekTime = {
  id: 'step-4',
  capability: 'playback.seek_to_time',
  args: { time: '11:15' },
  required: true,
  dependsOn: ['step-3'],
};

const currentCandle = {
  id: 'step-5',
  capability: 'chart.get_current_candle',
  args: {},
  required: true,
  dependsOn: ['step-4'],
};

describe('validateAgentPlan', () => {
  it('accepts a valid sequential plan', () => {
    const plan = makePlan([resolveSymbol, switchSymbol, setTimeframe, seekTime, currentCandle]);
    expect(validateAgentPlan(plan)).toEqual({ ok: true });
  });

  it('rejects an unknown capability', () => {
    const plan = makePlan([{ id: 'step-1', capability: 'vwap.add_indicator', args: {}, required: true }]);
    const r = validateAgentPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('UNKNOWN_CAPABILITY');
  });

  it('rejects a missing required argument', () => {
    const plan = makePlan([{ id: 'step-1', capability: 'session.switch_symbol', args: {}, required: true }]);
    const r = validateAgentPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('rejects an invalid argument type', () => {
    const plan = makePlan([{ id: 'step-1', capability: 'chart.set_timeframe', args: { timeframe: '15m' }, required: true }]);
    const r = validateAgentPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('rejects an invalid $ref to an unknown step', () => {
    const plan = makePlan([
      { id: 'step-1', capability: 'session.resolve_trading_date', args: { symbol: 'NVDA', input: { kind: 'relative_trading', sessions: 1 } }, required: true },
      { id: 'step-2', capability: 'session.switch_symbol', args: { symbol: 'NVDA', date: { $ref: 'step-missing', path: 'date' } }, required: true, dependsOn: ['step-1'] },
    ]);
    const r = validateAgentPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('rejects a dependency on a later step', () => {
    const plan = makePlan([
      { id: 'step-1', capability: 'session.switch_symbol', args: { symbol: 'NVDA' }, required: true, dependsOn: ['step-2'] },
      { id: 'step-2', capability: 'chart.set_timeframe', args: { timeframe: 15 }, required: true },
    ]);
    const r = validateAgentPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_PLAN');
  });

  it('rejects a dependency on itself', () => {
    const plan = makePlan([{ id: 'step-1', capability: 'playback.pause', args: {}, required: true, dependsOn: ['step-1'] }]);
    const r = validateAgentPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_PLAN');
  });

  it('rejects a circular dependency', () => {
    const plan = makePlan([
      { id: 'step-1', capability: 'session.switch_symbol', args: { symbol: 'NVDA' }, required: true, dependsOn: ['step-3'] },
      { id: 'step-2', capability: 'chart.set_timeframe', args: { timeframe: 15 }, required: true, dependsOn: ['step-1'] },
      { id: 'step-3', capability: 'playback.seek_to_time', args: { time: '10:00' }, required: true, dependsOn: ['step-2'] },
    ]);
    const r = validateAgentPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_PLAN');
  });

  it('rejects duplicate step ids', () => {
    const step = { id: 'step-1', capability: 'playback.pause', args: {}, required: true };
    const plan = makePlan([step, step]);
    const r = validateAgentPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_PLAN');
  });

  it('rejects too many steps', () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({
      id: `step-${i + 1}`,
      capability: 'playback.pause' as const,
      args: {},
      required: true as const,
    }));
    const r = validateAgentPlan(makePlan(steps));
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_PLAN');
  });

  it('rejects suspicious strings in arguments', () => {
    const plan = makePlan([{ id: 'step-1', capability: 'session.resolve_symbol', args: { name: 'javascript:alert(1)' }, required: true }]);
    const r = validateAgentPlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('rejects a plan with no steps', () => {
    const r = validateAgentPlan(makePlan([]));
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_PLAN');
  });

  it('rejects a plan with no id', () => {
    const r = validateAgentPlan({ id: '', kind: 'action', summary: 'bad', steps: [resolveSymbol] });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_PLAN');
  });
});
