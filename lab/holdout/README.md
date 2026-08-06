# Orion Scenario Lab — Holdout Lifecycle

> Holdout scenarios are isolated from mutation generation. They exist only to evaluate final lab harness behavior and must never be used as mutation training input.

## Directories

- `permanent/` — reviewed, version-controlled regression scenarios that represent confirmed failures or critical invariants. Promoted from `triage/` after root-cause review.
- `triage/` — newly observed failing scenarios from real Windows production runs awaiting root-cause analysis.

## Lifecycle rules

1. **Seeds are the source of mutations.** Only files under `lab/scenarios/` may be used as `seedScenarios` for `generateMutationPreview`.
2. **Holdout isolation.** The mutation generator rejects any path containing `holdout`.
3. **No auto-promotion.** A failed scenario may move from `triage/` to `permanent/` only after a human reviews the root cause and updates the scenario expectations.
4. **Generated variants carry provenance.** Every generated scenario stores `sourceScenarioId`, `sourceScenarioHash`, `familyId`, `seedId`, `variantOf`, and the generator version in `meta.mutation`.
5. **Permanent holdouts are read-only for evaluation.** CI or local runs may load them as a final test set, but the generator must never read them during development.

## Promotion checklist

- [ ] Failure reproduced with a real production adapter run.
- [ ] Root cause identified (capability drift, grounding error, context loss, etc.).
- [ ] Scenario expectations match the intended fix.
- [ ] Scenario validated against the schema and reference calculator.
- [ ] Moved from `triage/<id>.json` to `permanent/<family>-<id>.json`.
