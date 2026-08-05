import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrionStartupStage } from '../startupState';

let fetchCalls: { url: string; body?: Record<string, unknown> }[] = [];
let fetchResponses: { ok: boolean; status: number; json: () => unknown }[] = [];
let fetchIndex = 0;

function mockFetch(url: string, init?: { body?: string }): Promise<{ ok: boolean; status: number; json: () => unknown }> {
  let body: Record<string, unknown> | undefined;
  try {
    if (init?.body) body = JSON.parse(init.body);
  } catch {
    body = undefined;
  }
  fetchCalls.push({ url, body });
  const response = fetchResponses[fetchIndex++] ?? { ok: false, status: 404, json: () => ({}) };
  return Promise.resolve(response);
}

function waitForStage(stage: OrionStartupStage, timeout = 1000): Promise<void> {
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

describe('orion startup integration', () => {
  beforeEach(async () => {
    vi.resetModules();
    fetchCalls = [];
    fetchResponses = [];
    fetchIndex = 0;
    vi.stubGlobal('fetch', mockFetch);
  });

  it('starts up, warms qwen3:8b, and sends certified runtime options', async () => {
    // /api/tags - runtime reachable
    fetchResponses.push({ ok: true, status: 200, json: () => ({ models: [] }) });
    // /api/show - qwen3:8b present
    fetchResponses.push({ ok: true, status: 200, json: () => ({}) });
    // /api/chat - warm-up
    fetchResponses.push({ ok: true, status: 200, json: () => ({ message: { content: 'ok' } }) });

    const mod = await import('../startupState');
    mod.startOrionStartup();
    await waitForStage('ready');

    const state = mod.getOrionStartupState();
    expect(state.stage).toBe('ready');
    expect(state.activeModelName).toBe('qwen3:8b');

    const chatCall = fetchCalls.find((c) => c.url.includes('/api/chat'));
    expect(chatCall).toBeDefined();
    expect(chatCall?.body).toMatchObject({
      model: 'qwen3:8b',
      think: false,
      keep_alive: '10m',
      options: {
        num_ctx: 4096,
        temperature: 0,
        seed: 42,
        num_predict: 1,
      },
    });
  });

  it('enters model_missing when qwen3:8b is not installed and exposes pull', async () => {
    // /api/tags - runtime reachable
    fetchResponses.push({ ok: true, status: 200, json: () => ({ models: [] }) });
    // /api/show - qwen3:8b not found
    fetchResponses.push({ ok: false, status: 404, json: () => ({}) });

    const mod = await import('../startupState');
    mod.startOrionStartup();
    await waitForStage('model_missing');

    const state = mod.getOrionStartupState();
    expect(state.stage).toBe('model_missing');
    expect(state.canPull).toBe(true);
    expect(state.activeModelName).toBe('qwen3:8b');
  });
});
