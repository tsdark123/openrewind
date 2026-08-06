# Orion Scenario Lab — Mutation Generator V1

> MUTATION PREVIEW — NOT REAL ORION EXECUTION

The mutation generator expands trusted, human-reviewed scenario seeds into semantically equivalent prompt and state variants. V1 is deterministic, rule-based, and uses no LLM.

## Architecture

- `types.ts` — `MutationSpec`, `MutationContext`, `MutationOperator`, `MutationConfig`, `MutationCoverage` schemas.
- `util.ts` — deterministic PRNG (`mulberry32`), stable hash, deep clone, normalization.
- `registry.ts` — operator lookup table.
- `generator.ts` — loads seeds, applies operators, validates, deduplicates, and selects a diverse per-family set.
- `coverage.ts` — computes and renders `coverage.json` and `coverage.md`.
- `metamorphic.ts` — checks that semantically equivalent variants agree on the grounding contract.
- Operators:
  - `lexical.ts` — safe paraphrase prefixes.
  - `punctuation.ts` — punctuation and casing variants.
  - `time-expressions.ts` — equivalent explicit/spoken time forms and named-window forms.
  - `symbol-aliases.ts` — explicit `for <alias>` phrasing for `SYNTH`.
  - `context-states.ts` — anaphoric (`that`/`it`) vs explicit follow-up phrasing.
  - `state-variants.ts` — same-session, switch-required, and no-session state variants.
  - `typo.ts` — controlled missing apostrophe, duplicated letter, omitted letter, and adjacent-key typos.
  - `negative-controls.ts` — deliberately ambiguous/invalid prompts marked as negative controls.

## Determinism

The same `seed` and `seedScenarios` always produce the same set of scenarios. The PRNG (`mulberry32`) is only used for optional selection when multiple equivalent choices exist; V1 selection is currently rule-based and `ctx.choose` is available for future operators.

## Usage

```bash
cd lab
npm run mutation:preview
```

Artifacts land in `outbox/mutation-preview/`:

- `scenarios/` — one JSON scenario per variant.
- `manifest.json` — runner-compatible manifest.
- `scenarios.jsonl` — newline-delimited `{ scenario, mutation }` records.
- `coverage.json` and `coverage.md` — coverage summary.

## Semantics

Generated variants preserve the semantic contract of their seed: symbol, date, timeframe, market time, window boundaries, required capabilities, forbidden side effects, final `WorldState` invariants, and independent numerical truth. Route and plan shape are optional unless `assertExactRoute`/`assertExactPlan` is true.
