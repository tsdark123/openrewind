/**
 * Node shim for @tauri-apps/plugin-http in the lab runner.
 * The production client only uses Tauri fetch when it detects a Tauri
 * runtime; in the Node runner isTauri() is always false, so the standard
 * global fetch is used instead. We export a no-op placeholder so the module
 * resolves.
 */

export function fetch(_url: string, _init?: RequestInit): Promise<Response> {
  throw new Error('Tauri fetch should never be called in the Node lab runner');
}
