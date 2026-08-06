import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['benchmark/orion/bakeoff-v2.test.ts'],
  },
});
