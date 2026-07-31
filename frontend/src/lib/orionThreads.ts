// =============================================================================
// orionThreads — Per-symbol/date threaded chat history for Orion.
//
// Motivation:
//   Orion previously kept a single flat message array in component state.
//   That caused cross-symbol answers to bleed together because the system
//   prompt was rebuilt from the CURRENT symbol/date on every send, while
//   the chat history still referenced the prior symbol. Splitting chat
//   history per session key (symbol + date) — with a dedicated `global`
//   thread for cross-symbol questions — eliminates that ambiguity and
//   gives Orion a stable, scoped memory per replay context.
//
// Storage layout (`app_data_dir/data/orion_threads.json`):
//   {
//     "session:AAPL:2026-07-13": { "messages": [...], "updatedAt": 1732... },
//     "session:TSLA:2026-06-04": { "messages": [...], "updatedAt": 1732... },
//     "global":                  { "messages": [...], "updatedAt": 1732... }
//   }
//
// In browser dev mode (no Tauri) we fall back to localStorage under
// `openrewind:orion_threads`. This mirrors the journal.ts strategy so the
// UI behaves identically in `pnpm frontend:dev`.
// =============================================================================

export interface ChatMessage {
  sender: 'ai' | 'user';
  text: string;
}

export interface OrionThread {
  messages: ChatMessage[];
  updatedAt: number;
}

export type OrionThreads = Record<string, OrionThread>;

export const GLOBAL_THREAD_KEY = 'global';

const STORAGE_KEY = 'openrewind:orion_threads';

function isTauri(): boolean {
  const win = typeof window !== 'undefined' ? window as any : undefined;
  const tauri = win?.__TAURI__?.core ?? win?.__TAURI_INTERNALS__;
  return typeof tauri?.invoke === 'function';
}

function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const win = window as any;
  const tauri = win.__TAURI__?.core ?? win.__TAURI_INTERNALS__;
  if (typeof tauri?.invoke !== 'function') throw new Error('Tauri runtime not available');
  return tauri.invoke(cmd, args);
}

// -----------------------------------------------------------------------------
// Thread key helpers
// -----------------------------------------------------------------------------

/**
 * Canonical thread key for the currently-loaded replay context.
 *
 * When a session is active for a specific symbol+date, that pair owns its
 * own thread so Orion's memory stays scoped. When there is no active session
 * we route to the `global` thread — that's also the correct place for
 * cross-symbol/portfolio questions the user pins manually.
 */
export function threadKeyForContext(symbol: string, date: string, sessionActive: boolean): string {
  if (sessionActive && symbol && date) {
    return `session:${symbol}:${date}`;
  }
  return GLOBAL_THREAD_KEY;
}

/** Human-readable label for the thread breadcrumb UI. */
export function threadLabel(key: string): string {
  if (key === GLOBAL_THREAD_KEY) return 'Global';
  const parts = key.split(':');
  if (parts.length === 3 && parts[0] === 'session') {
    return `${parts[1]} · ${parts[2]}`;
  }
  return key;
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

export async function loadOrionThreads(): Promise<OrionThreads> {
  try {
    if (isTauri()) {
      const raw = (await invoke('read_orion_threads')) as string;
      return JSON.parse(raw || '{}') as OrionThreads;
    }
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return raw ? (JSON.parse(raw) as OrionThreads) : {};
  } catch (e) {
    console.error('[Orion] Failed to load threads:', e);
    return {};
  }
}

export async function writeOrionThreads(threads: OrionThreads): Promise<void> {
  const json = JSON.stringify(threads);
  try {
    if (isTauri()) {
      await invoke('write_orion_threads', { contents: json });
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, json);
    }
  } catch (e) {
    console.error('[Orion] Failed to write threads:', e);
  }
}

// -----------------------------------------------------------------------------
// Immutable helpers used by the sidepanel
// -----------------------------------------------------------------------------

/** Return messages for `key`, seeding with the default AI greeting if empty. */
export function getThreadMessages(threads: OrionThreads, key: string): ChatMessage[] {
  const t = threads[key];
  if (t && t.messages.length > 0) return t.messages;
  return [DEFAULT_GREETING];
}

/** Append a message to `key` and return a new threads object. */
export function appendMessage(threads: OrionThreads, key: string, message: ChatMessage): OrionThreads {
  const existing = threads[key]?.messages ?? [DEFAULT_GREETING];
  return {
    ...threads,
    [key]: {
      messages: [...existing, message],
      updatedAt: Date.now(),
    },
  };
}

/** Overwrite messages for `key`. Used by the chat send flow after a full turn. */
export function setThreadMessages(threads: OrionThreads, key: string, messages: ChatMessage[]): OrionThreads {
  return {
    ...threads,
    [key]: {
      messages,
      updatedAt: Date.now(),
    },
  };
}

export const DEFAULT_GREETING: ChatMessage = {
  sender: 'ai',
  text: 'Systems online. I am Orion, your private risk supervisor. Ask me anything about your execution footprint.',
};
