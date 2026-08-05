import { describe, it, expect, vi } from 'vitest';

function freshModule() {
  return import('../certifiedModels');
}

describe('certifiedModels', () => {
  it('resolves the default certified model as qwen3:8b', async () => {
    const cm = await freshModule();
    const resolved = cm.resolveActiveModel();
    expect(resolved.modelId).toBe('qwen3:8b');
    expect(resolved.ollamaTag).toBe('qwen3:8b');
    expect(resolved.certified).toBe(true);
    expect(resolved.source).toBe('certified');
    expect(resolved.controlledContextSize).toBe(4096);
    expect(resolved.thinking).toBe(false);
    expect(resolved.keepAlive).toBe('10m');
  });

  it('allows a Node/Vitest override that matches the certified registry', async () => {
    vi.stubGlobal('process', { env: { ORION_AGENT_MODEL: 'qwen3:8b' } });
    const cm = await freshModule();
    const resolved = cm.resolveActiveModel();
    expect(resolved.modelId).toBe('qwen3:8b');
    expect(resolved.ollamaTag).toBe('qwen3:8b');
    expect(resolved.certified).toBe(true);
    expect(resolved.source).toBe('env-override-certified');
    vi.unstubAllGlobals();
  });

  it('prefers the Node/Vitest override over the Vite override when both are present', async () => {
    vi.stubGlobal('process', {
      env: {
        ORION_AGENT_MODEL: 'qwen3:8b',
      },
    });
    const cm = await freshModule();
    const resolved = cm.resolveActiveModel();
    expect(resolved.ollamaTag).toBe('qwen3:8b');
    expect(resolved.source).toBe('env-override-certified');
    vi.unstubAllGlobals();
  });

  it('uses the override tag but does not mark it certified when it is not in the registry', async () => {
    vi.stubGlobal('process', { env: { ORION_AGENT_MODEL: 'llama3.2' } });
    const cm = await freshModule();
    const resolved = cm.resolveActiveModel();
    expect(resolved.ollamaTag).toBe('llama3.2');
    expect(resolved.certified).toBe(false);
    expect(resolved.source).toBe('env-override-uncertified');
    expect(resolved.controlledContextSize).toBe(4096);
    expect(resolved.thinking).toBe(false);
    vi.unstubAllGlobals();
  });

  it('keeps runtime options aligned with the resolved certified model', async () => {
    const cm = await freshModule();
    const opts = cm.getOrionRuntimeOptions();
    expect(opts.num_ctx).toBe(4096);
    expect(opts.think).toBe(false);
    expect(opts.keep_alive).toBe('10m');
    expect(opts.temperature).toBe(0);
    expect(opts.seed).toBe(42);
  });

  it('finds only qwen3:8b in the certified registry', async () => {
    const cm = await freshModule();
    const certified = cm.getCertifiedModelRegistry().filter((p) => p.certified);
    expect(certified).toHaveLength(1);
    expect(certified[0].modelId).toBe('qwen3:8b');
  });
});
