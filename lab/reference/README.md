# Independent Reference Truth

`lab/reference/calculator.ts` is the sole source of numerical truth for the Orion Scenario Lab. It does **not** import `frontend/src/lib/orion/agent/analysis.ts` or any production numerical formula.

## Fixture

`synthetic-session-1m.json` is a fully synthetic US-equity session with:

- Symbol: `SYNTH`
- Date: `2026-08-05`
- Timeframe: `1` minute
- Timezone offset: `-4` (EDT)
- Market hours: `09:30` – `16:00` ET
- Candles: `390`

Each candle `i` is generated deterministically:

```
open    = 100.00 + i * 0.01
close   = open + 0.05  if i % 3 == 0   (bullish)
          open - 0.05  if i % 3 == 1   (bearish)
          open         if i % 3 == 2   (flat)
high    = max(open, close) + 0.02
low     = min(open, close) - 0.02
volume  = 1000 + i * 10
```

This produces unequal volumes, bullish / bearish / flat candles, and predictable highs/lows.

## Half-open time ranges

All `time_range` windows are `[fromTime, toTime)`.

- `09:30`–`10:30` includes the 60 candles whose market time is `09:30` through `10:29`.
- `15:00`–`16:00` includes the 60 candles whose market time is `15:00` through `15:59`.

## Manually derived expected values

### First hour `[09:30, 10:30)`

- Open: `100.00`
- High: `100.64` at `10:27`
- Low: `99.94` at `09:31`
- Close: `100.59`
- Candle count: `60`
- Total volume: `77,700`
- Average volume: `1,295`
- Largest volume: `1,590` at `10:29`
- Absolute change: `0.59`
- Percent change: `0.59%`

### Last hour `[15:00, 16:00)`

- Open: `103.30`
- High: `103.94` at `15:57`
- Low: `103.24` at `15:01`
- Close: `103.89`
- Candle count: `60`
- Total volume: `275,700`
- Average volume: `4,595`
- Largest volume: `4,890` at `15:59`
- Absolute change: `0.59`
- Percent change: `~0.57%`

### First hour vs last hour compare

- Price delta: `3.30`
- Price delta percent: `~3.28%`
- Volume delta: `198,000`
- Volume delta percent: `~254.83%`

### Single candles

| Time | Open | High | Low | Close | Volume | Direction |
|------|------|------|-----|-------|--------|-----------|
| 11:30 | 101.20 | 101.27 | 101.18 | 101.25 | 2,200 | up |
| 11:45 | 101.35 | 101.42 | 101.33 | 101.40 | 2,350 | up |

### Whole session summary

- Open: `100.00`
- High: `103.94` at `15:57`
- Low: `99.94` at `09:31`
- Close: `103.89`
- Candle count: `390`
- Total volume: `1,148,550`
- Average volume: `2,945`
- Largest volume: `4,890` at `15:59`
- Absolute change: `3.89`
- Percent change: `3.89%`
- Average body: `0.0333...`
- Average upper wick: `0.02`
- Average lower wick: `0.02`

## Common-mode failure detection

Three truth sources are used together:

1. `calculator.ts` recomputes from engine/fixture candles.
2. `fixtures/*.json` contains hand-checked expected values.
3. Production `analysis.ts` receipts are compared to the reference, but never define truth.

If the reference and fixture agree but production differs, the production implementation has a bug. If the reference and production agree but differ from the fixture, either the fixture is stale or they share a common assumption (e.g., a half-open interval or timezone offset). Metamorphic checks — window additivity, OHLC monotonicity, and candle-shape identity — catch common-mode errors even when both calculators return the same wrong number.
