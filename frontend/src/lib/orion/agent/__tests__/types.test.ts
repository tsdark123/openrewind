import { describe, it, expect } from 'vitest';
import {
  V1_CAPABILITIES,
  isV1Capability,
  createCancellationSource,
  receiptIsSuccess,
  makeStepId,
  isRequiredStep,
  type AgentPlan,
  type ExecutionReceipt,
} from '../types';

describe('V1 capability set', () => {
  it('contains exactly thirteen capabilities', () => {
    expect(V1_CAPABILITIES).toHaveLength(13);
  });

  it('contains all requested V1 names', () => {
    const expected = [
      'system.get_world_state',
      'session.resolve_symbol',
      'session.switch_symbol',
      'session.switch_to_previous_symbol',
      'session.resolve_trading_date',
      'chart.set_timeframe',
      'playback.seek_relative',
      'playback.seek_to_time',
      'playback.play_until',
      'playback.pause',
      'chart.get_current_candle',
      'chart.get_candle_at_time',
    ];
    for (const cap of expected) {
      expect(isV1Capability(cap), `missing: ${cap}`).toBe(true);
    }
  });

  it('rejects unknown and non-string values', () => {
    expect(isV1Capability('nope')).toBe(false);
    expect(isV1Capability(123 as unknown as string)).toBe(false);
    expect(isV1Capability(null as unknown as string)).toBe(false);
  });
});

describe('plan helpers', () => {
  it('makes stable step ids', () => {
    expect(makeStepId(0)).toBe('step-1');
    expect(makeStepId(4, 'sub')).toBe('sub-5');
  });

  it('treats required steps correctly', () => {
    expect(isRequiredStep({ id: 's', capability: 'x', args: {} })).toBe(true);
    expect(isRequiredStep({ id: 's', capability: 'x', args: {}, required: false })).toBe(false);
  });
});

describe('receipt narrowing', () => {
  it('identifies success receipts', () => {
    const good: ExecutionReceipt = {
      planId: 'p',
      stepId: 's',
      capability: 'x',
      success: true,
      message: 'ok',
      finalizedAt: 0,
    };
    const bad: ExecutionReceipt = {
      planId: 'p',
      stepId: 's',
      capability: 'x',
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'boom',
      finalizedAt: 0,
    };
    expect(receiptIsSuccess(good)).toBe(true);
    expect(receiptIsSuccess(bad)).toBe(false);
  });
});

describe('AgentPlan shape', () => {
  it('supports sequential required steps with dependencies', () => {
    const plan: AgentPlan = {
      id: 'plan-1',
      kind: 'action',
      summary: 'switch and seek',
      steps: [
        { id: 'step-1', capability: 'session.switch_symbol', args: { symbol: 'AAPL' } },
        {
          id: 'step-2',
          capability: 'playback.seek_to_time',
          args: { time: '09:30' },
          dependsOn: ['step-1'],
        },
      ],
    };
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[1].dependsOn).toEqual(['step-1']);
    expect(plan.steps[0].required).toBeUndefined();
    expect(isRequiredStep(plan.steps[0])).toBe(true);
  });

  it('can represent a pure chat plan with no steps', () => {
    const plan: AgentPlan = {
      id: 'plan-2',
      kind: 'chat',
      summary: 'greeting',
      steps: [],
      chat: 'Hi there.',
    };
    expect(plan.steps).toHaveLength(0);
    expect(plan.kind).toBe('chat');
  });
});

describe('CancellationSource', () => {
  it('starts uncancelled and transitions once', () => {
    const src = createCancellationSource();
    expect(src.cancelled).toBe(false);
    src.cancel('user-typed-new-message');
    expect(src.cancelled).toBe(true);
    expect(src.reason).toBe('user-typed-new-message');
  });
});
