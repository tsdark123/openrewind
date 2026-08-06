import { describe, it, expect } from 'vitest';

describe('tsx-style production loading', () => {
  it('can load the production orchestrator through a tsx-compatible import', async () => {
    const { handleOrionMessage } = await import(
      new URL(
        '../../frontend/src/lib/orion/agent/orchestrator.ts',
        import.meta.url,
      ).href
    );
    expect(typeof handleOrionMessage).toBe('function');
  });
});
