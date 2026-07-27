# OpenRewind — System Architecture

> A free, open-source market replay and backtesting engine. Practice trading on any historical date with bar-by-bar playback, realistic order execution, and zero risk — powered by a C++20 core and a React/TypeScript UI.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Repository Layout](#2-repository-layout)
3. [C++ Data Models](#3-c-data-models)
4. [Order Matching Engine](#4-order-matching-engine)
5. [Network Bridge — WebSocket & REST](#5-network-bridge--websocket--rest)
6. [Data Ingestion Pipeline](#6-data-ingestion-pipeline)
7. [Frontend Architecture](#7-frontend-architecture)
8. [Build System & Toolchain](#8-build-system--toolchain)
9. [V1 Scope & Roadmap](#9-v1-scope--roadmap)

---

## 1. High-Level Overview

OpenRewind is split into two independently deployable halves that communicate over localhost:

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER'S BROWSER                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              React / TypeScript Frontend                  │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐   │  │
│  │  │ TradingView  │  │  Order Entry │  │   Account &    │   │  │
│  │  │ Lightweight  │  │    Panel     │  │  Replay Panel  │   │  │
│  │  │   Charts     │  │ (SL/TP/Mkt) │  │  (Balance/PnL) │   │  │
│  │  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘   │  │
│  │         │                 │                   │            │  │
│  │         └────────┬────────┴───────────────────┘            │  │
│  │                  │  WebSocket (ws://localhost:9000/ws)      │  │
│  │                  │  REST      (http://localhost:9000/api)   │  │
│  └──────────────────┼────────────────────────────────────────┘  │
└─────────────────────┼───────────────────────────────────────────┘
                      │
        ──────────────┼──────────────── Network Boundary ─────────
                      │
┌─────────────────────┼───────────────────────────────────────────┐
│                     ▼                                           │
│            C++20 Core Engine  (Crow HTTP/WS Server)             │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ CandleBuffer │  │   Matching   │  │   Session Manager     │  │
│  │  (in-memory  │  │    Engine    │  │  (cursor, speed,      │  │
│  │   vector +   │──│  (orders,    │──│   playback state)     │  │
│  │   cursor)    │  │   SL/TP,     │  │                       │  │
│  │              │  │   account)   │  │                       │  │
│  └──────┬───────┘  └──────────────┘  └───────────────────────┘  │
│         │                                                       │
│  ┌──────┴───────┐                                               │
│  │  CSV Loader  │◄──── /data/{symbol}/{symbol}_YYYYMM.csv      │
│  └──────────────┘                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                      ▲
                      │  (offline, pre-session)
┌─────────────────────┼───────────────────────────────────────────┐
│         Python Ingestion Script                                 │
│         fetch_data.py  →  Alpha Vantage API  →  CSV files       │
└─────────────────────────────────────────────────────────────────┘
```

**Data flow in one sentence:** A Python script pre-downloads historical 1-minute candles from Alpha Vantage into local CSV files; the C++20 engine loads them into a contiguous in-memory buffer and exposes a WebSocket + REST API; the React frontend connects, requests candle-by-candle playback, places orders, and renders everything with TradingView's lightweight-charts.

---

## 2. Repository Layout

```
OpenRewind/
├── ARCHITECTURE.md          ← you are here
├── README.md
│
├── engine/                  ← C++20 core backend
│   ├── CMakeLists.txt
│   ├── vcpkg.json           ← dependency manifest (Crow, nlohmann-json)
│   ├── include/
│   │   ├── candle.hpp       ← Candle struct, CandleBuffer
│   │   ├── matching.hpp     ← Order, Position, Account, MatchingEngine
│   │   ├── session.hpp      ← SessionManager (cursor, playback, timeframe)
│   │   ├── csv_loader.hpp   ← CSV parsing into CandleBuffer
│   │   └── server.hpp       ← Crow routes + WebSocket hub
│   └── src/
│       ├── main.cpp         ← entry point: start Crow on :9000
│       ├── candle.cpp
│       ├── matching.cpp
│       ├── session.cpp
│       ├── csv_loader.cpp
│       └── server.cpp
│
├── frontend/                ← React / TypeScript UI
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── Chart.tsx            ← TradingView lightweight-charts wrapper
│       │   ├── ReplayControls.tsx   ← Play/Pause, Next, Rewind, Speed
│       │   ├── OrderPanel.tsx       ← Market/Limit order form, SL/TP
│       │   └── AccountPanel.tsx     ← Balance, equity, open positions, history
│       ├── hooks/
│       │   └── useWebSocket.ts      ← WebSocket connection manager
│       ├── services/
│       │   └── api.ts               ← REST helpers (start session, place order)
│       └── types/
│           └── index.ts             ← shared TypeScript interfaces
│
├── scripts/                 ← Data ingestion
│   ├── fetch_data.py        ← Alpha Vantage downloader
│   └── requirements.txt     ← requests
│
└── data/                    ← Local CSV cache (git-ignored)
    └── AAPL/
        ├── AAPL_202401.csv
        ├── AAPL_202402.csv
        └── ...
```

---

## 3. C++ Data Models

### 3.1 The `Candle` Struct

Every bar in the system is represented by a single, tightly-packed struct:

```cpp
// include/candle.hpp

#pragma once
#include <cstdint>
#include <vector>
#include <string>

struct Candle {
    int64_t  timestamp;  // Unix epoch seconds (UTC)
    double   open;
    double   high;
    double   low;
    double   close;
    uint64_t volume;
};
```

**Why this layout matters:**

| Field       | Type       | Bytes | Rationale |
|-------------|------------|-------|-----------|
| `timestamp` | `int64_t`  | 8     | Signed to safely represent dates before epoch if needed. Unix seconds gives us sub-day resolution and trivial arithmetic. |
| `open`      | `double`   | 8     | IEEE 754 double gives 15–17 significant digits — more than enough for any asset price (BTC at $100,000.01 needs only 10). |
| `high`      | `double`   | 8     | Same. |
| `low`       | `double`   | 8     | Same. |
| `close`     | `double`   | 8     | Same. |
| `volume`    | `uint64_t` | 8     | Unsigned — volume is never negative. 64-bit supports crypto volumes in satoshis. |

**Total: 48 bytes per candle.** This is exactly **¾ of a 64-byte cache line**, meaning pairs of candles straddle at most 2 cache lines — excellent for sequential scans.

A full trading year of 1-minute candles for a US equity (≈ 252 days × 390 minutes/day ≈ 98,280 candles) occupies **~4.7 MB** — trivially fits in L3 cache on any modern CPU.

### 3.2 The `CandleBuffer`

```cpp
// include/candle.hpp (continued)

class CandleBuffer {
public:
    // Load candles from a sorted CSV file or merge multiple files.
    void load(const std::string& csv_path);
    void merge(const std::string& csv_path);  // append + re-sort by timestamp

    // --- Time-Travel Interface ---

    // Advance the cursor forward by `n` bars. Returns false if at end.
    bool advance(size_t n = 1);

    // Rewind the cursor backward by `n` bars. Returns false if at start.
    bool rewind(size_t n = 1);

    // Jump to the candle closest to `target_timestamp`.
    void seek(int64_t target_timestamp);

    // --- Accessors ---

    // The candle at the current cursor position.
    const Candle& current() const;

    // All candles from index 0 up to and including the cursor (the "visible" history).
    // This is what we send to the frontend chart.
    std::span<const Candle> visible_history() const;

    // Total number of candles loaded.
    size_t size() const;

    // Current cursor index.
    size_t cursor() const;

    // Are we at the last candle?
    bool at_end() const;

private:
    std::vector<Candle> candles_;  // contiguous, sorted by timestamp ascending
    size_t cursor_ = 0;           // index into candles_: the "present moment"
};
```

**Design principles:**

- **Contiguous memory:** `std::vector<Candle>` gives us a single heap allocation. Sequential access patterns (advance, rewind) enjoy hardware prefetching.
- **Raw index pointer:** `cursor_` is a plain `size_t` index, not an iterator. This makes serialization trivial, bounds-checking cheap (`cursor_ < candles_.size()`), and rewind is just `cursor_--`.
- **`std::span` for zero-copy slicing:** `visible_history()` returns a view over `[0, cursor_]` without copying. The frontend receives this slice serialized to JSON.
- **`seek()` uses binary search:** Since candles are sorted by timestamp, `std::lower_bound` on `candles_` gives O(log n) random access to any date.

### 3.3 Timeframe Aggregation

The base data is always **1-minute candles**. Higher timeframes (5m, 15m, 1H, 4H, Daily) are computed on-the-fly from the visible history:

```cpp
// Pseudocode for on-the-fly aggregation
std::vector<Candle> aggregate(std::span<const Candle> base, int minutes) {
    std::vector<Candle> result;
    Candle agg{};
    int count = 0;

    for (const auto& c : base) {
        if (count == 0) {
            agg.timestamp = c.timestamp;
            agg.open      = c.open;
            agg.high      = c.high;
            agg.low       = c.low;
            agg.volume    = 0;
        }
        agg.high   = std::max(agg.high, c.high);
        agg.low    = std::min(agg.low, c.low);
        agg.close  = c.close;
        agg.volume += c.volume;

        if (++count >= minutes) {
            result.push_back(agg);
            count = 0;
        }
    }
    // Push the final incomplete bar if any
    if (count > 0) result.push_back(agg);
    return result;
}
```

**Why on-the-fly instead of pre-computed?** Storing one `std::vector<Candle>` at 1-minute granularity is the single source of truth. Pre-computing every timeframe would multiply storage by ~6× and create synchronization headaches when the cursor moves. Aggregation of ~100k candles into 5-minute bars takes <1ms — invisible to the user.

---

## 4. Order Matching Engine

The matching engine is the financial heart of OpenRewind. It simulates a simplified exchange: no order book depth, no slippage model (V1), no partial fills. But the math must be precise.

### 4.1 Core Types

```cpp
// include/matching.hpp

#pragma once
#include "candle.hpp"
#include <cstdint>
#include <vector>
#include <optional>

enum class Side     { Buy, Sell };
enum class OrdType  { Market, Limit, Stop };
enum class OrdStatus { Pending, Filled, Cancelled, StopLossHit, TakeProfitHit };

struct Order {
    uint64_t             id;
    Side                 side;
    OrdType              type;
    double               entry_price;    // desired fill price (Market = 0, filled at current close)
    double               stop_loss;      // 0.0 means no SL
    double               take_profit;    // 0.0 means no TP
    double               quantity;       // number of units (shares, lots, coins)
    OrdStatus            status;
    int64_t              created_at;     // timestamp when order was placed
    int64_t              filled_at;      // timestamp when order was executed
    std::optional<double> fill_price;    // actual execution price
};

struct Position {
    uint64_t id;             // matches the Order that opened it
    Side     side;
    double   entry_price;
    double   quantity;
    double   stop_loss;
    double   take_profit;
    int64_t  opened_at;

    // Computed per-tick
    double   unrealized_pnl(double current_price) const {
        double delta = (side == Side::Buy)
            ? (current_price - entry_price)
            : (entry_price - current_price);
        return delta * quantity;
    }
};

struct Account {
    double   starting_balance;
    double   balance;       // cash after realized P&L
    double   equity;        // balance + sum(unrealized P&L)

    std::vector<Position> open_positions;
    std::vector<Order>    order_history;   // filled + cancelled
    std::vector<Order>    pending_orders;  // Limit/Stop waiting for trigger

    uint64_t next_order_id = 1;
};
```

### 4.2 Matching Logic — What Happens When a New Candle Arrives

Every time the cursor advances, the engine calls `MatchingEngine::on_candle(const Candle& c)`. This is the most critical function in the system:

```
on_candle(candle):
│
├── Step 1: CHECK PENDING ORDERS (Limit / Stop)
│   │
│   │   For each pending Limit Buy order:
│   │       if candle.low <= order.entry_price:
│   │           FILL at order.entry_price → open Position
│   │
│   │   For each pending Limit Sell order:
│   │       if candle.high >= order.entry_price:
│   │           FILL at order.entry_price → open Position
│   │
│   │   For each pending Stop Buy order:
│   │       if candle.high >= order.entry_price:
│   │           FILL at order.entry_price → open Position
│   │
│   │   For each pending Stop Sell order:
│   │       if candle.low <= order.entry_price:
│   │           FILL at order.entry_price → open Position
│   │
├── Step 2: CHECK OPEN POSITIONS FOR SL / TP
│   │
│   │   For each open position:
│   │
│   │       [Buy position]
│   │           SL triggered if candle.low  <= position.stop_loss
│   │           TP triggered if candle.high >= position.take_profit
│   │
│   │       [Sell position]
│   │           SL triggered if candle.high >= position.stop_loss
│   │           TP triggered if candle.low  <= position.take_profit
│   │
│   │       CONFLICT RESOLUTION (both SL and TP in same candle):
│   │           → Always execute Stop Loss first (pessimistic assumption).
│   │           → Rationale: In a real market, violent candles often wick
│   │             through your SL before reversing. This conservative model
│   │             prevents inflated backtest results.
│   │
│   │       On SL hit:  close at SL price, realize loss, update balance
│   │       On TP hit:  close at TP price, realize gain, update balance
│   │
├── Step 3: UPDATE EQUITY
│   │
│   │   equity = balance + Σ position.unrealized_pnl(candle.close)
│   │
└── Step 4: EMIT EVENTS
        → AccountSnapshot { balance, equity, open_position_count }
        → OrderFill events for any orders that triggered this candle
```

### 4.3 Fill Price Logic

| Order Type   | Fill Price |
|-------------|-----------|
| Market Buy  | Current candle's `close` at time of order placement |
| Market Sell | Current candle's `close` at time of order placement |
| Limit Buy   | The order's `entry_price` (guaranteed or better) |
| Limit Sell  | The order's `entry_price` (guaranteed or better) |
| Stop Buy    | The order's `entry_price` (trigger = breach) |
| Stop Sell   | The order's `entry_price` (trigger = breach) |
| Stop Loss   | The position's `stop_loss` price |
| Take Profit | The position's `take_profit` price |

**V1 simplification:** No slippage, no spread, no commission. These are trivially addable in V2 as configurable parameters on the `Account` struct.

### 4.4 P&L Calculation

```
Realized P&L (on close):
    Buy:  (exit_price - entry_price) × quantity
    Sell: (entry_price - exit_price) × quantity

Unrealized P&L (per tick):
    Buy:  (current_close - entry_price) × quantity
    Sell: (entry_price - current_close) × quantity

Account Balance:
    balance = starting_balance + Σ realized_pnl (all closed trades)

Account Equity:
    equity = balance + Σ unrealized_pnl (all open positions)
```

### 4.5 Position Sizing

The frontend sends `quantity` with each order. In V1 the user manually specifies size. A future enhancement is risk-based sizing:

```
quantity = (account.balance × risk_percent) / |entry_price - stop_loss|
```

This formula ensures that if the SL is hit, the loss equals exactly `risk_percent` of balance.

---

## 5. Network Bridge — WebSocket & REST

### 5.1 Technology Choice: Crow

[Crow](https://crowcpp.org) is a C++20, header-only HTTP/WebSocket micro-framework. It compiles in seconds, supports multithreaded routing, and benchmarks at ~60,000 requests/second — far beyond our needs.

Dependencies:
- **Crow** (header-only, pulled via vcpkg)
- **nlohmann/json** (header-only, pulled via vcpkg) for JSON serialization

### 5.2 REST Endpoints

All REST routes are prefixed with `/api`.

| Method | Path | Request Body | Response | Purpose |
|--------|------|-------------|----------|---------|
| `POST` | `/api/session/start` | `{ symbol, start_date, starting_balance }` | `{ session_id, total_candles }` | Load CSV data, initialize CandleBuffer + Account |
| `POST` | `/api/session/stop` | `{ session_id }` | `{ summary }` | End session, return final P&L summary |
| `GET`  | `/api/session/state` | — | `{ cursor, candle, account, pending_orders }` | Poll current state (fallback if WS disconnects) |
| `POST` | `/api/order` | `{ session_id, side, type, entry_price?, stop_loss?, take_profit?, quantity }` | `{ order_id, status }` | Place a new order |
| `POST` | `/api/order/cancel` | `{ session_id, order_id }` | `{ success }` | Cancel a pending order |

### 5.3 WebSocket Protocol

The WebSocket endpoint is at `ws://localhost:9000/ws`.

#### Client → Server Commands

```jsonc
// Advance one candle
{ "cmd": "next_candle" }

// Rewind one candle (undo last advance)
{ "cmd": "rewind" }

// Jump to a specific timestamp
{ "cmd": "seek", "timestamp": 1704067200 }

// Start/stop auto-play
{ "cmd": "play" }
{ "cmd": "pause" }

// Set playback speed (candles per second)
{ "cmd": "set_speed", "speed": 5 }

// Change the display timeframe (aggregation level)
{ "cmd": "set_timeframe", "minutes": 15 }

// Place order via WS (alternative to REST)
{ "cmd": "place_order", "side": "buy", "type": "market", "quantity": 100,
  "stop_loss": 149.50, "take_profit": 155.00 }
```

#### Server → Client Events

Every event is wrapped in a standard envelope:

```jsonc
{
    "type": "candle_update",      // event type
    "seq": 4217,                  // monotonic sequence number for ordering
    "payload": { ... }            // event-specific data
}
```

Event types:

| Type | Payload | When |
|------|---------|------|
| `candle_update` | `{ timestamp, open, high, low, close, volume, cursor, total }` | After each `next_candle` / auto-play tick |
| `account_snapshot` | `{ balance, equity, open_positions: [...], pending_orders: [...] }` | After every candle (piggy-backed) |
| `order_filled` | `{ order_id, fill_price, side, quantity, timestamp }` | When a pending order triggers |
| `position_closed` | `{ position_id, exit_price, realized_pnl, reason: "sl" \| "tp" \| "manual" }` | When SL/TP hits or manual close |
| `session_started` | `{ session_id, symbol, total_candles, start_ts, end_ts }` | Ack after session start |
| `error` | `{ message }` | On invalid command or server error |

### 5.4 Auto-Play Loop

When the user presses "Play," the server enters a timer loop:

```
on "play" command:
    is_playing = true
    while is_playing and not at_end:
        advance cursor by 1
        run matching engine on new candle
        broadcast candle_update + account_snapshot
        sleep(1000ms / speed)     // speed=5 → 200ms between candles

on "pause" command:
    is_playing = false
```

The loop runs on a dedicated `std::thread` per session. The sleep interval is `1000 / speed` milliseconds, giving smooth playback from 1 candle/sec to 50 candles/sec.

### 5.5 Sequence Numbers & Ordering

Every server→client message carries a monotonically increasing `seq`. The frontend uses this to:
- Detect and discard out-of-order messages
- Confirm that all candle updates were received (no gaps)
- Resync via REST `GET /api/session/state` if a gap is detected

---

## 6. Data Ingestion Pipeline

### 6.1 Provider: Alpha Vantage

Alpha Vantage provides free access to historical intraday data via their `TIME_SERIES_INTRADAY` endpoint.

**Key parameters:**
- `function=TIME_SERIES_INTRADAY`
- `symbol=AAPL`
- `interval=1min`
- `outputsize=full` (returns trailing 30 days) or `month=2024-01` (returns full month)
- `datatype=csv` (returns CSV directly — no JSON parsing needed)

**Free tier limits:** 25 API calls per day. Each call with `month=YYYY-MM` returns an entire month of 1-minute data (~8,000–12,000 rows per month for US equities).

### 6.2 Python Ingestion Script

```
scripts/fetch_data.py

Usage:
    python fetch_data.py --symbol AAPL --start 2024-01 --end 2024-06 --apikey YOUR_KEY

Behavior:
    1. For each month in [start, end]:
        a. Check if data/{symbol}/{symbol}_YYYYMM.csv already exists → skip
        b. GET https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY
             &symbol={symbol}&interval=1min&month={YYYY-MM}
             &datatype=csv&outputsize=full&apikey={key}
        c. Write response body to data/{symbol}/{symbol}_YYYYMM.csv
        d. Log: "✓ Downloaded AAPL 2024-01 (9,847 rows)"
        e. Sleep 4 seconds between calls (stay within rate limits)
    2. Print summary: total months downloaded, total rows, disk usage
```

### 6.3 CSV File Format

Each CSV file has a header row followed by chronologically sorted data:

```csv
timestamp,open,high,low,close,volume
2024-01-02 09:30:00,185.52,185.63,185.41,185.55,128456
2024-01-02 09:31:00,185.55,185.70,185.50,185.68,95230
...
```

- **Timestamp** is in `YYYY-MM-DD HH:MM:SS` format, US Eastern time (market local).
- The C++ loader converts this to Unix epoch seconds at parse time.

### 6.4 C++ CSV Loader

```cpp
// include/csv_loader.hpp

#pragma once
#include "candle.hpp"
#include <string>
#include <vector>

class CsvLoader {
public:
    // Load a single CSV file into a vector of Candles.
    static std::vector<Candle> load_file(const std::string& path);

    // Load all CSVs matching data/{symbol}/{symbol}_*.csv, merge, sort, deduplicate.
    static std::vector<Candle> load_symbol(const std::string& symbol,
                                           const std::string& data_dir = "data");
};
```

**Performance characteristics:**
- A 6-month dataset (~60,000 rows, ~3 MB CSV) parses in <50ms using `std::ifstream` with line-by-line `std::getline` and `std::stod`.
- Timestamp parsing: `strptime` / `std::get_time` → `mktime` → epoch seconds.
- After loading, candles are sorted by timestamp and deduplicated (in case of overlapping month files).

### 6.5 Cache Directory Convention

```
data/
├── AAPL/
│   ├── AAPL_202401.csv
│   ├── AAPL_202402.csv
│   └── ...
├── MSFT/
│   └── ...
└── BTCUSD/
    └── ...
```

The `data/` directory is `.gitignore`d. Users run the ingestion script once to populate it, then the C++ engine reads from it at session start.

---

## 7. Frontend Architecture

### 7.1 Technology Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Framework | React | 18+ | Component model, state management |
| Language | TypeScript | 5+ | Type safety across the entire frontend |
| Bundler | Vite | 5+ | Fast dev server, HMR, production builds |
| Charts | `lightweight-charts` | 4+ | TradingView's open-source candlestick renderer |
| Styling | Tailwind CSS | 3+ | Utility-first CSS, dark theme |
| Icons | Lucide React | latest | Clean, consistent iconography |
| WS Client | Native `WebSocket` | — | No library needed; wrapped in a custom hook |

### 7.2 UI Layout

The layout mirrors FX Replay's professional trading interface:

```
┌─────────────────────────────────────────────────────────────┐
│  TOOLBAR:  [Symbol Selector ▼]  [Timeframe: 1m 5m 15m 1H]  │
├────────────────────────────────────────────┬────────────────┤
│                                            │                │
│                                            │  ORDER PANEL   │
│                                            │  ┌──────────┐  │
│          CANDLESTICK CHART                 │  │ Buy │Sell │  │
│       (TradingView lightweight-charts)     │  │          │  │
│                                            │  │ Qty: ____│  │
│       - Candles up to cursor visible       │  │ SL:  ____│  │
│       - Future candles hidden              │  │ TP:  ____│  │
│       - SL/TP lines drawn as markers       │  │ [Submit] │  │
│       - Trade entry/exit arrows on chart   │  └──────────┘  │
│                                            │                │
│                                            │  ACCOUNT INFO  │
│                                            │  Balance: $X   │
│                                            │  Equity:  $X   │
│                                            │  Open P&L: $X  │
│                                            │                │
│                                            │  POSITIONS     │
│                                            │  (table of     │
│                                            │   open trades) │
├────────────────────────────────────────────┴────────────────┤
│  REPLAY CONTROLS:                                           │
│  [⏮ Rewind]  [⏵ Play/Pause]  [⏭ Next Candle]              │
│  Speed: [1x] [2x] [5x] [10x] [25x] [50x]                  │
│  Progress: ████████░░░░░░░░░░ 42% (41,280 / 98,280)        │
└─────────────────────────────────────────────────────────────┘
```

### 7.3 Key Components

#### `Chart.tsx` — TradingView Wrapper

```tsx
// Responsibilities:
// 1. Create chart instance with createChart()
// 2. Add CandlestickSeries
// 3. On each candle_update event, call series.update({ time, open, high, low, close })
// 4. Draw SL/TP price lines using chart.addLineSeries or priceLine API
// 5. Mark trade entries/exits with series markers

// Key lightweight-charts API calls:
//   const chart = createChart(containerRef, { width, height, layout, grid, ... });
//   const series = chart.addSeries(CandlestickSeries, { upColor, downColor, ... });
//   series.setData(initialCandles);       // bulk load visible history
//   series.update(newCandle);             // append one candle
//   chart.timeScale().fitContent();       // auto-zoom to fit
//   chart.timeScale().scrollToPosition(0, false);  // stay at latest candle
```

#### `ReplayControls.tsx`

Sends WebSocket commands: `next_candle`, `rewind`, `play`, `pause`, `set_speed`. Displays a progress bar computed from `cursor / total_candles`.

#### `OrderPanel.tsx`

Form with:
- **Side toggle:** Buy / Sell
- **Type selector:** Market / Limit
- **Price input:** (for Limit orders only)
- **Quantity input**
- **Stop Loss input**
- **Take Profit input**
- **Submit button** → sends `place_order` via WebSocket or `POST /api/order` via REST

#### `AccountPanel.tsx`

Displays:
- **Balance** (cash after realized P&L)
- **Equity** (balance + unrealized)
- **Open P&L** (sum of unrealized across positions)
- **Open positions table:** entry price, side, qty, current P&L, SL, TP
- **Trade history table:** closed trades with realized P&L

### 7.4 `useWebSocket` Hook

```tsx
// hooks/useWebSocket.ts
//
// Custom React hook that:
// 1. Opens ws://localhost:9000/ws on mount
// 2. Reconnects automatically on disconnect (exponential backoff)
// 3. Parses incoming JSON messages by `type`
// 4. Dispatches to appropriate state updaters:
//      candle_update   → append to chart data array
//      account_snapshot → update account state
//      order_filled    → show toast notification, update order list
//      position_closed → show toast, move to history
// 5. Exposes `send(cmd)` function for outbound commands
// 6. Tracks connection status for UI indicator
```

### 7.5 State Management

V1 uses React's built-in `useReducer` + Context. The state shape:

```typescript
interface AppState {
    // Connection
    connected: boolean;
    sessionId: string | null;

    // Chart
    candles: CandleData[];          // lightweight-charts format
    cursor: number;
    totalCandles: number;
    timeframe: number;              // aggregation in minutes

    // Playback
    isPlaying: boolean;
    speed: number;                  // candles per second

    // Account
    balance: number;
    equity: number;
    openPositions: Position[];
    pendingOrders: Order[];
    tradeHistory: ClosedTrade[];
}
```

No Redux, no Zustand — the state is small enough for a single reducer. If V2 complexity grows, we promote to Zustand.

---

## 8. Build System & Toolchain

### 8.1 C++ Backend

| Tool | Purpose |
|------|---------|
| **CMake 3.20+** | Build system generator |
| **vcpkg** | C++ package manager (Crow, nlohmann-json) |
| **C++20 compiler** | MSVC 17+, GCC 12+, or Clang 15+ |

`vcpkg.json` manifest:
```json
{
    "name": "openrewind-engine",
    "version-string": "0.1.0",
    "dependencies": [
        "crow",
        "nlohmann-json"
    ]
}
```

Build commands:
```bash
cd engine
cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=[vcpkg root]/scripts/buildsystems/vcpkg.cmake
cmake --build build --config Release
./build/openrewind-engine   # starts server on :9000
```

### 8.2 Frontend

| Tool | Purpose |
|------|---------|
| **Node.js 18+** | JavaScript runtime |
| **pnpm** | Fast, disk-efficient package manager |
| **Vite** | Bundler + dev server with HMR |

Setup:
```bash
cd frontend
pnpm install
pnpm dev        # starts dev server on :5173, proxies /api → :9000
```

Vite proxy config to avoid CORS during development:
```typescript
// vite.config.ts
export default defineConfig({
    server: {
        proxy: {
            '/api': 'http://localhost:9000',
            '/ws':  { target: 'ws://localhost:9000', ws: true }
        }
    }
});
```

### 8.3 Development Workflow

```
Terminal 1:  cd engine/build && ./openrewind-engine     (C++ server on :9000)
Terminal 2:  cd frontend && pnpm dev                     (React dev on :5173)
Terminal 3:  python scripts/fetch_data.py --symbol AAPL  (one-time data fetch)
```

---

## 9. V1 Scope & Roadmap

### V1 — Core MVP (current build)

- [x] Architecture document
- [ ] C++ Candle struct + CandleBuffer with cursor navigation
- [ ] CSV loader (single symbol, multi-month merge)
- [ ] Matching engine (Market + Limit orders, SL/TP, account tracking)
- [ ] Crow server with REST + WebSocket
- [ ] Python ingestion script (Alpha Vantage)
- [ ] React chart with TradingView lightweight-charts
- [ ] Replay controls (Next, Rewind, Play/Pause, Speed)
- [ ] Order entry panel
- [ ] Account panel (balance, equity, positions, history)

### V2 — Enhanced Features (future)

- [ ] Stop orders
- [ ] Auto-breakeven (SL → entry when price moves X in your favor)
- [ ] Multi-chart / multi-timeframe synchronized views
- [ ] Trade journaling (notes, screenshots, tags)
- [ ] Performance dashboard (equity curve, win rate, drawdown)
- [ ] Monte Carlo simulation
- [ ] Slippage / spread / commission modeling
- [ ] Polygon.io data provider support
- [ ] Keyboard hotkeys (matching FX Replay conventions)
- [ ] Dark/light theme toggle

---

## Design Principles

1. **Single source of truth:** 1-minute candles in a contiguous vector. Everything else is derived.
2. **Pessimistic fills:** When SL and TP trigger on the same candle, SL wins. Backtests should underestimate, not overestimate.
3. **Zero-copy where possible:** `std::span` views, WebSocket streaming (no full-state dumps).
4. **Frontend is dumb, engine is smart:** The React UI is a thin rendering layer. All financial logic lives in C++.
5. **Offline-first data:** CSV files are fetched once and cached forever. The engine never calls external APIs at runtime.
6. **Correctness over speed:** V1 prioritizes bug-free matching logic. Micro-optimizations (SIMD aggregation, memory-mapped I/O) are V2.

---

*OpenRewind — Built to learn. Built to compete. Built to open-source.*
