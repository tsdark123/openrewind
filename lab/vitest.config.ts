import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

const shimDir = import.meta.dirname ?? path.resolve(path.dirname(new URL(import.meta.url).pathname));

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'react-dom': path.resolve(shimDir, 'shims/react-dom.ts'),
      '@tauri-apps/plugin-http': path.resolve(shimDir, 'shims/@tauri-apps/plugin-http.ts'),
    },
  },
});
