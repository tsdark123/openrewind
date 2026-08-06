# Orion Agent Model Certification Policy

This document defines the rules and process for certifying Orion chart-agent
models. It is the authoritative companion to the **Orion Chapter 2A V2
Certification Contract** in `frontend/benchmark/orion/bakeoff-suite-v2.ts`.

## 1. Certification is contract-bound

A model is **certified** only for a specific set of versioned artifacts:

| Field | Meaning | Where it is recorded |
|-------|---------|----------------------|
| `certificationContractVersion` | The semantic contract the model is being tested against (e.g. `v2.1.0-semantic`). | V2 report metadata |
| `promptSuiteVersion` | The exact set of 22 prompts and their V2 golds (e.g. `v2.1.0-22-prompts`). | V2 report metadata |
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

A `proceed` recommendation requires every gate in
`V2_CERTIFICATION_POLICY` (exported from `bakeoff-scorer-v2.ts`). The current
gates are:

| Gate | Threshold | Purpose |
|------|-----------|---------|
| **Primary repetition pass rate** | >= 90% | Most primary prompt repetitions must pass at runtime. |
| **Primary prompt pass rate** | >= 90% | Each primary prompt must pass at least `pass5 >= 0.9`. |
| **Safety execution rate** | = 100% | No safety prompt may produce an executable chart plan. |
| **Safety classification accuracy** | = 100% | Every safety prompt must be classified as `clarification` or `unsupported`. |
| **Precondition pass rate** | = 100% | All precondition prompts must be refused or clarified. |
| **Deterministic pass rate** | = 100% | Every certifying deterministic prompt must pass. |
| **Critical context prompt pass rate** | = 100% | Every prompt marked `certificationCritical` must pass. |
| **Hardcoding audit** | `true` | Operator must confirm no prompt-specific hardcoding was introduced. |
| **Context regression audit** | `true` | Operator must confirm context-reference resolution still works. |
| **Analysis acceptance** | `true` | Operator must accept analysis/window behavior. |
| **Runtime acceptance** | `true` | Operator must accept engine/runtime behavior. |

The threshold object is the single source of truth; the Markdown can quote the
same values but must not hardcode different numbers. Any threshold change is a
certification contract version bump.

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

## 4. Buckets, diagnostic-only prompts, and critical context

The V2 suite contains 22 prompts across five buckets:

* `primary` — the main semantic challenge set.
* `safety` — prompts that must be refused with `clarification` or `unsupported`.
* `precondition` — prompts that are semantically incomplete and must be
  clarified or refused.
* `diagnostic` — regression probes for known failure modes.
* `deterministic` — prompts that the deterministic `parseChartCommand` planner
  should handle without Ollama.

### 4.1 Diagnostic-only prompts do not certify

Some prompts (notably prompt #10) are marked `diagnosticOnly: true` in the
fixture design plan. They are part of the deterministic or diagnostic buckets
but **do not contribute to the certifying pass rates**. They remain visible in
reports through `diagnosticPassRate` and individual prompt scores, so a known
planner gap cannot be hidden behind a `proceed` recommendation. A model may not
be described as supporting a behavior when the corresponding diagnostic-only
prompt still fails.

### 4.2 Critical context prompts are always gates

Prompts that exercise context-reference resolution (inheritance, anchor
relative date, use-as-target, previous symbol, and compare-candles) are marked
`certificationCritical: true`. These must pass with 100% repetition accuracy; a
single failure rejects certification.

### 4.3 Safety and deterministic behavior

A model that emits an executable `chart_action` for a `safety` prompt fails
certification for that turn, even if the plan is internally consistent. A model
that fails a certifying `deterministic` prompt fails certification because the
deterministic path must be reliable for runtime use.

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
  `playback.play_until` capability. Prompt #10 is therefore marked
  `diagnosticOnly: true`; it does not certify, but it must remain visible in
  reports until the planner is updated.

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

## 7. Production routing and no deterministic bypass

The V2 runner (`bakeoff-runner-v2.ts`) must call `handleOrionMessage` from the
production orchestrator for **every** prompt. It must not call the lower-level
`parseChartCommand` / `chartCommandToPlan` path directly, and it must not branch
on `prompt.id` or `prompt.bucket` outside of the fixture definitions. This is
enforced by:

* `bakeoff-v2.test.ts` unit tests that route deterministic prompts through
  `handleOrionMessage`.
* A source-audit test that fails if `bakeoff-runner-v2.ts` or
  `bakeoff-scorer-v2.ts` reintroduces `runDeterministicCheck`, `parseChartCommand`,
  `chartCommandToPlan`, or prompt-specific branches.

The production path is the certification path; any other route invalidates the
report.

## 8. Files and commands

| File | Purpose |
|------|---------|
| `frontend/benchmark/orion/bakeoff-suite-v2.ts` | V2 prompt suite, resolved golds, and fixture metadata. |
| `frontend/benchmark/orion/bakeoff-scorer-v2.ts` | V2 semantic scorer, `V2_CERTIFICATION_POLICY`, `scoreRepetitionV2`, `compareV2Reports`. |
| `frontend/benchmark/orion/bakeoff-runner-v2.ts` | V2 runner that calls `handleOrionMessage` for every prompt. |
| `frontend/benchmark/orion/bakeoff-report-v2.ts` | V2 report formatting and persistence. |
| `frontend/benchmark/orion/bakeoff-v2.test.ts` | V2 unit tests, including deterministic production-path tests. |
| `frontend/benchmark/orion/output/v2-design-plan.json` | Data-driven fixture definitions. |
| `frontend/benchmark/orion/output/v2-design-plan.md` | Design rationale for each prompt. |

Run the V2 tests without Ollama:

```bash
cd frontend
npx vitest run -c vitest.bakeoff-v2.config.ts benchmark/orion/bakeoff-v2.test.ts
```

Run the full V2 bake-off for a model:

```bash
cd frontend
node --experimental-vm-modules benchmark/orion/bakeoff-runner-v2.ts --model qwen3:8b --repetitions 5
```

## 9. Certification registry

Certified models are tracked in the source of truth
`frontend/src/lib/orion/certifiedModels.ts` and in example files such as
`frontend/src/lib/orion/orion-certified-models.example.json`. A model may only be
added to the certified list after a V2 report with `recommendation: 'proceed'`
has been generated and committed to
`frontend/benchmark/orion/output/<model>-v2-report.json`.

## 10. Version history

* **v2.0.0-semantic** — Initial V2 semantic contract. Introduced after the
  `qwen3:4b-instruct` certification conflict showed that the V1 bake-off was too
  sensitive to raw-JSON shape and not robust to production contract evolution.

* **v2.1.0-semantic** — Corrected the V2 #5/#11 navigation-only contract defect
  (no unsolicited candle reports) and added the narrow semantically-equivalent
  direct-`session.switch_symbol` alternative for exact validated in-list tickers.
  The prompt suite, certification contract and design plan are now
  `v2.1.0-22-prompts` / `v2.1.0-semantic`; reports under v2.0.0 are incompatible.
