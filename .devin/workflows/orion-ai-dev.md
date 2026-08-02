---
description: Fast dev loop for Orion AI / Ollama integration
tags: [orion, ai, ollama, dev]
---

# Orion AI Development Workflow

This workflow avoids rebuilding the Tauri installer for every frontend change.

## Quick UI / chart changes (no AI needed)

1. Start the engine backend (`pnpm` in the project root).
2. From `frontend/`, run:
   ```powershell
   pnpm dev
   ```
3. Open `http://localhost:5173` in your browser.
4. Edit React/TS files — Vite hot-reloads in ~1s.

## Desktop / Tauri changes (including Tauri plugins)

1. From `frontend/`, run:
   ```powershell
   pnpm tauri:dev
   ```
2. This launches the Tauri app with Vite dev-server hot-reload.
3. Edit files — both frontend and Rust changes rebuild automatically.

## Testing Orion AI / LLM

Ollama must be installed and the required models must be pulled locally.

1. Install Ollama: <https://ollama.com/download>
2. Open a terminal and pull the chat model:
   ```powershell
   ollama pull llama3.2
   ```
3. Pull the agent model if you want to test autonomous chart tasks:
   ```powershell
   ollama pull llama3.1:8b
   ```
4. Run the app with `pnpm dev` or `pnpm tauri:dev`.
5. Press the Orion (Bot) icon in the toolbar to open the terminal and boot the chat model.

## When you DO need to rebuild the installer

Only run this for the final `.exe` installer:

```powershell
pnpm tauri:build
```

This bundles the frontend and Tauri runtime into a self-contained installer. It is slow and only needed for distribution, not for day-to-day development.

## Common issues

- **Boot overlay stays on “Checking llama3.2…”** → Ollama is not reachable. Ensure the Ollama tray app is running.
- **“Ollama is not responding” after a few seconds** → The app can’t reach `http://localhost:11434`. Start Ollama and retry.
