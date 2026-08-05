// =============================================================================
// client — Unified Ollama /api/chat wrapper with certified-model resolution.
//
// The active model is resolved by certifiedModels.ts: qwen3:8b by default,
// with optional ORION_AGENT_MODEL (Node/Vitest) or VITE_ORION_AGENT_MODEL
// (browser/Tauri dev) overrides. Overrides must never be silently marked as
// certified unless they are present in the bundled certified-model registry.
//
// Every semantic call uses one shared runtime configuration:
//   - the resolved model tag
//   - num_ctx = the resolved controlledContextSize (4096 for qwen3:8b)
//   - think = the resolved thinking value (false for qwen3:8b)
//   - keep_alive = '10m'
//   - temperature = 0, seed = 42
//
// The client is transport-agnostic: in Tauri it calls the Ollama HTTP endpoint
// directly at 127.0.0.1:11434 through @tauri-apps/plugin-http. In browser dev
// mode the same requests are routed through the Vite proxy at /ollama.
// =============================================================================

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { agentTrace } from './agent/config';
import {
  resolveActiveModel,
  getActiveOrionModelTag,
  getOrionRuntimeOptions,
} from './certifiedModels';

// Backward-compatible re-export of the active model tag.
// All consumers should prefer resolveActiveModel() or getActiveOrionModelTag().
export const ORION_AGENT_MODEL = getActiveOrionModelTag();

export type OrionModelTier = 'chat' | 'agent';

function getEnvOrionChatTimeoutMs(): number {
  const envProcess = (globalThis as typeof globalThis & { process?: { env?: Record<string, string> } }).process;
  const raw = envProcess?.env?.ORION_CHAT_TIMEOUT_MS;
  if (!raw) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

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
// One warm-up call per application session is launched by the central startup
// state. The promise is reset after it settles so a failure does not block
// retry. React StrictMode double-mounts are deduplicated by returning an
// in-flight module promise.

interface WarmupResult {
  ok: boolean;
  elapsed: number;
}

let agentWarmupPromise: Promise<WarmupResult> | null = null;
let agentWarmupGeneration = 0;

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
  /** @deprecated tier no longer selects the model; resolved model is always used. */
  tier: OrionModelTier;
  messages: OrionChatMessage[];
  tools?: Array<Record<string, unknown>>;
  keepAlive?: string;
  format?: 'json' | string;
  options?: {
    temperature?: number;
    seed?: number;
    num_predict?: number;
  };
  /** Optional external abort signal (e.g. a newer user message superseded this one). */
  signal?: AbortSignal;
  /** Optional override for the default model-call timeout in milliseconds. */
  timeout?: number;
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

function ollamaFetchWithTimeout(
  path: string,
  init: RequestInit,
  ms: number,
  reason: string,
  externalSignal?: AbortSignal
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (externalHandler && externalSignal) {
        externalSignal.removeEventListener('abort', externalHandler);
      }
    };

    if (externalSignal?.aborted) {
      reject(Object.assign(new Error('Orion cancelled the request because a new one started.'), { code: 'ABORTED' }));
      return;
    }

    let externalHandler: (() => void) | undefined;
    if (externalSignal) {
      externalHandler = () => {
        try { controller.abort(); } catch { /* ignore */ }
        cleanup();
        reject(Object.assign(new Error('Orion cancelled the request because a new one started.'), { code: 'ABORTED' }));
      };
      externalSignal.addEventListener('abort', externalHandler, { once: true });
    }

    const timeoutId = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
      cleanup();
      reject(Object.assign(new Error(reason), { code: 'TIMEOUT' }));
    }, ms);

    ollamaFetch(path, { ...init, signal: controller.signal }).then(
      (r) => { cleanup(); resolve(r); },
      (e) => { cleanup(); reject(e); }
    );
  });
}

/**
 * Runtime reachability. Lightweight: hits /api/tags with a short timeout.
 * Used by the startup state to decide whether the Ollama runtime is up before
 * checking for the selected model.
 */
const OLLAMA_RUNTIME_TIMEOUT = 3000;
const OLLAMA_CHECK_TIMEOUT = 5000;

const ensuredModels = new Set<string>();

export async function checkOllamaReachable(): Promise<boolean> {
  try {
    const res = await ollamaFetchWithTimeout(
      '/api/tags',
      { method: 'GET' },
      OLLAMA_RUNTIME_TIMEOUT,
      'Ollama is not responding'
    );
    return res.ok;
  } catch {
    return false;
  }
}

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
 * chip.
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
 * Public entry point. Handles model resolution, certified runtime options,
 * keep-alive and timeout. Returns the assistant content + any requested
 * tool calls. Never throws for expected offline states — surfaces them via
 * the `content` field so the sidepanel can show a normal chat bubble.
 */
export async function orionChat(opts: OrionChatOptions): Promise<OrionChatResponse> {
  const start = Date.now();
  const defaultTimeout = getEnvOrionChatTimeoutMs();
  const model = resolveActiveModel();
  agentTrace('orionChat start', { tier: opts.tier, model: model.ollamaTag, timeout: opts.timeout ?? defaultTimeout });

  if (opts.signal?.aborted) {
    throw Object.assign(new Error('Orion cancelled the request because a new one started.'), { code: 'ABORTED' });
  }

  const ensured = await ensureModel(model.ollamaTag);
  if (!ensured.ready) {
    throw Object.assign(new Error(ensured.error ?? 'model-missing'), {
      code: 'MODEL_MISSING',
      model: model.ollamaTag,
    });
  }

  const runtime = getOrionRuntimeOptions();

  const body: Record<string, unknown> = {
    model: model.ollamaTag,
    messages: opts.messages,
    stream: false,
    keep_alive: opts.keepAlive ?? model.keepAlive,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
  }
  if (opts.format) {
    body.format = opts.format;
  }

  const options: Record<string, unknown> = {
    num_ctx: runtime.num_ctx,
    temperature: opts.options?.temperature ?? runtime.temperature,
    seed: opts.options?.seed ?? runtime.seed,
  };
  if (opts.options?.num_predict !== undefined) {
    options.num_predict = opts.options.num_predict;
  }
  body.options = options;

  if (typeof model.thinking === 'boolean') {
    body.think = model.thinking;
  }

  const timeout = opts.timeout ?? defaultTimeout;
  const res = await ollamaFetchWithTimeout(
    '/api/chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeout,
    'The local model did not respond in time.',
    opts.signal
  );
  if (!res.ok) {
    throw new Error(`Ollama /api/chat ${res.status}`);
  }
  const data = await res.json();
  const content = typeof data?.message?.content === 'string' ? data.message.content : '';
  const toolCalls: OrionToolCall[] = Array.isArray(data?.message?.tool_calls)
    ? (data.message.tool_calls as OrionToolCall[])
    : [];
  const total = Date.now() - start;
  agentTrace('orionChat end', {
    tier: opts.tier,
    model: model.ollamaTag,
    total,
    firstToken: total,
    contentLength: content.length,
    ollama: {
      total_duration: data?.total_duration,
      load_duration: data?.load_duration,
      prompt_eval_duration: data?.prompt_eval_duration,
      eval_duration: data?.eval_duration,
      prompt_eval_count: data?.prompt_eval_count,
      eval_count: data?.eval_count,
    },
  });
  return { content, toolCalls, raw: data };
}

/**
 * One-shot planner warm-up. Runs a minimal /api/chat call with the resolved
 * active model so it is loaded into memory. StrictMode duplicate mounts are
 * deduplicated by returning the in-flight module promise. The promise is
 * reset after it settles so a failed warm-up does not permanently prevent
 * retry. The response is never shown to the user.
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

  const promise = (async (): Promise<WarmupResult> => {
    try {
      const callStart = Date.now();
      const runtime = getOrionRuntimeOptions();
      await orionChat({
        tier: 'agent',
        messages: [{ role: 'user', content: 'ok' }],
        keepAlive: runtime.keep_alive,
        options: { num_predict: 1, temperature: 0, seed: 42 },
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

  agentWarmupPromise = promise;
  // Reset after settling so the central startup state can retry on failure.
  promise.finally(() => {
    agentWarmupPromise = null;
  });

  return agentWarmupPromise;
}

export async function releaseAgentModel(): Promise<void> {
  const model = resolveActiveModel();
  try {
    await ollamaFetchWithTimeout(
      '/api/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.ollamaTag,
          keep_alive: AGENT_KEEP_ALIVE_IDLE,
          prompt: '',
        }),
      },
      5000,
      'Model release timed out'
    );
  } catch {
    // Best-effort — Ollama will unload on its own eventually.
  }
}
