// =============================================================================
// client — Unified Ollama /api/chat wrapper with two-tier model support.
//
// Chat mode: uses `llama3.2:3b`, no tool schema, no keep-alive override.
//            Snappy responses for "what did I just do?" style questions.
//
// Agent mode: uses `llama3.1:8b` with the Orion tool schema attached and
//             a 10-minute `keep_alive` so subsequent agent calls in the same
//             session don't pay the reload cost. When the model is idle we
//             let Ollama unload it (default 5m TTL) — we don't pin it in RAM
//             indefinitely because that murders low-VRAM laptops.
//
// The client is deliberately transport-agnostic: in Tauri it calls the Ollama
// HTTP endpoint directly at 127.0.0.1:11434 through `@tauri-apps/plugin-http`
// (bypasses CORS + webview networking quirks). In browser dev mode the same
// requests are routed through the Vite proxy at `/ollama` so CORS and
// OLLAMA_ORIGINS are not an issue. `orionChat` picks the right one automatically.
// =============================================================================

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { agentTrace } from './agent/config';

export type OrionModelTier = 'chat' | 'agent';

export const ORION_CHAT_MODEL = 'llama3.2';

function getEnvOrionAgentModel(): string | undefined {
  const envProcess = (globalThis as typeof globalThis & { process?: { env?: Record<string, string> } }).process;
  return envProcess?.env?.ORION_AGENT_MODEL;
}

// Production default is llama3.2:latest. The optional ORION_AGENT_MODEL env var
// is provided for local model validation without hard-coding a dev override.
export const ORION_AGENT_MODEL = getEnvOrionAgentModel() ?? 'llama3.2:latest';

// 10 minutes as a duration string — Ollama's keep_alive accepts either a
// duration ("10m", "1h") or a seconds integer. We use the string form so
// intent is obvious in logs.
export const AGENT_KEEP_ALIVE = '10m';
// 0 == unload immediately. Used when the agent finishes a task and we want
// to free VRAM/RAM on modest hardware.
export const AGENT_KEEP_ALIVE_IDLE = '0s';

// ---------------------------------------------------------------------------
// Planner warm-up state
// ---------------------------------------------------------------------------
// One warm-up call per application session. It is launched non-blocking from
// App boot, but agent orionChat calls may await it so the model is already in
// memory for the first real request. React StrictMode double-mounts are
// deduplicated by the module-level promise.

interface WarmupResult {
  ok: boolean;
  elapsed: number;
}

let agentWarmupPromise: Promise<WarmupResult> | null = null;
let agentWarmupGeneration = 0;

function maybeGetWarmupPromise(): Promise<WarmupResult> | null {
  return agentWarmupPromise;
}

export interface OrionChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // Ollama surfaces requested tool calls under this field on assistant turns.
  tool_calls?: OrionToolCall[];
  // For tool-response messages, echo the tool name so the model can match
  // it to the originating call. `name` is the Ollama-native field; `tool_name`
  // is kept for our own debugging.
  name?: string;
  tool_name?: string;
}

export interface OrionToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface OrionChatOptions {
  tier: OrionModelTier;
  messages: OrionChatMessage[];
  tools?: Array<Record<string, unknown>>;
  keepAlive?: string;
  format?: 'json' | string;
  options?: {
    temperature?: number;
    seed?: number;
    num_predict?: number;
    num_ctx?: number;
  };
  /** Ollama's qwen3-style reasoning switch. false disables the hidden thinking block. */
  think?: boolean;
  /** Internal: bypass the warm-up wait for the agent model. */
  skipWarmup?: boolean;
}

export interface OrionChatResponse {
  content: string;
  toolCalls: OrionToolCall[];
  raw: unknown;
}

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as any;
  const tauri = win.__TAURI__?.core ?? win.__TAURI_INTERNALS__;
  return typeof tauri?.invoke === 'function';
}

export function getOllamaBaseUrl(): string {
  const envProcess = (globalThis as typeof globalThis & { process?: { env?: Record<string, string> } }).process;
  const envBase = envProcess?.env?.OLLAMA_BASE_URL;
  if (envBase) return envBase;
  return isTauri() ? 'http://127.0.0.1:11434' : '/ollama';
}

async function ollamaFetch(path: string, init: RequestInit): Promise<Response> {
  const url = `${getOllamaBaseUrl()}${path}`;
  return isTauri() ? tauriFetch(url, init as any) : fetch(url, init);
}

function ollamaFetchWithTimeout(path: string, init: RequestInit, ms: number, reason: string): Promise<Response> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      controller.abort();
      reject(new Error(reason));
    }, ms);
    ollamaFetch(path, { ...init, signal: controller.signal }).then(
      (r) => { clearTimeout(id); resolve(r); },
      (e) => { clearTimeout(id); reject(e); }
    );
  });
}

/**
 * Model resolution.
 *
 * `llama3.1:8b` in particular is expensive to load; we don't want the app
 * to trigger a multi-GB download during a snappy chat message. So the
 * agent tier lazily ensures the model exists before the first call and
 * caches that determination for the process lifetime.
 */
const ensuredModels = new Set<string>();

const OLLAMA_CHECK_TIMEOUT = 5000;

export async function ensureModel(model: string): Promise<{ ready: boolean; error?: string }> {
  if (ensuredModels.has(model)) return { ready: true };

  const start = Date.now();
  agentTrace('ensureModel start', { runtime: isTauri() ? 'tauri' : 'browser', baseUrl: getOllamaBaseUrl(), model });
  console.log('[orion-client] runtime:', isTauri() ? 'tauri' : 'browser', 'baseUrl:', getOllamaBaseUrl(), 'ensureModel:', model);

  // /api/show is cheap: it 200s when the model exists, 404s otherwise.
  try {
    const res = await ollamaFetchWithTimeout(
      '/api/show',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      },
      OLLAMA_CHECK_TIMEOUT,
      'Ollama is not responding'
    );
    if (res.ok) {
      ensuredModels.add(model);
      agentTrace('ensureModel end', { model, ready: true, elapsed: Date.now() - start });
      console.log('[orion-client] ensureModel result:', { model, ready: true });
      return { ready: true };
    }
    if (res.status !== 404) {
      return { ready: false, error: `Ollama /api/show ${res.status}` };
    }
  } catch (e) {
    return { ready: false, error: e instanceof Error ? e.message : String(e) };
  }

  return { ready: false, error: 'model-missing' };
}

/**
 * Pull the given model from Ollama. Blocks until completion. Progress is
 * reported through the optional callback so the UI can render a status
 * chip (the agent-mode boot indicator).
 */
const OLLAMA_PULL_CONNECT_TIMEOUT = 10000;

export async function pullOrionModel(
  model: string,
  onProgress?: (percent: number, status: string) => void
): Promise<void> {
  const res = await ollamaFetchWithTimeout(
    '/api/pull',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    },
    OLLAMA_PULL_CONNECT_TIMEOUT,
    'Ollama is not responding'
  );
  if (!res.ok || !res.body) {
    throw new Error(`Ollama /api/pull ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const update = JSON.parse(line) as { status?: string; completed?: number; total?: number };
        if (onProgress && update.status) {
          const pct =
            typeof update.completed === 'number' && typeof update.total === 'number' && update.total > 0
              ? Math.min(100, Math.round((update.completed / update.total) * 100))
              : -1;
          onProgress(pct, update.status);
        }
      } catch {
        // Ignore malformed chunks; the pull may still succeed.
      }
    }
  }
  ensuredModels.add(model);
}

/**
 * Public entry point. Handles model resolution, tool-schema attachment,
 * and keep-alive selection. Returns the assistant content + any requested
 * tool calls. Never throws for expected offline states — surfaces them via
 * the `content` field so the sidepanel can show a normal chat bubble.
 */
export async function orionChat(opts: OrionChatOptions): Promise<OrionChatResponse> {
  const start = Date.now();
  const model = opts.tier === 'agent' ? ORION_AGENT_MODEL : ORION_CHAT_MODEL;
  agentTrace('orionChat start', { tier: opts.tier, model });

  // Agent calls coordinate with the one-shot background warm-up so the model
  // is loaded before we begin. A failed or stale warm-up is ignored so the
  // real request can still attempt inference. Deterministic and chat tiers
  // never await the warm-up.
  if (opts.tier === 'agent' && !opts.skipWarmup) {
    const warmup = maybeGetWarmupPromise();
    if (warmup) {
      agentTrace('orionChat awaiting planner warm-up');
      await warmup.catch(() => {});
    }
  }

  const ensured = await ensureModel(model);
  if (!ensured.ready) {
    // The agent model may not be installed yet. Let the caller decide
    // whether to trigger `pullOrionModel` (progress UI) or fall back.
    throw Object.assign(new Error(ensured.error ?? 'model-missing'), {
      code: 'MODEL_MISSING',
      model,
    });
  }

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    stream: false,
    keep_alive: opts.keepAlive ?? (opts.tier === 'agent' ? AGENT_KEEP_ALIVE : undefined),
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
  }
  if (opts.format) {
    body.format = opts.format;
  }
  if (opts.options) {
    body.options = opts.options;
  }
  const think = opts.think ?? (opts.tier === 'agent' ? false : undefined);
  if (think !== undefined) {
    body.think = think;
  }

  const res = await ollamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Ollama /api/chat ${res.status}`);
  }
  const data = await res.json();
  const content = typeof data?.message?.content === 'string' ? data.message.content : '';
  const toolCalls: OrionToolCall[] = Array.isArray(data?.message?.tool_calls)
    ? (data.message.tool_calls as OrionToolCall[])
    : [];
  const total = Date.now() - start;
  agentTrace('orionChat end', { tier: opts.tier, model, total, firstToken: total, contentLength: content.length });
  return { content, toolCalls, raw: data };
}

/**
 * One-shot planner warm-up. Runs a minimal agent /api/chat call in the
 * background so llama3.2:latest is loaded into memory. StrictMode duplicate
 * mount calls are deduplicated by returning the in-flight module promise.
 * The response is never shown to the user.
 */
export function warmOrionAgent(): Promise<WarmupResult> {
  if (agentWarmupPromise) {
    agentTrace('planner warm-up duplicate skipped');
    console.log('[planner-warmup] duplicate attempt, returning existing promise');
    return agentWarmupPromise;
  }

  const thisGen = ++agentWarmupGeneration;
  const start = Date.now();
  agentTrace('planner warm-up start', { generation: thisGen });
  console.log('[planner-warmup] start', { generation: thisGen });

  agentWarmupPromise = (async (): Promise<WarmupResult> => {
    try {
      const callStart = Date.now();
      await orionChat({
        tier: 'agent',
        messages: [{ role: 'user', content: 'ok' }],
        keepAlive: AGENT_KEEP_ALIVE,
        options: { temperature: 0, seed: 42, num_predict: 1 },
        skipWarmup: true,
      });
      const elapsed = Date.now() - callStart;
      if (thisGen !== agentWarmupGeneration) {
        agentTrace('planner warm-up end', { generation: thisGen, elapsed, stale: true });
        console.log('[planner-warmup] stale success ignored', { generation: thisGen, elapsed });
        return { ok: false, elapsed };
      }
      agentTrace('planner warm-up end', { generation: thisGen, elapsed, success: true });
      console.log('[planner-warmup] end', { generation: thisGen, elapsed, success: true });
      return { ok: true, elapsed };
    } catch (e) {
      const elapsed = Date.now() - start;
      const err = e instanceof Error ? e.message : String(e);
      if (thisGen !== agentWarmupGeneration) {
        agentTrace('planner warm-up end', { generation: thisGen, elapsed, stale: true, error: err });
        console.log('[planner-warmup] stale failure ignored', { generation: thisGen, elapsed, error: err });
        return { ok: false, elapsed };
      }
      agentTrace('planner warm-up end', { generation: thisGen, elapsed, success: false, error: err });
      console.log('[planner-warmup] end', { generation: thisGen, elapsed, success: false, error: err });
      return { ok: false, elapsed };
    }
  })();

  return agentWarmupPromise;
}

export async function releaseAgentModel(): Promise<void> {
  try {
    await ollamaFetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ORION_AGENT_MODEL,
        keep_alive: AGENT_KEEP_ALIVE_IDLE,
        prompt: '',
      }),
    });
  } catch {
    // Best-effort — Ollama will unload on its own eventually.
  }
}
