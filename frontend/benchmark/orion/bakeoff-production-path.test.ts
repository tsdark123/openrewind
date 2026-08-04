import { describe, it, expect, vi } from 'vitest';
import type { AppState } from '../../src/types';
import type { AgentContext } from '../../src/lib/orion/agent/types';
import { createExecutionContext } from '../../src/lib/orion/agent/executionContext';
import { parseChartCommand } from '../../src/lib/orion/planner';
import { getRequestedDimensions } from '../../src/lib/orion/agent/dimensions';
import { makeContextFixture } from './bakeoff-suite';

vi.mock('../../src/lib/orion/client', () => ({
  orionChat: vi.fn().mockImplementation(({ messages }: { messages: { role: string; content: string }[] }) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const text = user.toLowerCase();
    let content = '';
    if (text.includes('pull up the bar at 11:15 for nvda on 2026-07-31')) {
      content = '{"kind":"chart_action","symbol":"NVDA","queryTime":"11:15","finalQuery":"candle_at_time"}';
    } else if (text.includes('previous stock')) {
      content = '{"kind":"chart_action","previousSymbol":true}';
    } else if (text.includes('same timeframe but go to the prior')) {
      content = '{"kind":"chart_action","date":{"kind":"relative_trading","count":1,"direction":"backward"},"contextReference":{"source":"latest_successful_action","mode":"inherit","inherit":["timeframe"]}}';
    } else {
      content = '{}';
    }
    return { content, toolCalls: [], raw: {} };
  }),
  ORION_AGENT_MODEL: 'llama3.2:latest',
  ORION_CHAT_MODEL: 'llama3.2:latest',
}));

vi.mock('../../src/lib/orion/agent/executor', () => ({
  executeAgentPlan: vi.fn().mockResolvedValue({
    ok: true,
    planId: 'mock-plan',
    receipts: [],
  }),
}));

import { handleOrionMessage } from '../../src/lib/orion/agent/orchestrator';
import { orionChat } from '../../src/lib/orion/client';
import { executeAgentPlan } from '../../src/lib/orion/agent/executor';

function makeActiveCtx(): AgentContext {
  const { store } = makeContextFixture();
  const state: AppState = {
    symbol: 'NVDA',
    replayDate: '2026-07-31',
    sessionActive: true,
    isPlaying: false,
    speed: 1,
    timeframe: 15,
    cursor: 0,
    totalCandles: 0,
    currentPrice: 100,
    playbackDirection: 'forward',
    balance: 100000,
    equity: 100000,
    openPositions: [],
    pendingOrders: [],
    indicators: {
      ema20: false,
      sma50: false,
      bollinger: false,
      rsi: false,
      macd: false,
      atr: false,
      stochastic: false,
    },
    activeSessionTrades: [],
    tradeHistory: [],
    connected: true,
    performanceLog: {},
  } as unknown as AppState;
  return {
    getState: () => state,
    chartRef: null,
    performanceLog: {},
    apiBase: 'http://localhost:9000',
    dataDir: undefined,
    availableTickers: ['AAPL', 'MSFT', 'NVDA'],
    send: vi.fn(),
    dispatch: vi.fn(),
    onSwitchSymbol: async (symbol, date) => {
      state.symbol = symbol;
      state.replayDate = date ?? state.replayDate;
      state.sessionActive = true;
    },
    executionLog: store,
  };
}

describe('bake-off production path probes', () => {
  beforeEach(() => {
    vi.mocked(orionChat).mockClear();
    vi.mocked(executeAgentPlan).mockClear();
  });

  it('prompt #4 resolves through production with active identical date as a no-op', async () => {
    const ctx = makeActiveCtx();
    const text = 'Pull up the bar at 11:15 for NVDA on 2026-07-31.';
    const cmd = parseChartCommand(text, ctx.availableTickers, {}, ctx.getState().replayDate);
    const requested = Array.from(getRequestedDimensions(text, cmd, ctx.getState().replayDate));

    const r = await handleOrionMessage({ text, ctx, setupReady: true });
    const plan = r.plan!;

    expect(cmd.symbol).toBe('NVDA');
    expect(cmd.dateInput).toEqual({ kind: 'explicit', date: '2026-07-31' });
    expect(cmd.endTime).toEqual({ hour: 11, minute: 15 });
    expect(requested).toEqual(expect.arrayContaining(['symbol', 'date', 'absoluteTime', 'candleQuery']));
    expect(r.route).toBe('llm-plan');
    expect(r.wasChat).toBe(false);
    expect(orionChat).toHaveBeenCalled();
    expect(executeAgentPlan).toHaveBeenCalled();
    expect(plan.steps.map((s) => s.capability)).toEqual([
      'session.resolve_symbol',
      'session.resolve_trading_date',
      'session.switch_symbol',
      'playback.seek_to_time',
      'chart.get_candle_at_time',
    ]);
  });

  it('prompt #13 resolves to switch_to_previous_symbol with no candle query', async () => {
    const ctx = makeActiveCtx();
    const r = await handleOrionMessage({ text: 'Take me back to the previous stock.', ctx, setupReady: true });
    const plan = r.plan!;

    expect(r.route).toBe('llm-plan');
    expect(r.wasChat).toBe(false);
    expect(orionChat).toHaveBeenCalled();
    expect(plan.steps.map((s) => s.capability)).toEqual(['session.switch_to_previous_symbol']);
  });

  it('prompt #15 retains inherited timeframe and prior-session date in compiled plan', async () => {
    const ctx = makeActiveCtx();
    const r = await handleOrionMessage({ text: 'Use the same timeframe but go to the prior trading session.', ctx, setupReady: true });
    const plan = r.plan!;

    expect(r.route).toBe('llm-plan');
    expect(r.wasChat).toBe(false);
    expect(orionChat).toHaveBeenCalled();
    expect(plan.steps.map((s) => s.capability)).toEqual([
      'session.resolve_symbol',
      'session.resolve_trading_date',
      'session.switch_symbol',
      'chart.set_timeframe',
    ]);
    const resolveSymbol = plan.steps.find((s) => s.capability === 'session.resolve_symbol');
    expect(resolveSymbol?.args?.name).toBe('NVDA');
  });
});
