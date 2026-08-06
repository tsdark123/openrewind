/**
 * Node shim for react-dom in the lab runner.
 * Production's tool switch uses flushSync to force synchronous React commit,
 * which is irrelevant in the headless lab runner. We provide a no-op so the
 * real production orchestrator/executor can load without React.
 */

export function flushSync(fn: () => void): void {
  fn();
}
