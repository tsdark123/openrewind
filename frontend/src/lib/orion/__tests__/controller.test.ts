import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppState, PerformanceLog } from '../../types';
import type { OrionControllerBridge } from '../controller';

const mockReleaseAgentModel = vi.fn().mockResolvedValue(undefined);
const mockOrionChat = vi.fn();
const mockOllamaToolSchemas = vi.fn().mockReturnValue([]);
const mockInvokeOrionTool = vi.fn().mockResolvedValue({ ok: true });
const mockListOrionTools = vi.fn().mockReturnValue([]);
const mockBuildWorldState = vi.fn().mockReturnValue({});
const mockRenderWorldStateForPrompt = vi.fn().mockReturnValue('');
const mockLoadOrionThreads = vi.fn().mockResolvedValue({});
const mockSetAutomationActive = vi.fn();
const mockClearAutomatedIds = vi.fn();

vi.mock('../client', () => ({
  orionChat: (...args: any[]) => mockOrionChat(...args),
  AGENT_KEEP_ALIVE: '10m',
  releaseAgentModel: () => mockReleaseAgentModel(),
  warmOrionAgent: vi.fn(),
  getActiveOrionModelTag: vi.fn().mockReturnValue('qwen3:8b'),
}));

vi.mock('../tools', () => ({
  ollamaToolSchemas: (...args: any[]) => mockOllamaToolSchemas(...args),
  invokeOrionTool: (...args: any[]) => mockInvokeOrionTool(...args),
  listOrionTools: (...args: any[]) => mockListOrionTools(...args),
}));

vi.mock('../worldState', () => ({
  buildWorldState: (...args: any[]) => mockBuildWorldState(...args),
  renderWorldStateForPrompt: (...args: any[]) => mockRenderWorldStateForPrompt(...args),
}));

vi.mock('../../lib/orionThreads', () => ({
  loadOrionThreads: () => mockLoadOrionThreads(),
}));

vi.mock('../automatedIds', () => ({
  setAutomationActive: (...args: any[]) => mockSetAutomationActive(...args),
  clearAutomatedIds: () => mockClearAutomatedIds(),
}));

function makeBridge(): OrionControllerBridge {
  const state: AppState = {
    connected: true,
    sessionActive: true,
    symbol: 'AAPL',
    replayDate: '2026-08-04',
    cursor: 0,
    totalCandles: 100,
    timeframe: 5,
    currentPrice: 150,
    isPlaying: false,
    speed: 1,
    playbackDirection: 'forward',
    orderQuantity: 100,
    indicators: {
      ema20: false,
      sma50: false,
      bollinger: false,
      rsi: false,
      macd: false,
      atr: false,
      stochastic: false,
    },
    balance: 100000,
    equity: 100000,
    openPositions: [],
    pendingOrders: [],
    tradeHistory: [],
    activeSessionTrades: [],
    performanceLog: {} as PerformanceLog,
  };

  return {
    getState: () => state,
    getChartHandle: () => null,
    send: () => {},
    dispatch: () => {},
    apiBase: 'http://localhost:5000',
    postChatMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('orion controller lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes a task without forcing a model release', async () => {
    mockOrionChat.mockResolvedValue({
      content: 'Plan executed successfully.',
      toolCalls: [],
      thinking: '',
    });

    const mod = await import('../controller');
    const bridge = makeBridge();
    mod.orionController.bind(bridge);

    const result = await mod.orionController.runAgentTask('switch to AAPL and pause');

    expect(result).toEqual({ ok: true });
    expect(mockOrionChat).toHaveBeenCalledTimes(1);
    expect(mockOrionChat).toHaveBeenCalledWith(
      expect.objectContaining({
        keepAlive: '10m',
      })
    );
    expect(mockReleaseAgentModel).not.toHaveBeenCalled();
  });

  it('does not send a keep_alive: 0s unload after a normal task', async () => {
    mockOrionChat.mockResolvedValue({
      content: 'Done.',
      toolCalls: [],
      thinking: '',
    });

    const mod = await import('../controller');
    const bridge = makeBridge();
    mod.orionController.bind(bridge);

    await mod.orionController.runAgentTask('reset the chart');

    // releaseAgentModel is the only source of keep_alive: 0s; it must stay unused.
    expect(mockReleaseAgentModel).not.toHaveBeenCalled();
    expect(mockOrionChat).toHaveBeenCalledWith(
      expect.objectContaining({
        keepAlive: '10m',
      })
    );
  });

  it('keeps the model resident even when the tool loop runs multiple iterations', async () => {
    // First iteration returns a tool call; second returns no tool calls.
    mockOrionChat
      .mockResolvedValueOnce({
        content: 'I will switch now.',
        toolCalls: [{ function: { name: 'switch_symbol', arguments: { symbol: 'AAPL' } } }],
        thinking: '',
      })
      .mockResolvedValueOnce({
        content: 'Switched and paused.',
        toolCalls: [],
        thinking: '',
      });

    const mod = await import('../controller');
    const bridge = makeBridge();
    mod.orionController.bind(bridge);

    const result = await mod.orionController.runAgentTask('switch to AAPL and pause');

    expect(result).toEqual({ ok: true });
    expect(mockOrionChat).toHaveBeenCalledTimes(2);
    expect(mockOrionChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        keepAlive: '10m',
      })
    );
    expect(mockReleaseAgentModel).not.toHaveBeenCalled();
  });
});
