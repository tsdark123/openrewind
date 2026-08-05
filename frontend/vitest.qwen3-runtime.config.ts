import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/lib/orion/agent/__acceptance__/qwen3-analysis-runtime.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    env: {
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      ORION_AGENT_MODEL: 'qwen3:8b',
      ORION_CHAT_TIMEOUT_MS: '120000',
    },
  },
});
