# Orion Model Bake-off Handoff

## Project context

- **Current branch:** `agent-interface-v1`
- **Current approved code commit:** `13a2b02b04e6dd38c812b00956ab5a9c31779ae5`
- **Phase 5 status:** complete pending combined `pnpm dev:full` smoke verification
- **Next task goal:** benchmark local models before Phase 6
- **Phase 6 constraint:** do not begin Phase 6 chart-analysis implementation during the bake-off

## Current verification status

- **Unit tests:** 209 passing across 18 test files
- **TypeScript:** `npx tsc --noEmit` passing
- **Vite production build:** `npm run build` passing
- **Ollama model in use:** `llama3.2:latest`
- **Hardware:** Intel i9-12900K, RTX 3070 Ti; Ollama confirmed 100% GPU

## Local services

| Service | Endpoint | Notes |
|---|---|---|
| Engine | `127.0.0.1:9000` | start separately or with `pnpm dev:full` |
| Ollama | `127.0.0.1:11434` | must be running and reachable |
| Vite dev | `http://localhost:5173` | started by `pnpm dev:full` or `cd frontend && pnpm dev` |

## Normal development command

Run the engine and Vite together from the repository root:

```powershell
pnpm dev:full
```

For frontend-only work when the engine is already running:

```powershell
cd frontend
pnpm dev
```

## Bake-off goal

Evaluate local models for the Orion semantic-intent pipeline. Use the findings to pick the best intelligence/latency/reliability tradeoff for the production default, not simply the largest available model.

## Benchmark dimensions

Record each model across the following dimensions:

1. Semantic intent correctness
2. Structured-output validity
3. Hallucinated optional fields
4. Context-reference accuracy
5. Clarification behavior
6. First-token latency
7. Total latency
8. VRAM usage
9. Repeat-run reliability

## Benchmark method

- Use a fixed prompt suite with identical temperature and context settings for every model.
- Preserve raw model outputs and sanitized intents separately so model quality is not confused with application sanitation.
- Test the same commands the deterministic parser cannot fully cover (colloquial times, compound queries, context references) so the benchmark measures real LLM value.

## Architectural notes for the bake-off

- Requested action dimensions are computed centrally and reused across routing, deterministic completeness, semantic extraction and grounding.
- Grounded deterministic values are authoritative.
- Resolved context values come next.
- The LLM may fill only genuinely missing dimensions and must not overwrite deterministic symbol, date, time, timeframe, relative seek or playback values.
- Unrequested, ungrounded and malformed optional LLM fields are stripped before strict semantic validation.
- Requested malformed fields must still be rejected.
- Complete commands must remain deterministic and avoid unnecessary LLM calls.
- Do not add phrase-specific routing lists or ticker-specific branches.
- All execution must continue through the existing capability registry, compiler, validator, executor, receipts and refreshed WorldState.
