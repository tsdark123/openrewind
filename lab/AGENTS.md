# Orion Scenario Lab notes

## Verification commands

From `lab/`:
- Type-check: `npm run typecheck`
- Unit tests: `npm test`
- Fixture dry run: `npx tsx runner/run-fixture.ts`
- Schema generation: `npm run generate:schemas`

## Production engine unit contract

The engine's `session_state` always reports `cursor` and `total_candles` in the **base 1-minute unit** for the loaded trading session. The agent may change the displayed `timeframe`, but `cursor` and `totalCandles` in `AppState`/`WorldState` remain base counts. The displayed candle index is derived separately; the lab's `expectedFinalWorldState` for `cursor` and `totalCandles` must use base values.

Examples from the `synthetic-session-1m` fixture (09:30-15:59, 390 candles):
- 11:30 is the 120th minute, so `cursor = 120` (zero-based).
- Switching to a 5-minute timeframe leaves `cursor = 389` and `totalCandles = 390` because the last loaded 1-minute candle stays at index 389 and the session still contains 390 base candles.

## Consumer-quality classification rules

The lab now separates **core semantic correctness** (grounding, required/forbidden capabilities, context, receipts, numerical truth, final WorldState) from **consumer quality** (wording, internal identifiers, hidden failures, unsupported numbers, evasive text). A consumer warning (`warn`) is reported when the message is semantically grounded and factually correct but omits a literal phrase, uses an alternate wording, or exposes a minor internal label. A consumer `fail` is reported for empty, evasive, unrelated, numerically hallucinated, or action-misleading responses.
