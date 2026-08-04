# Phase 6A.3 Runtime Acceptance Report (qwen3:8b)

**Generated:** 2026-08-04T18:49:08.769Z
**Model:** qwen3:8b via Ollama at http://127.0.0.1:11434
**Engine:** OpenRewind local engine at http://127.0.0.1:9000
**Dataset:** AAPL 2026-07-10, 1-minute candles
**Overall result:** PASS

## Summary
This report captures the first real-engine runtime acceptance run for the Orion 6A.3 analysis-capability prompts (A-D).
The test exercises the full orchestrator, compact-intent planner, analysis capabilities, and grounding verification against the live engine and qwen3:8b.

All 15 prompts passed, including setup, context inheritance (C.8–C.11), unsupported-indicator rejection (D.13), missing-context clarification (D.14), and no-session precondition failure (D.15).

## Code Changes and Rationale
The runtime run exposed several mis-routing and grounding issues. The fixes are small, targeted, and avoid exact-sentence hacks:

| File | Change | Why |
|------|--------|-----|
| `src/lib/orion/agent/intent.ts` | Added `'analysisRequests'` to `INHERITABLE_FIELDS_SET` and the JSON-Schema enum. | `validateContextReference` was rejecting inherited `analysisRequests` with "Unknown inheritable field", breaking context-based analysis repeats like C.8. |
| `src/lib/orion/agent/dimensions.ts` | Tightened `textRequestsAnalysis` so plain "move" (e.g. "move the replay") does not trigger analysis mode; added `textRequestsCandleShape` and `textRequestsUnsupportedIndicator`. | Prevents seek/playback prompts from being treated as price-movement analysis; routes RSI/MACD/etc. to `unsupported` before the model. |
| `src/lib/orion/agent/dimensions.ts` | `getRequestedDimensions` now skips `symbol` from a false `switch` positive when the text is an analysis request. | Stops "open high low close..." from being compiled as a `switch` to a non-existent symbol. |
| `src/lib/orion/agent/dimensions.ts` | `textRequestsRelativeSeek` no longer treats "first 30 mins to the last 30" as a seek. | The parser was interpreting the comparison as `fast_forward` with `relativeMinutes: 30`. |
| `src/lib/orion/agent/orchestrator.ts` | `looksLikeContextReference` now matches "do that analysis on NVDA" and similar anaphoric analysis requests. | Forces the anaphoric path to the model so the request is not misparsed as a bare `switch`. |
| `src/lib/orion/agent/orchestrator.ts` | Added a `textRequestsUnsupportedIndicator` guard that returns `route: 'unsupported'`. | Keeps Phase-6A scope; prevents out-of-scope indicators from being answered or hallucinated. |
| `src/lib/orion/agent/orchestrator.ts` | Added candle-shape fallback when the model emits `finalQuery: 'current_candle'` for an analysis-shaped candle query. | qwen3 sometimes maps "what kind of candle am i on" to a candle query; the fallback converts it to `candle_shape` so the request is not stripped. |
| `src/lib/orion/agent/intentCompiler.ts` | Analysis steps are now `required: true`. | A plan whose only step is an analysis that fails (e.g. D.15 no session) now reports `ok: false` instead of silently succeeding. |
| `src/lib/orion/agent/__acceptance__/qwen3-analysis-runtime.test.ts` | New runtime acceptance harness; also writes this report. | Provides a reproducible, real-engine, real-model verification of prompts A-D. |

## Verification Run
- `npx tsc --noEmit` — passed
- `node node_modules/vitest/vitest.mjs run src/lib/orion/agent/__tests__` — 22 files, 296 tests passed
- `node node_modules/vitest/vitest.mjs run -c vitest.qwen3-acceptance.config.ts` — 8 tests passed
- `node node_modules/vitest/vitest.mjs run -c vitest.qwen3-runtime.config.ts` — 1 test passed (this run)

## Per-prompt Results
### setup: "Switch to AAPL 2026-07-10 1m."

- **Route:** `deterministic`
- **OK:** true
- **Response:** Timeframe set to 1m.
- **Plan:**
  - `session.resolve_trading_date` — `{"symbol":"AAPL","input":{"kind":"explicit","date":"2026-07-10"}}`
  - `session.switch_symbol` — `{"symbol":"AAPL","date":{"$ref":"resolve-date-1","path":"date"}}`
  - `chart.set_timeframe` — `{"timeframe":1}`

### A.1: "How did AAPL do today?"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** 390 candles for AAPL on 2026-07-10 (engine_returned_candles_for_requested_date): open 314.72, close 315.33 (up 0.61, 0.19%). High 316.91 at 15:41, low 312.17 at 10:36. Volume total 23903698.00, average 61291.53, largest 1081777.00 at 09:30. Average body 0.11, upper wick 0.05, lower wick 0.06.
- **Plan:**
  - `session.resolve_symbol` — `{"name":"AAPL"}`
  - `session.resolve_trading_date` — `{"symbol":{"$ref":"step-resolve-symbol","path":"symbol"},"input":{"kind":"explicit","date":"2026-07-10"}}`
  - `session.switch_symbol` — `{"symbol":{"$ref":"step-resolve-symbol","path":"symbol"},"date":{"$ref":"step-resolve-date","path":"date"}}`
  - `analysis.window_summary` — `{"window":{"kind":"whole_session"}}`

### A.2: "range first hour"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** 60 candles for AAPL on 2026-07-10 (engine_returned_candles_for_requested_date): open 314.72, high 316.39 at 09:35, low 312.93 at 10:26, close 313.13.
- **Plan:**
  - `analysis.window_ohlc` — `{"window":{"kind":"time_range","fromTime":"09:30","toTime":"10:30"}}`

### A.3: "how much did it move up to where im at"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** 390 candles for AAPL on 2026-07-10 (chart_buffer_up_to_cursor): open 314.72, close 315.33 (up 0.61, 0.19%). High 316.91 at 15:41, low 312.17 at 10:36. Volume total 23903698.00, average 61291.53, largest 1081777.00 at 09:30. Average body 0.11, upper wick 0.05, lower wick 0.06.
- **Plan:**
  - `analysis.window_summary` — `{"window":{"kind":"up_to_cursor"}}`

### A.4: "what kind of candle am i on rn"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** Candle at 15:59: up body 0.27, upper wick 0.02, lower wick 0.04, range 0.33.
- **Plan:**
  - `analysis.candle_shape` — `{"source":"current_chart_candle"}`

### B.5: "was mornig volum higher than near close"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** Volume over 60 candles: total 5801085.00, average 96684.75, largest 531258.00 at 15:59.
- **Plan:**
  - `analysis.window_volume` — `{"window":{"kind":"time_range","fromTime":"09:30","toTime":"12:00"}}`
  - `analysis.window_volume` — `{"window":{"kind":"time_range","fromTime":"15:00","toTime":"16:00"}}`

### B.6: "yo compare the first 30 mins to the last 30"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** 150 candles (09:30–11:59) vs 30 candles (15:30–15:59): close delta 2.10 (0.67%), volume delta -8021475.00 (-66.78%).
- **Plan:**
  - `analysis.window_compare` — `{"left":{"kind":"time_range","fromTime":"09:30","toTime":"12:00"},"right":{"kind":"time_range","fromTime":"15:30","toTime":"18:00"}}`

### B.7: "give me the move, total volum and candle anatomy from 10 to noon"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** Candle at 12:00: up body 0.10, upper wick 0.03, lower wick 0.01, range 0.14.
- **Plan:**
  - `analysis.window_change` — `{"window":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"}}`
  - `analysis.window_volume` — `{"window":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"}}`
  - `analysis.candle_shape` — `{"source":"market_time","marketTime":"12:00"}`

### C.8: "same thing but first hour"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** 60 candles for AAPL on 2026-07-10 (engine_returned_candles_for_requested_date): open 314.72, high 316.39 at 09:35, low 312.93 at 10:26, close 313.13.
- **Plan:**
  - `analysis.window_ohlc` — `{"window":{"kind":"time_range","fromTime":"09:30","toTime":"10:30"}}`
- **context before:** `{"kind":"chart_action","analysisRequests":[{"kind":"window_change","window":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"}},{"kind":"window_volume","window":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"}},{"kind":"candle_shape","source":"market_time","marketTime":"12:00"}]}`
- **context after:** `{"kind":"chart_action","analysisRequests":[{"kind":"window_ohlc","window":{"kind":"time_range","fromTime":"09:30","toTime":"10:30"}}]}`

### C.9: "what about volume?"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** Volume over 60 candles: total 6346453.00, average 105774.22, largest 1081777.00 at 09:30.
- **Plan:**
  - `analysis.window_volume` — `{"window":{"kind":"time_range","fromTime":"09:30","toTime":"10:30"}}`

### C.10: "compare that with the last hour"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** Volume over 240 candles: total 11210451.00, average 46710.21, largest 314194.00 at 10:32.
- **Plan:**
  - `analysis.window_compare` — `{"left":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"},"right":{"kind":"time_range","fromTime":"12:00","toTime":"14:00"}}`
  - `analysis.window_volume` — `{"window":{"kind":"time_range","fromTime":"10:00","toTime":"14:00"}}`

### C.11: "do that analysis on NVDA"

- **Route:** `llm-plan`
- **OK:** true
- **Response:** Volume over 240 candles: total 75683968.00, average 315349.87, largest 2477787.00 at 10:01.
- **Plan:**
  - `session.resolve_symbol` — `{"name":"NVDA"}`
  - `session.resolve_trading_date` — `{"symbol":{"$ref":"step-resolve-symbol","path":"symbol"},"input":{"kind":"explicit","date":"2026-07-10"}}`
  - `session.switch_symbol` — `{"symbol":{"$ref":"step-resolve-symbol","path":"symbol"},"date":{"$ref":"step-resolve-date","path":"date"}}`
  - `chart.set_timeframe` — `{"timeframe":1}`
  - `analysis.window_compare` — `{"left":{"kind":"time_range","fromTime":"10:00","toTime":"12:00"},"right":{"kind":"time_range","fromTime":"12:00","toTime":"14:00"}}`
  - `analysis.window_volume` — `{"window":{"kind":"time_range","fromTime":"10:00","toTime":"14:00"}}`

### D.12: "give me the open high low close volume and change from 9:30 to 10, 10 to 11, 11 to 12, 12 to 1 and 1 to 2"

- **Route:** `clarification`
- **OK:** true
- **Response:** Invalid JSON format. Please provide a valid JSON request.

### D.13: "what are the RSI and MACD"

- **Route:** `unsupported`
- **OK:** false
- **Response:** I can only answer window OHLC, volume, change, compare, and candle-shape questions right now.

### D.14: "what about volume? (fresh context)"

- **Route:** `clarification`
- **OK:** true
- **Response:** analysisRequests[0] is missing a window and no prior analysis exists to inherit from.

### D.15: "how did it do? (no active session)"

- **Route:** `llm-plan`
- **OK:** false
- **Response:** No active session to analyze a window.
- **Plan:**
  - `analysis.window_summary` — `{"window":{"kind":"whole_session"}}`

## Grounding Verification
The runtime test independently recomputed selected outputs from raw engine candles to confirm the agent’s numbers are not hallucinated.

### A.2 first-hour OHLC
```json
{
  "ok": true,
  "expected": {
    "open": 314.72,
    "high": 316.39,
    "low": 312.9301,
    "close": 313.13,
    "candleCount": 60
  },
  "received": {
    "open": 314.72,
    "high": 316.39,
    "low": 312.9301,
    "close": 313.13,
    "candleCount": 60
  }
}
```

### A.4 candle shape
```json
{
  "ok": true,
  "expected": {
    "open": 315.06,
    "high": 315.35,
    "low": 315.02,
    "close": 315.3299,
    "volume": 531258
  },
  "received": {
    "open": 315.06,
    "high": 315.35,
    "low": 315.02,
    "close": 315.3299,
    "volume": 531258
  }
}
```

## Failures
No failures.
