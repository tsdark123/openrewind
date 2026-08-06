import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppState } from '../../../../types';
import type { AgentContext } from '../types';
import { handleOrionMessage } from '../orchestrator';
import { createExecutionContext } from '../executionContext';

import type { OrionChatMessage } from '../../client';

vi.mock('../../client', () => ({
  ORION_AGENT_MODEL: 'qwen3:8b',
  AGENT_KEEP_ALIVE: '5m',
  orionChat: vi.fn().mockResolvedValue({ content: 'Got it.', toolCalls: [], raw: {} }),
}));

import { orionChat } from '../../client';

function baseAppState(): AppState {
  return {
    symbol: '',
    replayDate: '',
    sessionActive: false,
    isPlaying: false,
    speed: 1,
    timeframe: 1,
    cursor: 0,
    totalCandles: 0,
    currentPrice: 0,
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
    session_id: '',
    start_ts: 0,
    end_ts: 0,
    dataSynced: false,
    symbolError: '',
    dateError: '',
    dateConfirmed: false,
    journalRecords: [],
    journalFilter: null,
    lightMode: false,
    showIntro: false,
    view: 'menu',
    dataSource: 'managed',
    replayRate: 1,
    lastOhlc: null,
  } as unknown as AppState;
}

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const state = baseAppState();
  return {
    getState: () => state,
    chartRef: null,
    performanceLog: {},
    apiBase: 'http://localhost:9000',
    dataDir: undefined,
    availableTickers: ['AAPL', 'ADBE', 'MSFT'],
    send: vi.fn(),
    dispatch: (action) => {
      const a = action as unknown as { type: string; [k: string]: unknown };
      if (a.type === 'SET_PLAYING') {
        state.isPlaying = a.isPlaying as boolean;
      } else if (a.type === 'SET_SPEED') {
        state.speed = a.speed as number;
      } else if (a.type === 'SET_TIMEFRAME') {
        state.timeframe = a.timeframe as number;
      }
    },
    onSwitchSymbol: async (symbol, date) => {
      state.symbol = symbol;
      state.replayDate = date ?? state.replayDate;
      state.sessionActive = true;
    },
    executionLog: createExecutionContext(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(orionChat).mockReset();
  vi.mocked(orionChat).mockResolvedValue({ content: 'Got it.', toolCalls: [], raw: {} });
});

describe('OrionTerminal-style submission through the orchestrator', () => {
  it('um? reaches handleOrionMessage and makes zero Ollama calls', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'um?', ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('chat');
    expect(orionChat).not.toHaveBeenCalled();
    expect(r.message).not.toMatch(/symbol|ticker|invalid|not.*available|session.*ended/i);
  });

  it('huh? reaches handleOrionMessage and makes zero Ollama calls', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'huh?', ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(orionChat).not.toHaveBeenCalled();
  });

  it('wait reaches handleOrionMessage and makes zero Ollama calls', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'wait', ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(orionChat).not.toHaveBeenCalled();
  });

  it('what happened? makes at most one Ollama call and does not produce a symbol error', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;
    const r = await handleOrionMessage({ text: 'what happened?', ctx, setupReady: true });
    expect(r.wasChat).toBe(true);
    expect(r.route).toBe('chat');
    expect(orionChat).toHaveBeenCalledTimes(1);
    const call = vi.mocked(orionChat).mock.calls[0]?.[0];
    const prompt = call?.messages.find((m: OrionChatMessage) => m.role === 'system')?.content ?? '';
    expect(prompt).toMatch(/live snapshot/);
    expect(prompt).not.toMatch(/session ended/);
    expect(r.message).not.toMatch(/symbol not recognized|not.*available|invalid ticker/i);
  });

  it('what happened? uses the previous execution result when one is provided', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;
    ctx.executionLog.record({
      sequenceId: 0,
      timestamp: Date.now(),
      originalRequest: 'switch to ZZZZ',
      route: 'resolve',
      planSummary: 'Resolve requested symbol',
      ok: false,
      receipts: [
        { planId: 'p-1', stepId: 'r-1', capability: 'session.resolve_symbol', success: false, errorCode: 'SYMBOL_UNAVAILABLE', message: 'ZZZZ is not available', finalizedAt: 0 },
      ],
      errorCode: 'SYMBOL_UNAVAILABLE',
      before: { symbol: '', date: '', timeframe: 1, isPlaying: false },
      after: { symbol: '', date: '', timeframe: 1, isPlaying: false },
      returnedCandles: [],
    } as any);
    await handleOrionMessage({ text: 'what happened?', ctx, setupReady: true });
    const call = vi.mocked(orionChat).mock.calls[0]?.[0];
    const prompt = call?.messages.find((m: OrionChatMessage) => m.role === 'system')?.content ?? '';
    expect(prompt).toMatch(/RECENT ACTION/);
    expect(prompt).toMatch(/ZZZZ/);
  });
});

describe('Switch-like raw ticker extraction and failure preservation', () => {
  it('Switch to ZZZZ. is clarified before any resolve/model call', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;
    const r = await handleOrionMessage({ text: 'Switch to ZZZZ.', ctx, setupReady: true });
    expect(r.route).toBe('clarification');
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(true);
    expect(r.result?.errorCode).toBe('SYMBOL_UNAVAILABLE');
    expect(r.message).toMatch(/ZZZZ/);
    expect(ctx.getState().symbol).toBe('AAPL');
  });

  it('go to ABCD is clarified before any resolve/model call', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'go to ABCD', ctx, setupReady: true });
    expect(r.route).toBe('clarification');
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(true);
    expect(r.result?.errorCode).toBe('SYMBOL_UNAVAILABLE');
    expect(r.message).toMatch(/ABCD/);
  });

  it('show me QQQQ extracts QQQQ through resolve_symbol', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'show me QQQQ', ctx, setupReady: true });
    expect(r.result?.receipts[0].capability).toBe('session.resolve_symbol');
    const rc = r.result?.receipts[0];
    if (rc && !rc.success) expect(rc.errorCode).toBe('SYMBOL_UNAVAILABLE');
    expect(r.message).toMatch(/QQQQ.*isn't available/);
  });

  it('pull up WXYZ stock is clarified before any resolve/model call', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'pull up WXYZ stock', ctx, setupReady: true });
    expect(r.route).toBe('clarification');
    expect(r.ok).toBe(false);
    expect(r.wasChat).toBe(true);
    expect(r.result?.errorCode).toBe('SYMBOL_UNAVAILABLE');
    expect(r.message).toMatch(/WXYZ/);
  });

  it('regression: Switch to AAPL. stays deterministic with zero model calls', async () => {
    const ctx = makeCtx();
    const r = await handleOrionMessage({ text: 'Switch to AAPL.', ctx, setupReady: true });
    expect(r.route).toBe('deterministic');
    expect(r.wasChat).toBe(false);
    expect(orionChat).not.toHaveBeenCalled();
  });

  it('Pause. stays deterministic and fast with no model call', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';
    const r = await handleOrionMessage({ text: 'Pause.', ctx, setupReady: true });
    expect(r.route).toBe('deterministic');
    expect(orionChat).not.toHaveBeenCalled();
  });

  it('Play at 10x. stays deterministic and fast with no model call', async () => {
    const ctx = makeCtx();
    ctx.getState().sessionActive = true;
    ctx.getState().symbol = 'AAPL';
    const r = await handleOrionMessage({ text: 'Play at 10x.', ctx, setupReady: true });
    expect(r.route).toBe('deterministic');
    expect(orionChat).not.toHaveBeenCalled();
  });
});

describe('Bounded model request policy', () => {
  it('cancels an in-flight orionChat when a second handleOrionMessage starts', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;

    vi.mocked(orionChat).mockImplementation(async (opts) => {
      // Simulate a long model call that respects the abort signal.
      await new Promise<void>((_, reject) => {
        const check = () => {
          if (opts.signal?.aborted) {
            reject(Object.assign(new Error('aborted by new request'), { code: 'ABORTED' }));
            return;
          }
          setTimeout(check, 10);
        };
        check();
      });
      return { content: '', toolCalls: [], raw: {} };
    });

    const first = handleOrionMessage({ text: 'what kind of candle am I on right now', ctx, setupReady: true });
    // Give the first call a tick to register its abort controller.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = handleOrionMessage({ text: 'switch to MSFT', ctx, setupReady: true });

    const [firstResult] = await Promise.all([first, second]);
    expect(firstResult.route).toBe('aborted');
    expect(firstResult.message).toBe('');

    // The second call should still be able to proceed (route may be resolve or deterministic).
    const secondResult = await second;
    expect(secondResult.ok).toBe(true);
  });

  it('passes an abort signal to orionChat so the caller can cancel a hung response', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;

    await handleOrionMessage({ text: 'what kind of candle am I on right now', ctx, setupReady: true });
    expect(orionChat).toHaveBeenCalled();
    const call = vi.mocked(orionChat).mock.calls[0]?.[0];
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it('A → B → C rapid supersession leaves only C authoritative', async () => {
    const ctx = makeCtx();
    ctx.getState().symbol = 'AAPL';
    ctx.getState().sessionActive = true;

    vi.mocked(orionChat).mockImplementation(async (opts) => {
      // Respect the abort signal: once it is aborted, reject with ABORTED.
      return new Promise((resolve, reject) => {
        const check = () => {
          if (opts.signal?.aborted) {
            reject(Object.assign(new Error('aborted by newer run'), { code: 'ABORTED' }));
            return;
          }
          setTimeout(check, 5);
        };
        check();
      });
    });

    const a = handleOrionMessage({ text: 'what kind of candle am I on right now', ctx, setupReady: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const b = handleOrionMessage({ text: 'compare first and last hour', ctx, setupReady: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const c = handleOrionMessage({ text: 'switch to MSFT', ctx, setupReady: true });

    const [aResult, bResult, cResult] = await Promise.all([a, b, c]);

    expect(aResult.route).toBe('aborted');
    expect(aResult.message).toBe('');
    expect(bResult.route).toBe('aborted');
    expect(bResult.message).toBe('');
    expect(cResult.route).toBe('deterministic');
    expect(cResult.ok).toBe(true);
  });
});
