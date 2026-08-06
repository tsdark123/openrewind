# timeframe-change — production defect bundle

**Scenario:** `timeframe-change` (smoke)  
**Run:** `run-1785983647618`  
**Mode:** production  
**Model:** qwen3:8b  
**Outcome:** core FAIL, consumer FAIL

## What the user asked

> "Switch to 5 minute candles."

The expected action is `chart.set_timeframe` with `timeframe = 5`, preserving symbol and date.

## What the agent did

The planner produced a two-step plan:

1. `chart.set_timeframe` (success) — changed displayed timeframe to 5.
2. `playback.seek_relative` (forbidden, failed) — attempted a 5-minute relative seek.

```json
{
  "plan": {
    "id": "plan-intent-1785983652596",
    "kind": "action",
    "summary": "5m · 5m relative",
    "steps": [
      { "id": "step-timeframe", "capability": "chart.set_timeframe", "args": { "timeframe": 5 } },
      { "id": "step-seek-relative", "capability": "playback.seek_relative", "args": { "minutes": 5 } }
    ],
    "meta": { "planner": "compact-intent" }
  }
}
```

## Core semantic failures

| Stage | Violation |
|-------|-----------|
| `status` | `Expected ok=true, got ok=false` |
| `forbidden` | `playback.seek_relative` is listed in `forbiddenActions` |
| `permitted` | `playback.seek_relative` is not in the permitted `chart.*` list |
| `context` | Post-turn context template contains extra `relativeSeekMinutes` and `playback` fields not expected by the scenario |

The scenario explicitly permits only `chart.*` and forbids `analysis.*`, `playback.*`, and `session.*`. The agent therefore executed a forbidden capability.

## Receipt evidence

`chart.set_timeframe` succeeded:

```json
{
  "capability": "chart.set_timeframe",
  "success": true,
  "data": { "timeframe": 5 },
  "stateChanges": [{ "key": "timeframe", "before": 1, "after": 5 }]
}
```

`playback.seek_relative` failed:

```json
{
  "capability": "playback.seek_relative",
  "success": false,
  "errorCode": "ACKNOWLEDGMENT_TIMEOUT",
  "message": "Did not confirm seek to 2026-08-05T20:04:00.000Z.",
  "data": { "cursor": 389, "minutes": 5 }
}
```

The failed seek also left the final WorldState with `cursor: 389` and `totalCandles: 390`, which are the correct **base 1-minute unit** values. The lab expectation was updated to match this contract.

## Consumer-quality failures

The agent's final consumer message was:

> "Did not confirm seek to 2026-08-05T20:04:00.000Z."

This response:
- Contains unsupported numbers (`2026`, `08`, `000`) that are not grounded in any receipt.
- Exposes a raw ISO timestamp (`2026-08-05T20:04:00.000Z`) from the engine's internal state, which is not user-facing.
- Correctly states that the seek failed (so it does not hide the failure), but does so in a way that leaks an internal engine identifier.

## Lab calibration applied

- `scenarios/smoke/timeframe-change.json`: `expectedFinalWorldState.cursor` and `totalCandles` updated from `77`/`78` to `389`/`390` to reflect the engine's base 1-minute unit contract.
- `tests/fixtures/smoke-responses.json`: fixture cursor/total updated to match.
- New regression-oracle split reports `timeframe-change` as core FAIL and consumer FAIL.

## Suggested production fixes

1. **Planner:** `chart.set_timeframe` should not chain `playback.seek_relative` when the user only asks to switch timeframes. The seek is unnecessary and currently forbidden.
2. **Error message sanitization:** Failed engine operations should not echo raw ISO timestamps or internal state values to the user. Use a concise, user-facing message such as "Could not confirm the seek." and log the raw timestamp internally.
3. **WorldState contract documentation:** Ensure the agent/frontend understands that `cursor` and `totalCandles` stay in base units even when `timeframeMinutes` changes.
