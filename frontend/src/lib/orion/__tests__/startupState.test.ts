import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrionStartupState } from '../startupState';

const mockCheckOllamaReachable = vi.fn().mockResolvedValue(false);
const mockEnsureModel = vi.fn();
const mockPullOrionModel = vi.fn();
const mockWarmOrionAgent = vi.fn();
const mockIsTauri = vi.fn().mockReturnValue(false);

vi.mock('../client', () => ({
  checkOllamaReachable: () => mockCheckOllamaReachable(),
  ensureModel: (...args: any[]) => mockEnsureModel(...args),
  pullOrionModel: (...args: any[]) => mockPullOrionModel(...args),
  warmOrionAgent: (...args: any[]) => mockWarmOrionAgent(...args),
  isTauri: () => mockIsTauri(),
}));

vi.mock('../certifiedModels', () => ({
  resolveActiveModel: () => ({
    modelId: 'qwen3:8b',
    ollamaTag: 'qwen3:8b',
    controlledContextSize: 4096,
    thinking: false,
    keepAlive: '10m',
    certified: true,
    source: 'certified',
    certificationVersion: 'orion-runtime-validation-2026-08-04',
  }),
  getActiveOrionModelTag: () => 'qwen3:8b',
}));

function waitForStage(stage: OrionStartupState['stage'], timeout = 1000): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const mod = await import('../startupState');
    const deadline = Date.now() + timeout;
    const check = () => {
      if (mod.getOrionStartupState().stage === stage) {
        resolve();
        return true;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for stage ${stage}`));
        return true;
      }
      return false;
    };
    if (check()) return;
    const interval = setInterval(() => {
      if (check()) clearInterval(interval);
    }, 10);
  });
}

describe('orion startup state', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockCheckOllamaReachable.mockReset();
    mockEnsureModel.mockReset();
    mockPullOrionModel.mockReset();
    mockWarmOrionAgent.mockReset();
    mockIsTauri.mockReset().mockReturnValue(false);
  });

  it('starts at idle and exposes the active certified model', async () => {
    const mod = await import('../startupState');
    const state = mod.getOrionStartupState();
    expect(state.stage).toBe('idle');
    expect(state.activeModelName).toBe('qwen3:8b');
    expect(state.model.certified).toBe(true);
  });

  it('reaches ready when the runtime and model are healthy', async () => {
    mockCheckOllamaReachable.mockResolvedValue(true);
    mockEnsureModel.mockResolvedValue({ ready: true });
    mockWarmOrionAgent.mockResolvedValue({ ok: true, elapsed: 100 });

    const mod = await import('../startupState');
    mod.startOrionStartup();

    await waitForStage('ready');

    const state = mod.getOrionStartupState();
    expect(state.stage).toBe('ready');
    expect(state.canRetry).toBe(false);
    expect(mockCheckOllamaReachable).toHaveBeenCalled();
    expect(mockEnsureModel).toHaveBeenCalledWith('qwen3:8b');
    expect(mockWarmOrionAgent).toHaveBeenCalled();
  });

  it('enters model_missing when the model is not present', async () => {
    mockCheckOllamaReachable.mockResolvedValue(true);
    mockEnsureModel.mockResolvedValue({ ready: false, error: 'model-missing' });

    const mod = await import('../startupState');
    mod.startOrionStartup();

    await waitForStage('model_missing');

    const state = mod.getOrionStartupState();
    expect(state.stage).toBe('model_missing');
    expect(state.canPull).toBe(true);
    expect(state.canContinueDeterministic).toBe(true);
    expect(mockWarmOrionAgent).not.toHaveBeenCalled();
  });

  it('pulls the model with consent and reaches ready', async () => {
    mockCheckOllamaReachable.mockResolvedValue(true);
    mockEnsureModel
      .mockResolvedValueOnce({ ready: false, error: 'model-missing' })
      .mockResolvedValueOnce({ ready: true });
    mockPullOrionModel.mockResolvedValue(undefined);
    mockWarmOrionAgent.mockResolvedValue({ ok: true, elapsed: 100 });

    const mod = await import('../startupState');
    mod.startOrionStartup();
    await waitForStage('model_missing');

    mod.pullSelectedModelWithConsent();
    await waitForStage('ready');

    const state = mod.getOrionStartupState();
    expect(state.stage).toBe('ready');
    expect(mockPullOrionModel).toHaveBeenCalledWith('qwen3:8b', expect.any(Function));
    expect(mockEnsureModel).toHaveBeenCalledWith('qwen3:8b');
  });

  it('enters warmup_failed when the warm-up fails', async () => {
    mockCheckOllamaReachable.mockResolvedValue(true);
    mockEnsureModel.mockResolvedValue({ ready: true });
    mockWarmOrionAgent.mockResolvedValue({ ok: false, elapsed: 100 });

    const mod = await import('../startupState');
    mod.startOrionStartup();

    await waitForStage('warmup_failed');

    const state = mod.getOrionStartupState();
    expect(state.stage).toBe('warmup_failed');
    expect(state.canRetry).toBe(true);
  });

  it('enters runtime_missing when the runtime is not reachable and Tauri cannot start it', async () => {
    mockCheckOllamaReachable.mockResolvedValue(false);

    const mod = await import('../startupState');
    mod.startOrionStartup();

    await waitForStage('runtime_missing');

    const state = mod.getOrionStartupState();
    expect(state.stage).toBe('runtime_missing');
    expect(state.canInstallOllama).toBe(false); // because isTauri mocked false
  });

  it('retries from a failed state', async () => {
    mockCheckOllamaReachable.mockResolvedValue(true);
    mockEnsureModel
      .mockResolvedValueOnce({ ready: false, error: 'model-missing' })
      .mockResolvedValueOnce({ ready: true });
    mockWarmOrionAgent.mockResolvedValue({ ok: true, elapsed: 100 });

    const mod = await import('../startupState');
    mod.startOrionStartup();
    await waitForStage('model_missing');

    mod.retryOrionStartup();
    await waitForStage('ready');

    expect(mod.getOrionStartupState().stage).toBe('ready');
  });

  it('transitions to deterministic_only when requested', async () => {
    mockCheckOllamaReachable.mockResolvedValue(true);
    mockEnsureModel.mockResolvedValue({ ready: false, error: 'model-missing' });

    const mod = await import('../startupState');
    mod.startOrionStartup();
    await waitForStage('model_missing');

    mod.continueDeterministicOrion();

    const state = mod.getOrionStartupState();
    expect(state.stage).toBe('deterministic_only');
    expect(state.canRetry).toBe(true);
  });

  it('revalidates from ready by starting a fresh check', async () => {
    mockCheckOllamaReachable
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockEnsureModel
      .mockResolvedValueOnce({ ready: true })
      .mockResolvedValueOnce({ ready: false, error: 'model-missing' });
    mockWarmOrionAgent.mockResolvedValue({ ok: true, elapsed: 100 });

    const mod = await import('../startupState');
    mod.startOrionStartup();
    await waitForStage('ready');

    mod.revalidateOrionStartup();
    await waitForStage('model_missing');

    expect(mod.getOrionStartupState().stage).toBe('model_missing');
  });
});
