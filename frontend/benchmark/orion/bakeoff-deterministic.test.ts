import { describe, it, expect, vi } from 'vitest';
import type { AppState } from '../../src/types';
import type { AgentContext } from '../../src/lib/orion/agent/types';
import { createExecutionContext } from '../../src/lib/orion/agent/executionContext';

vi.mock('../../src/lib/orion/client', () => ({
  orionChat: vi.fn().mockResolvedValue({ content: '', toolCalls: [], raw: {} }),
  ORION_AGENT_MODEL: 'llama3.2:latest',
  ORION_CHAT_MODEL: 'llama3.2:latest',
}));

vi.mock('../../src/lib/orion/agent/executor', () => ({
  executeAgentPlan: vi.fn().mockResolvedValue({ ok: true, planId: 'mock-plan', receipts: [] }),
}));

import { handleOrionMessage } from '../../src/lib/orion/agent/orchestrator';
import { orionChat } from '../../src/lib/orion/client';
import { executeAgentPlan } from '../../src/lib/orion/agent/executor';

function baseAppState(): AppState {
  return {
    symbol: 'AAPL',
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
}

function makeCtx(): AgentContext {
  const state = baseAppState();
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
    executionLog: createExecutionContext(),
  };
}

describe('bake-off deterministic routing regressions', () => {
  beforeEach(() => {
    vi.mocked(orionChat).mockClear();
    vi.mocked(executeAgentPlan).mockClear();
  });

  it('routes prompt #9 through the production deterministic path with zero Ollama calls', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Use five-minute bars.', ctx, setupReady: true });

    expect(r.route).toBe('deterministic');
    expect(r.wasChat).toBe(false);
    expect(orionChat).not.toHaveBeenCalled();
    expect(executeAgentPlan).toHaveBeenCalled();
    const plan = vi.mocked(executeAgentPlan).mock.calls[0]?.[0];
    expect(plan.steps.some((s: any) => s.capability === 'chart.set_timeframe')).toBe(true);
  });

  it('routes prompt #10 through the production deterministic path with zero Ollama calls', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({
      text: 'Switch to AAPL 2026-07-31, use 15m and play at 2x until 10:30.',
      ctx,
      setupReady: true,
    });

    expect(r.route).toBe('deterministic');
    expect(r.wasChat).toBe(false);
    expect(orionChat).not.toHaveBeenCalled();
    expect(executeAgentPlan).toHaveBeenCalled();
    const plan = vi.mocked(executeAgentPlan).mock.calls[0]?.[0];
    expect(plan.steps.some((s: any) => s.capability === 'session.switch_symbol')).toBe(true);
    expect(plan.steps.some((s: any) => s.capability === 'chart.set_timeframe')).toBe(true);
    expect(plan.steps.some((s: any) => s.capability === 'playback.play_until')).toBe(true);
  });
});
