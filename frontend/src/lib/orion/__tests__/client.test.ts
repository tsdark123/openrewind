import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeFetchMock(responseFor: (url: string, callIndex: number) => { ok: boolean; status: number; json: () => unknown } | Promise<never>) {
  let callIndex = 0;
  return vi.fn(async (url: string, _init?: RequestInit) => {
    callIndex += 1;
    const res = responseFor(String(url), callIndex);
    return res as unknown as Response;
  });
}

describe('orion client warm-up', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('deduplicates overlapping warmOrionAgent calls and only loads the model once', async () => {
    const fetchMock = makeFetchMock((url) => {
      if (url.includes('/api/show')) {
        return { ok: true, status: 200, json: () => ({}) };
      }
      if (url.includes('/api/chat')) {
        return { ok: true, status: 200, json: () => ({ message: { content: 'ok' } }) };
      }
      return { ok: false, status: 404, json: () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = await import('../client');
    const a = client.warmOrionAgent();
    const b = client.warmOrionAgent();

    expect(a).toBe(b);
    const r = await a;
    expect(r.ok).toBe(true);
    // One /api/show (ensureModel) and one /api/chat (warm-up call).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const chatCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/chat'));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0][0]).toContain('/api/chat');
    expect((chatCalls[0][1] as { body: string }).body).toContain('"num_predict":1');
  });

  it('ignores a failed warm-up and still allows the next agent orionChat to proceed', async () => {
    let chatCall = 0;
    const fetchMock = makeFetchMock((url) => {
      if (url.includes('/api/show')) {
        return { ok: true, status: 200, json: () => ({}) };
      }
      if (url.includes('/api/chat')) {
        chatCall += 1;
        if (chatCall === 1) {
          return Promise.reject(new Error('Ollama offline'));
        }
        return { ok: true, status: 200, json: () => ({ message: { content: 'real' } }) };
      }
      return { ok: false, status: 404, json: () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = await import('../client');
    const warmup = client.warmOrionAgent();
    await expect(warmup).resolves.toEqual(expect.objectContaining({ ok: false }));

    const result = await client.orionChat({
      tier: 'agent',
      messages: [{ role: 'user', content: 'hello' }],
      keepAlive: client.AGENT_KEEP_ALIVE,
    });

    expect(result.content).toBe('real');
    // First /api/chat failed (warm-up), second succeeded (real call).
    const chatCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/chat'));
    expect(chatCalls).toHaveLength(2);
  });

  it('chat-tier orionChat runs independently of an agent warm-up in flight', async () => {
    let chatCall = 0;
    const fetchMock = makeFetchMock((url) => {
      if (url.includes('/api/show')) {
        return { ok: true, status: 200, json: () => ({}) };
      }
      if (url.includes('/api/chat')) {
        chatCall += 1;
        return { ok: true, status: 200, json: () => ({ message: { content: `call-${chatCall}` } }) };
      }
      return { ok: false, status: 404, json: () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = await import('../client');
    // Start an agent warm-up.
    const warmup = client.warmOrionAgent();

    // A chat call does not await the agent warm-up (different model tier)
    // and therefore succeeds with its own response.
    const result = await client.orionChat({
      tier: 'chat',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.content).toBe('call-2');

    // Finish the warm-up so the test can clean up without dangling promises.
    await warmup;
  });
});
