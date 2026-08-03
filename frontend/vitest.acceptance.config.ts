import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/lib/orion/agent/__acceptance__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    env: {
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    },
  },
});
