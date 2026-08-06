import { describe, it, expect } from 'vitest';
import { loadProductionModules } from '../runner/adapters/windows/production-loader';

describe('production module loading', () => {
  it('loads the real production orchestrator, execution context, world state and engine helpers', async () => {
    const m = await loadProductionModules();
    expect(typeof m.handleOrionMessage).toBe('function');
    expect(typeof m.createExecutionContext).toBe('function');
    expect(typeof m.buildWorldState).toBe('function');
    expect(typeof m.engineUrl).toBe('function');
    expect(typeof m.sessionStartBody).toBe('function');
  });
});
