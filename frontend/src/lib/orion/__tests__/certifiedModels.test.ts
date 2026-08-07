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

  it('requires every certified profile to carry a complete certification identity', async () => {
    const cm = await freshModule();
    const certified = cm.getCertifiedModelRegistry().filter((p) => p.certified);

    for (const p of certified) {
      expect(p.certificationIdentity).toBeDefined();
      const id = p.certificationIdentity!;
      expect(id.modelTag).toBeDefined();
      expect(id.modelDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(id.ollamaVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(id.productionHead).toMatch(/^[a-f0-9]{40}$/);
      expect(id.certificationContractVersion).toBeDefined();
      expect(id.promptSuiteVersion).toBeDefined();
      expect(id.scorerVersion).toBeDefined();
      expect(id.schemaVersion).toBeDefined();
    }
  });

  it('binds the qwen3:8b profile tag to its certification identity', async () => {
    const cm = await freshModule();
    const qwen3 = cm.getCertifiedModelRegistry().find((p) => p.modelId === 'qwen3:8b')!;
    expect(qwen3.certificationIdentity?.modelTag).toBe(qwen3.ollamaTag);
  });

  it('records the exact qwen3:8b V2 certified digest', async () => {
    const cm = await freshModule();
    const qwen3 = cm.getCertifiedModelRegistry().find((p) => p.modelId === 'qwen3:8b')!;
    expect(qwen3.certificationIdentity?.modelDigest).toBe(
      '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41'
    );
  });

  it('records the exact qwen3:8b V2 certified tuple', async () => {
    const cm = await freshModule();
    const id = cm.getCertifiedModelRegistry().find((p) => p.modelId === 'qwen3:8b')!.certificationIdentity!;
    expect(id.ollamaVersion).toBe('0.32.6');
    expect(id.productionHead).toBe('aa4553522065229f62ed5cf85c13a9cdb8740739');
    expect(id.certificationContractVersion).toBe('v2.1.1-semantic');
    expect(id.promptSuiteVersion).toBe('v2.1.0-22-prompts');
    expect(id.scorerVersion).toBe('v2.0.1');
    expect(id.schemaVersion).toBe('v2.0.0');
  });

  it('does not retain legacy V1 certification provenance on certified models', async () => {
    const cm = await freshModule();
    const certified = cm.getCertifiedModelRegistry().filter((p) => p.certified);

    for (const p of certified) {
      expect(p.certificationVersion).not.toBe('orion-runtime-validation-2026-08-04');
      expect(p.benchmarkSuiteVersion).not.toContain('9b8206d5fdfb16fb02fc8d8ad2b9e288b97b7cca');
    }
  });
});
