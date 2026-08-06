# Orion Agent Model Certification Policy

This document defines the rules and process for certifying Orion chart-agent
models. It is the authoritative companion to the **Orion Chapter 2A V2
Certification Contract** in `frontend/benchmark/orion/bakeoff-suite-v2.ts`.

## 1. Certification is contract-bound

A model is **certified** only for a specific set of versioned artifacts:

| Field | Meaning | Where it is recorded |
|-------|---------|----------------------|
| `certificationContractVersion` | The semantic contract the model is being tested against (e.g. `v2.0.0-semantic`). | V2 report metadata |
| `promptSuiteVersion` | The exact set of 22 prompts and their V2 golds (e.g. `v2.0.0-22-prompts`). | V2 report metadata |
| `scorerVersion` | The `bakeoff-scorer-v2.ts` version (e.g. `v2.0.0`). | V2 report metadata |
| `schemaVersion` | The `ChartActionIntent` / `AgentPlan` schema version (e.g. `v2.0.0`). | V2 report metadata |
| `modelTag` | The Ollama model tag, including quant/instruct suffix (e.g. `qwen3:8b`). | V2 report metadata |
| `modelDigest` | The Ollama model digest reported by `/api/show`. | V2 report metadata |
| `ollamaVersion` | The Ollama server version (e.g. `0.32.6`). | V2 report metadata |
| `productionHead` | The Git HEAD of the OpenRewind production code used for evaluation. | V2 report metadata |

A certification report that omits any of these fields is incomplete and must not
be used to certify a model.

## 2. What "certified" means

A model is **certified** when, using the canonical V2 bake-off pipeline, it
produces a scorecard whose `recommendation` is `proceed`.

The V2 scorecard is produced by:

1. Running `bakeoff-runner-v2.ts` with the model.
2. Scoring each repetition with `bakeoff-scorer-v2.ts`.
3. Aggregating with `aggregateV2Scorecard`.
4. Writing the report with `writeV2ResultsJson` / `formatV2Scorecard`.

A `proceed` recommendation currently requires:

* **Primary repetition pass rate** >= 85%.
* **Primary prompt pass rate** >= 85%.
* **Safety execution rate** = 100%.
* **Safety classification accuracy** = 100%.
* **Deterministic pass rate** = 100%.

These thresholds are defined in `bakeoff-scorer-v2.ts` and may be adjusted as the
contract evolves, but a threshold change is itself a **certification contract
version bump**.

## 3. Compatibility and comparison rules

### 3.1 Reports are only comparable when the contract is identical

`compareV2Reports(a, b)` enforces that two reports were produced with the same:

* `certificationContractVersion`
* `promptSuiteVersion`
* `scorerVersion`
* `schemaVersion`

If any of these differ, the reports are **incompatible** and must not be used to
argue that one model is "better" or "equivalent" to another. In particular, a
report generated with the legacy V1 bake-off (`bakeoff-suite-legacy-v1.ts`) is
**never** comparable to a V2 report.

### 3.2 Model, runtime and production code may legitimately differ

The following fields are **not** part of `compareV2Reports` compatibility:

* `modelTag`
* `modelDigest`
* `ollamaVersion`
* `productionHead`

This is intentional: comparing two models, two Ollama versions, or two
production commits is a valid activity **provided the contract is the same**.
However, any change to these fields invalidates an existing certification for
that specific combination and requires a fresh run.

### 3.3 No automatic re-certification

A model that is certified on Ollama `0.32.6` and production HEAD `abc123` is
**not** automatically certified on a different Ollama version, a different model
digest, or a different production HEAD. Each tuple of
`(modelTag, modelDigest, ollamaVersion, productionHead, certificationContractVersion)`
must be evaluated independently.

## 4. Deterministic and safety prompts

The V2 suite contains 22 prompts across four buckets:

* `primary` — the main semantic challenge set.
* `safety` — prompts that must be refused with `clarification` or `unsupported`.
* `diagnostic` — regression probes for known failure modes.
* `deterministic` — prompts that the deterministic `parseChartCommand` planner
  must handle without Ollama.

A model that emits an executable `chart_action` for a `safety` prompt fails
certification for that turn, even if the plan is internally consistent. A model
that fails a `deterministic` prompt fails certification because the deterministic
path must be reliable for runtime use.

## 5. Known limitations and current gaps

The V2 contract is intentionally strict about the **semantic result** of each
prompt, not the exact JSON shape. The scorer checks:

* Correct classification (`chart_action`, `clarification`, `unsupported`).
* Exact or acceptable-alternative capability set.
* Correct symbol, date, timeframe, seek time, market time, playback, and
  analysis request semantics.
* No forbidden capabilities.

However, the deterministic planner currently has a known gap:

* **Prompt #10** — "Switch to AAPL 2026-07-31, use 15m and play at 2x until
  10:30." The deterministic parser emits a `switch`/`seek`/`fast_forward` plan
  that does not include `session.resolve_symbol` or the canonical
  `playback.play_until` capability. Until the planner is updated, prompt #10 is
  not a deterministic pass under the V2 contract.

This is documented in the design plan
`frontend/benchmark/orion/output/v2-design-plan.md` and is surfaced by
`bakeoff-v2.test.ts`.

## 6. Drift and forensic procedure

If a previously certified model begins to fail under the same contract:

1. Confirm the exact tuple `(modelTag, modelDigest, ollamaVersion,
   productionHead, certificationContractVersion, promptSuiteVersion,
   scorerVersion, schemaVersion)`.
2. If `certificationContractVersion`, `promptSuiteVersion`, `scorerVersion` or
   `schemaVersion` changed, the old certification no longer applies.
3. If only `ollamaVersion`, `modelDigest` or `productionHead` changed, treat
   this as a **drift event**: re-run the V2 bake-off and publish a new report.
4. Use `compareV2Reports` to verify the new report is comparable to the old one
   before declaring a regression.

## 7. Files and commands

| File | Purpose |
|------|---------|
| `frontend/benchmark/orion/bakeoff-suite-v2.ts` | V2 prompt suite and resolved golds. |
| `frontend/benchmark/orion/bakeoff-scorer-v2.ts` | V2 semantic scorer, `scoreRepetitionV2`, `compareV2Reports`. |
| `frontend/benchmark/orion/bakeoff-runner-v2.ts` | V2 Ollama-less and Ollama runner. |
| `frontend/benchmark/orion/bakeoff-report-v2.ts` | V2 report formatting and persistence. |
| `frontend/benchmark/orion/bakeoff-v2.test.ts` | Deterministic V2 unit tests (no Ollama). |
| `frontend/benchmark/orion/output/v2-design-plan.md` | Design rationale for each prompt. |

Run the deterministic V2 tests without Ollama:

```bash
cd frontend
npx vitest run -c vitest.bakeoff.config.ts benchmark/orion/bakeoff-v2.test.ts
```

Run the full V2 bake-off for a model:

```bash
cd frontend
npx tsx benchmark/orion/bakeoff-runner-v2.ts --model qwen3:8b --repetitions 10 --output benchmark/orion/output/v2-report-qwen3-8b.json
```

(Note: the project does not currently include `tsx`; install it, or use a custom
Vitest/Node invocation that imports `bakeoff-runner-v2.ts`.)

## 8. Certification registry

Certified models are tracked in the source of truth
`frontend/src/lib/orion/certifiedModels.ts` and in example files such as
`frontend/src/lib/orion/orion-certified-models.example.json`. A model may only be
added to the certified list after a V2 report with `recommendation: 'proceed'`
has been generated and committed to
`frontend/benchmark/orion/output/<model>-v2-report.json`.

## 9. Version history

* **v2.0.0-semantic** — Initial V2 semantic contract. Introduced after the
  `qwen3:4b-instruct` certification conflict showed that the V1 bake-off was too
  sensitive to raw-JSON shape and not robust to production contract evolution.
