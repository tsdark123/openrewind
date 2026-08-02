import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// When running inside a Tauri build the webview loads the compiled dist/
// directly as a file:// URL — no dev server proxy is needed.
// In dev mode (both standalone `pnpm dev` and `tauri dev`) Vite serves on
// :5173 and we proxy REST/WS traffic to the engine running on :9000.
const isTauriBuild = process.env.TAURI_ENV_DEBUG === undefined && process.env.TAURI_FAMILY !== undefined;

export default defineConfig({
  plugins: [react()],
  // Ensure asset paths are relative so the webview can load them as file://
  base: isTauriBuild ? './' : '/',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ollama': {
        target: 'http://127.0.0.1:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, ''),
      },
      '/api': {
        target: 'http://localhost:9000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:9000',
        ws: true,
      },
    },
  },
  build: {
    // Tauri on Windows expects the output in dist/
    outDir: 'dist',
    emptyOutDir: true,
  },
});
