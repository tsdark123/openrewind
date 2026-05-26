#pragma once

#include <cstdint>
#include <vector>
#include <span>
#include <string>
#include <algorithm>
#include <stdexcept>

// -----------------------------------------------------------------------------
// Candle — A single OHLCV bar in the market time series.
//
// Layout: 48 bytes, tightly packed (6 × 8-byte fields, no padding).
// Two adjacent Candles span exactly 96 bytes — fits in two 64-byte cache lines,
// enabling efficient hardware prefetch during sequential scans.
// -----------------------------------------------------------------------------
struct Candle {
    int64_t  timestamp;  // Unix epoch seconds (UTC)
    double   open;       // Opening price of the bar
    double   high;       // Highest price reached during the bar
    double   low;        // Lowest price reached during the bar
    double   close;      // Closing price of the bar
    uint64_t volume;     // Trade volume during the bar

    // Chronological ordering for sort/search operations.
    bool operator<(const Candle& other) const noexcept {
        return timestamp < other.timestamp;
    }

    bool operator==(const Candle& other) const noexcept {
        return timestamp == other.timestamp;
    }
};

// Compile-time guarantee: our struct is exactly 48 bytes with no hidden padding.
static_assert(sizeof(Candle) == 48, "Candle struct must be exactly 48 bytes");

// -----------------------------------------------------------------------------
// CandleBuffer — Contiguous in-memory storage for a chronologically sorted
// sequence of Candle objects, with a cursor-based "time travel" interface.
//
// The cursor represents the trader's "present moment." All candles at indices
// [0, cursor] are visible (the past); candles at (cursor, size) are hidden
// (the future). Advancing the cursor reveals the next bar; rewinding hides it.
//
// Performance characteristics:
//   advance(n)       — O(1)
//   rewind(n)        — O(1)
//   seek(timestamp)  — O(log n) via std::lower_bound binary search
//   visible_history  — O(1), zero-copy std::span over the internal vector
//   current()        — O(1), direct index access
//   aggregate()      — O(k) where k = number of visible candles
// -----------------------------------------------------------------------------
class CandleBuffer {
public:
    CandleBuffer() = default;

    // -------------------------------------------------------------------------
    // Data loading
    // -------------------------------------------------------------------------

    // Replace the buffer contents with a pre-built vector of candles.
    // Candles must already be sorted by timestamp ascending and deduplicated.
    // The cursor resets to index 0.
    void set_candles(std::vector<Candle> candles);

    // Append new candles from another vector, merge-sort, deduplicate, and
    // reset the cursor to 0. Useful for loading multiple month files.
    void merge_candles(const std::vector<Candle>& new_candles);

    // -------------------------------------------------------------------------
    // Time-Travel Interface
    // -------------------------------------------------------------------------

    // Advance the cursor forward by `n` bars.
    // Returns true if the cursor moved at all, false if already at end.
    bool advance(std::size_t n = 1);

    // Rewind the cursor backward by `n` bars.
    // Returns true if the cursor moved at all, false if already at start.
    bool rewind(std::size_t n = 1);

    // Jump the cursor to the candle whose timestamp is closest to (but not
    // exceeding) `target_timestamp`. Uses binary search — O(log n).
    // If target_timestamp is before all data, cursor goes to 0.
    // If target_timestamp is after all data, cursor goes to last candle.
    void seek(int64_t target_timestamp);

    // -------------------------------------------------------------------------
    // Accessors
    // -------------------------------------------------------------------------

    // The candle at the current cursor position.
    // Throws std::out_of_range if the buffer is empty.
    const Candle& current() const;

    // Zero-copy view of all candles from index 0 through cursor (inclusive).
    // This is the "visible past" that gets serialized to the frontend chart.
    // Returns an empty span if the buffer is empty.
    std::span<const Candle> visible_history() const;

    // Total number of candles in the buffer (past + future).
    std::size_t size() const noexcept;

    // Current cursor index (0-based).
    std::size_t cursor() const noexcept;

    // True if the cursor is at or beyond the last candle.
    bool at_end() const noexcept;

    // True if the buffer contains no candles.
    bool empty() const noexcept;

    // Timestamp of the first candle in the buffer (earliest date).
    // Throws std::out_of_range if empty.
    int64_t start_timestamp() const;

    // Timestamp of the last candle in the buffer (latest date).
    // Throws std::out_of_range if empty.
    int64_t end_timestamp() const;

    // -------------------------------------------------------------------------
    // Timeframe Aggregation
    // -------------------------------------------------------------------------

    // Aggregate the visible history from 1-minute base candles into higher
    // timeframe bars (e.g., 5, 15, 60, 240, 1440 minutes).
    // Returns a new vector — the base data is never mutated.
    std::vector<Candle> aggregate(int minutes) const;

    // Read-only access to the full underlying candle vector.
    const std::vector<Candle>& raw_candles() const noexcept;

private:
    std::vector<Candle> candles_;   // contiguous, sorted by timestamp ascending
    std::size_t cursor_ = 0;       // index into candles_: the "present moment"

    // Internal helper: clamp cursor to valid range after any mutation.
    void clamp_cursor() noexcept;
};
