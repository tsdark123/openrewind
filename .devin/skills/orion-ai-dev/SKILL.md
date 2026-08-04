---
name: orion-ai-dev
description: Fast dev loop and durable development guidance for the Orion AI / Ollama assistant
---

# Orion AI Development Skill

Use this skill when modifying Orion's AI runtime, semantic-intent pipeline, planner, capability registry, or chat integration.

## Quick browser / UI changes (no AI needed)

1. Start the engine and Vite dev server together from the repository root:
   ```powershell
   pnpm dev:full
   ```
2. Open `http://localhost:5173` in your browser.
3. Edit React/TS files in `frontend/src/` — Vite hot-reloads in ~1 s.

For a frontend-only server when the engine is already running:

```powershell
cd frontend
pnpm dev
```

## Desktop / Tauri changes

From `frontend/` run:

```powershell
pnpm tauri:dev
```

This launches the Tauri app with Vite dev-server hot-reload. Both frontend and Rust changes rebuild automatically.

## Building the installer

Only run this for the final `.exe` installer:

```powershell
pnpm tauri:build
```

It is slow and only needed for distribution, not for day-to-day development.

## Required Ollama models

Both the chat tier and the agent/planner now use the same model:

```powershell
ollama pull llama3.2
```

`orionChat` warms `llama3.2:latest` in the background on app boot. You do not need to manually pull a separate agent model.

## Testing

Run the unit suite before any AI change:

```powershell
cd frontend
npx tsc --noEmit
node node_modules/vitest/vitest.mjs run
```

For the LLM-backed acceptance suite (requires a running Ollama and engine):

```powershell
cd frontend
node node_modules/vitest/vitest.mjs run -c vitest.acceptance.config.ts
```

Stop for a manual browser test on fresh UI changes; do not rely only on unit tests.

## Durable Orion development principles

- Inspect the repository before editing. Read `capabilities.ts`, `orchestrator.ts`, `client.ts`, and `planner.ts` when changing behavior.
- Preserve one capability registry and one executor. Do not create parallel execution paths.
- Deterministic chart commands (`switch`, `play`, `pause`, `set_timeframe`, `seek`, etc.) remain LLM-free.
- Semantic or compound requests use compact intent extraction (`extractSemanticIntent`) and are compiled into an `AgentPlan`.
- Every compiled `AgentPlan` must pass `validateAgentPlan` before execution.
- Final answers to the user come from execution receipts and `WorldState`, not raw model text.
- Do not claim success without runtime confirmation from the engine/session state.
- Do not commit or push without explicit user approval.
- Do not reintroduce streaming, `llama3.1:8b`, or giant timeouts.
- Keep tests focused; one warm-up per app session is enough.
- Requested action dimensions are computed centrally and reused across routing, deterministic completeness, semantic extraction and grounding.
- Grounded deterministic values are authoritative.
- Resolved context values come next.
- The LLM may fill only genuinely missing dimensions and must not overwrite deterministic symbol, date, time, timeframe, relative seek or playback values.
- Unrequested, ungrounded and malformed optional LLM fields are stripped before strict semantic validation.
- Requested malformed fields must still be rejected.
- Complete commands must remain deterministic and avoid unnecessary LLM calls.
- Do not add phrase-specific routing lists or ticker-specific branches.
- All execution must continue through the existing capability registry, compiler, validator, executor, receipts and refreshed WorldState.

## Common issues

- **Boot overlay stays on “Checking llama3.2…”** → Ollama is not reachable. Ensure the Ollama tray app is running and `http://localhost:11434` is reachable.
- **“Ollama is not responding” after a few seconds** → The app can’t reach `http://localhost:11434`. Start Ollama and retry.
- **First agent request is slow after an Ollama restart** → The planner warm-up is non-blocking but the first real agent call may still wait for the model to load. This is expected once per cold Ollama session.
- **Acceptance tests fail with route `unrecognized` on an unsupported request** → Unsupported intents must return `route: 'unsupported'`. Update the test, not the orchestrator.
