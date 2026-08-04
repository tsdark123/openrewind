import type { OllamaMetrics } from './types';

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaCallOptions {
  model: string;
  messages: OllamaMessage[];
  format?: 'json';
  numCtx?: number;
  numPredict?: number;
  temperature?: number;
  seed?: number;
  think?: boolean;
  keepAlive?: string;
  stream?: boolean;
}

export interface OllamaCallResult {
  rawText: string;
  metrics: OllamaMetrics;
  final: Record<string, unknown>;
}

function buildBody(opts: OllamaCallOptions, stream: boolean) {
  return {
    model: opts.model,
    messages: opts.messages,
    stream,
    ...(opts.format ? { format: opts.format } : {}),
    ...(opts.think !== undefined ? { think: opts.think } : {}),
    options: {
      ...(opts.numCtx !== undefined ? { num_ctx: opts.numCtx } : {}),
      ...(opts.numPredict !== undefined ? { num_predict: opts.numPredict } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    },
    ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}),
  };
}

function parseNdjsonChunk(raw: string): Record<string, unknown>[] {
  const lines = raw.split('\n').filter((l) => l.trim());
  return lines.map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
}

export async function callOllamaStreaming(opts: OllamaCallOptions): Promise<OllamaCallResult> {
  const requestStart = performance.now();
  const body = buildBody(opts, true);

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Ollama HTTP ${res.status}: ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let firstTokenAt = 0;
  let content = '';
  let final: Record<string, unknown> = {};
  let done = false;

  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    if (!value) continue;
    const chunkText = decoder.decode(value, { stream: true });
    const chunks = parseNdjsonChunk(chunkText);
    for (const chunk of chunks) {
      const msg = chunk.message as { content?: string } | undefined;
      const c = msg?.content ?? '';
      if (firstTokenAt === 0 && c.length > 0) {
        firstTokenAt = performance.now();
      }
      content += c;
      if (chunk.done) {
        final = chunk;
      }
    }
  }

  const streamEndAt = performance.now();
  const wallClockTotal = streamEndAt - requestStart;
  const trueTTFT = firstTokenAt ? firstTokenAt - requestStart : wallClockTotal;

  const promptEvalCount = (final.prompt_eval_count as number) ?? 0;
  const evalCount = (final.eval_count as number) ?? 0;
  const evalDuration = (final.eval_duration as number) ?? 0;
  const tokensPerSecond = evalDuration > 0 ? evalCount / (evalDuration / 1e9) : 0;

  const metrics: OllamaMetrics = {
    requestStart,
    firstTokenAt,
    streamEndAt,
    loadDuration: (final.load_duration as number) ?? 0,
    promptEvalDuration: (final.prompt_eval_duration as number) ?? 0,
    evalDuration,
    totalDuration: (final.total_duration as number) ?? 0,
    promptEvalCount,
    evalCount,
    wallClockTotal,
    tokensPerSecond,
    trueTTFT,
  };

  return { rawText: content.trim(), metrics, final };
}

export async function unloadModel(model: string): Promise<void> {
  await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [],
      keep_alive: '0s',
    }),
  });
}
