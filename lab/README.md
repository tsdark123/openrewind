# Orion Scenario Lab

A contained, lab-only test harness for OpenRewind's Orion agent. It finds and
permanently regression-locks the semantic, stateful, numerical and
consumer-behavior failures that the existing certification suites missed,
without contaminating production code.

## Scope

All implementation files live under `lab/`. No `frontend/`, `engine/`,
`src-tauri/`, `README.md`, `ARCHITECTURE.md` or root production configuration is
modified.

The lab can import production *types* and `handleOrionMessage` through lab
adapters, but it does not use production analysis implementation as the source
of numerical truth.

## Structure

```
lab/
  README.md
  package.json
  tsconfig.json
  vitest.config.ts
  orchestrator.ps1         # Windows-only orchestrator (not executed in Cloud)
  schemas/                 # Generated JSON schemas
  reference/               # Independent calculator and fixture data
  runner/                  # Scenario runner, oracles, adapters
  scenarios/regression/    # Five regression seeds
  scenarios/smoke/         # Five smoke scenarios
  holdout/                 # Triage and permanent holdout directories
  inbox/                   # Gitignored run inputs
  outbox/                  # Gitignored run artifacts
  data/                    # Gitignored local data
  tests/                   # Vitest suite
```

## Commands

```bash
cd lab
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run generate:fixture          # regenerate synthetic fixture
npm run fixture:run               # run smoke scenarios in fixture mode
```

The `fixture:run` command writes `outbox/fixture-run/events.jsonl`,
`summary.json` and `report.md`. These artifacts are explicitly marked as
fixture-mode lab validation, not real Orion certification.

## Design

### Independent numerical truth

`reference/calculator.ts` recomputes OHLC, change, volume, candle shape,
window compare and whole-session summary from raw candles. It does not import
`frontend/src/lib/orion/agent/analysis.ts`. Production receipts are compared to
the reference, not the other way around.

Half-open time ranges `[fromTime, toTime)` are used for all `time_range`
windows. For 1-minute bars, `09:30–10:30` contains `09:30` through `10:29`.

The committed fixture `reference/fixtures/synthetic-session-1m.json` is fully
synthetic and manually verifiable.

### Semantic oracle hierarchy

For each turn, the runner evaluates:

1. status and safety
2. forbidden side effects
3. exact grounding invariants (symbol/date/timeframe/window/marketTime)
4. minimum required capabilities
5. context inheritance
6. typed receipts
7. independent numerical truth
8. final WorldState
9. consumer-response contract
10. optional exact route/plan assertions

Primary correctness is semantic outcome. `assertExactRoute` and `assertExactPlan`
default to `false`.

### Consumer numeric equivalence

`runner/numeric-equivalence.ts` supports:

- `29,989,052`
- `29.99M`
- `about 30 million`
- `1.71%`
- `approximately 1.7 percent`

Every number in a consumer response must map to a receipt value, an independent
reference value, or a documented derived presentation. Unsupported or
hallucinated numbers are rejected without an LLM judge.

### Adapters

- `AgentAdapter` abstracts the Orion agent.
- `EngineAdapter` abstracts candle fetching.
- `FixtureAgentAdapter` replays explicit fixture responses for dry-run mode.
- `ProductionAgentAdapter` is a skeleton that accepts injected production
  functions at runtime; a full Windows headless harness is left as a later step.

### Windows orchestrator

`orchestrator.ps1` verifies Ollama `qwen3:8b`, starts the engine on an isolated
port via `OPENREWIND_PORT` and `OPENREWIND_DATA_DIR` (verified from
`engine/src/main.cpp`), and invokes the runner. It does not start, stop or
unload Ollama in V1. `ReleaseModelAfterRun` defaults to `false`.

## Status

V1 contains the schema, independent reference truth, semantic oracles,
JSONL runner, fixture/dry-run mode, five regression seeds and five smoke
scenarios. Real Windows-local execution with `qwen3:8b` and the engine is the
next step after review.
