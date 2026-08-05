// =============================================================================
// startupState — authoritative Orion startup and readiness store.
//
// This is the single place the app decides:
//   - whether a local Ollama runtime is present
//   - whether the selected certified model is present
//   - whether to download Ollama (Tauri) or pull qwen3:8b
//   - whether the model has been genuinely warmed up
//   - when to fall back to deterministic-only mode
//
// App.tsx starts the machine once on mount. The Orion terminal and chat
// panels subscribe to it and do not run their own ensureModel/pull/warm flows.
//
// State machine:
//   idle
//     -> checking_runtime
//
//   checking_runtime
//     -> checking_model            Ollama reachable
//     -> runtime_missing           Ollama not reachable
//
//   runtime_missing
//     -> checking_model            Tauri started/repaired Ollama
//     -> download_failed           install/download failed
//     -> deterministic_only        user chose to continue without Ollama
//
//   checking_model
//     -> warming_model             model present
//     -> model_missing             model not present
//     -> warmup_failed             ensureModel errored (timeout etc.)
//
//   model_missing
//     -> pulling_model             user consented to download
//     -> deterministic_only        user chose not to download
//
//   pulling_model
//     -> warming_model             pull succeeded
//     -> download_failed           pull failed
//
//   warming_model
//     -> ready                     warm-up chat call succeeded
//     -> warmup_failed             chat call failed or timed out
//
//   ready
//     -> checking_runtime          revalidate() called
//
//   warmup_failed / download_failed
//     -> checking_runtime          retry() called
//     -> deterministic_only        user chose to continue
//
//   deterministic_only
//     -> checking_runtime          retry() called
// =============================================================================

import { useSyncExternalStore } from 'react';
import {
  resolveActiveModel,
  getActiveOrionModelTag,
  type ResolvedModel,
} from './certifiedModels';
import {
  checkOllamaReachable,
  ensureModel,
  pullOrionModel,
  warmOrionAgent,
  isTauri,
} from './client';

export type OrionStartupStage =
  | 'idle'
  | 'checking_runtime'
  | 'runtime_missing'
  | 'checking_model'
  | 'model_missing'
  | 'pulling_model'
  | 'warming_model'
  | 'ready'
  | 'warmup_failed'
  | 'download_failed'
  | 'deterministic_only';

export interface OrionStartupState {
  stage: OrionStartupStage;
  model: ResolvedModel;
  activeModelName: string;
  progress: number;
  status: string;
  error?: string;
  canRetry: boolean;
  canContinueDeterministic: boolean;
  canPull: boolean;
  canInstallOllama: boolean;
}

const listeners = new Set<() => void>();

let currentState: OrionStartupState = {
  stage: 'idle',
  model: resolveActiveModel(),
  activeModelName: getActiveOrionModelTag(),
  progress: -1,
  status: '',
  canRetry: false,
  canContinueDeterministic: false,
  canPull: false,
  canInstallOllama: false,
};

let inProgress = false;
let currentGeneration = 0;

function tauriApi(): { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>; listen?: (event: string, handler: (event: { payload: unknown }) => void) => () => void } | null {
  if (typeof window === 'undefined') return null;
  const win = window as any;
  const core = win.__TAURI__?.core ?? win.__TAURI_INTERNALS__;
  const event = win.__TAURI__?.event;
  if (typeof core?.invoke !== 'function') return null;
  return { invoke: core.invoke, listen: typeof event?.listen === 'function' ? event.listen : undefined };
}

function setState(patch: Partial<OrionStartupState>) {
  currentState = { ...currentState, ...patch };
  for (const l of listeners) l();
}

function getState(): OrionStartupState {
  return currentState;
}

function computeActions(stage: OrionStartupStage) {
  return {
    canRetry:
      stage === 'runtime_missing' ||
      stage === 'model_missing' ||
      stage === 'warmup_failed' ||
      stage === 'download_failed' ||
      stage === 'deterministic_only',
    canContinueDeterministic:
      stage === 'runtime_missing' ||
      stage === 'model_missing' ||
      stage === 'warmup_failed' ||
      stage === 'download_failed',
    canPull: stage === 'model_missing',
    canInstallOllama: stage === 'runtime_missing' && isTauri(),
  };
}

function transition(stage: OrionStartupStage, status: string, extra?: Partial<OrionStartupState>) {
  const actions = computeActions(stage);
  setState({
    stage,
    status,
    progress: -1,
    error: undefined,
    ...actions,
    ...extra,
  });
}

async function ensureOllamaRunningTauri(): Promise<boolean> {
  const api = tauriApi();
  if (!api) return false;
  try {
    const result = await api.invoke('ensure_ollama_running') as 'RUNNING' | 'STARTED' | 'OLLAMA_MISSING';
    return result === 'RUNNING' || result === 'STARTED';
  } catch {
    return false;
  }
}

async function installOllamaTauri(onProgress: (percent: number, status: string) => void, signal: { aborted: boolean }): Promise<void> {
  const api = tauriApi();
  if (!api) throw new Error('Tauri is not available');

  let unsubscribe: (() => void) | undefined;

  return new Promise((resolve, reject) => {
    const start = async () => {
      try {
        if (api.listen) {
          const eventName = 'ollama-download-progress';
          unsubscribe = api.listen(eventName, (event) => {
            const payload = event.payload as { percent?: number; stage?: string; message?: string } | undefined;
            if (payload && typeof payload.percent === 'number') {
              const text = payload.message || payload.stage || 'downloading';
              onProgress(payload.percent, text);
            }
          });
        }

        await api.invoke('download_ollama');
        if (signal.aborted) return;
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        if (unsubscribe) unsubscribe();
      }
    };
    start();
  });
}

async function checkOllamaRuntime(): Promise<boolean> {
  // Check the runtime first with a lightweight /api/tags call. This keeps
  // runtime reachability separate from model presence so the state machine
  // can cleanly distinguish "Ollama not running" from "model not installed".
  return checkOllamaReachable();
}

async function runStartup(thisGeneration: number) {
  transition('checking_runtime', 'Checking for a local Ollama runtime...');

  let reachable = false;
  try {
    reachable = await checkOllamaRuntime();
  } catch {
    reachable = false;
  }

  if (thisGeneration !== currentGeneration) return;

  if (!reachable) {
    if (isTauri()) {
      reachable = await ensureOllamaRunningTauri();
      if (thisGeneration !== currentGeneration) return;
    }

    if (!reachable) {
      transition('runtime_missing', 'Ollama runtime is not available.');
      return;
    }
  }

  transition('checking_model', `Checking for ${getActiveOrionModelTag()}...`);

  let modelReady = false;
  try {
    const result = await ensureModel(getActiveOrionModelTag());
    modelReady = result.ready;
    if (!modelReady) {
      const error = result.error ?? 'model-missing';
      if (error === 'model-missing') {
        transition('model_missing', `${getActiveOrionModelTag()} is not installed.`);
        return;
      }
      transition('warmup_failed', `Could not verify the model: ${error}`);
      return;
    }
  } catch (e) {
    transition('warmup_failed', e instanceof Error ? e.message : String(e));
    return;
  }

  if (thisGeneration !== currentGeneration) return;

  transition('warming_model', `Warming ${getActiveOrionModelTag()}...`);

  try {
    const warm = await warmOrionAgent();
    if (thisGeneration !== currentGeneration) return;
    if (warm.ok) {
      transition('ready', `${getActiveOrionModelTag()} is ready.`);
    } else {
      transition('warmup_failed', 'The model did not warm up successfully.');
    }
  } catch (e) {
    if (thisGeneration !== currentGeneration) return;
    transition('warmup_failed', e instanceof Error ? e.message : String(e));
  }
}

export function startOrionStartup() {
  if (inProgress) return;
  inProgress = true;
  currentGeneration++;
  const thisGeneration = currentGeneration;

  runStartup(thisGeneration).finally(() => {
    if (thisGeneration === currentGeneration) {
      inProgress = false;
    }
  });
}

export function retryOrionStartup() {
  if (inProgress) {
    // Cancel the current attempt so a retry can start a fresh generation.
    currentGeneration++;
    inProgress = false;
  }
  startOrionStartup();
}

export function revalidateOrionStartup() {
  if (currentState.stage === 'ready') {
    currentGeneration++;
    startOrionStartup();
  } else if (!inProgress) {
    startOrionStartup();
  }
}

export function continueDeterministicOrion() {
  transition('deterministic_only', 'Continuing without semantic Orion. Chart commands still work.');
}

export async function pullSelectedModelWithConsent() {
  const stage = getState().stage;
  if (stage !== 'model_missing') return;

  transition('pulling_model', `Downloading ${getActiveOrionModelTag()}... This is a large local download.`, { progress: 0 });

  try {
    await pullOrionModel(getActiveOrionModelTag(), (percent, status) => {
      const text = percent >= 0
        ? `Downloading ${getActiveOrionModelTag()}... ${percent}% (${status})`
        : `Downloading ${getActiveOrionModelTag()}... (${status})`;
      setState({ progress: percent, status: text });
    });

    transition('warming_model', `Warming ${getActiveOrionModelTag()}...`);
    const warm = await warmOrionAgent();
    if (warm.ok) {
      transition('ready', `${getActiveOrionModelTag()} is ready.`);
    } else {
      transition('warmup_failed', 'The model downloaded but did not warm up.');
    }
  } catch (e) {
    transition('download_failed', e instanceof Error ? e.message : String(e));
  }
}

export async function installOllamaWithConsent() {
  const stage = getState().stage;
  if (stage !== 'runtime_missing' || !isTauri()) return;

  const signal = { aborted: false };
  transition('pulling_model', 'Downloading Ollama... This is a large local download.', { progress: 0 });

  try {
    await installOllamaTauri((percent, status) => {
      const text = percent >= 0
        ? `Installing Ollama... ${percent}% (${status})`
        : `Installing Ollama... (${status})`;
      setState({ progress: percent, status: text });
    }, signal);

    // Try to start the freshly installed runtime.
    const running = await ensureOllamaRunningTauri();
    if (running) {
      // Continue into the model check.
      startOrionStartup();
    } else {
      transition('runtime_missing', 'Ollama was installed but could not be started. Try restarting OpenRewind.');
    }
  } catch (e) {
    transition('download_failed', e instanceof Error ? e.message : String(e));
  }
}

export function cancelOrionStartup() {
  currentGeneration++;
  inProgress = false;
  transition('idle', '', { progress: -1 });
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getOrionStartupState(): OrionStartupState {
  return getState();
}

export function useOrionStartup(): OrionStartupState {
  return useSyncExternalStore(subscribe, getState, getState);
}
