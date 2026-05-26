#include "candle.hpp"

#include <algorithm>
#include <stdexcept>
#include <cmath>

// =============================================================================
// CandleBuffer — Implementation
// =============================================================================

// -----------------------------------------------------------------------------
// Data Loading
// -----------------------------------------------------------------------------

void CandleBuffer::set_candles(std::vector<Candle> candles) {
    candles_ = std::move(candles);
    cursor_ = 0;
    clamp_cursor();
}

void CandleBuffer::merge_candles(const std::vector<Candle>& new_candles) {
    // Reserve to avoid multiple reallocations during insert.
    candles_.reserve(candles_.size() + new_candles.size());
    candles_.insert(candles_.end(), new_candles.begin(), new_candles.end());

    // Sort the entire buffer by timestamp. std::stable_sort preserves
    // relative order of candles with identical timestamps — the later
    // insertion (newer data) wins after dedup.
    std::stable_sort(candles_.begin(), candles_.end());

    // Deduplicate: when multiple candles share the same timestamp, keep
    // the last one (which is the most recently ingested data).
    // std::unique keeps the *first* of each run of equal elements, so we
    // reverse-iterate to make the last occurrence become the first, then
    // reverse back. Alternative: use a reverse unique. Simpler approach:
    // just use std::unique with a custom overwrite strategy.
    //
    // Since std::stable_sort preserved insertion order for equal timestamps,
    // and we appended new_candles *after* existing candles, the last
    // occurrence of any duplicate timestamp is already the freshest data.
    // We walk backward and unique forward.
    auto new_end = std::unique(candles_.begin(), candles_.end(),
        [](const Candle& a, const Candle& b) {
            return a.timestamp == b.timestamp;
        });
    candles_.erase(new_end, candles_.end());

    cursor_ = 0;
    clamp_cursor();
}

// -----------------------------------------------------------------------------
// Time-Travel Interface
// -----------------------------------------------------------------------------

bool CandleBuffer::advance(std::size_t n) {
    if (candles_.empty() || cursor_ >= candles_.size() - 1) {
        return false;
    }

    const std::size_t max_advance = candles_.size() - 1 - cursor_;
    const std::size_t actual = std::min(n, max_advance);

    if (actual == 0) {
        return false;
    }

    cursor_ += actual;
    return true;
}

bool CandleBuffer::rewind(std::size_t n) {
    if (candles_.empty() || cursor_ == 0) {
        return false;
    }

    const std::size_t actual = std::min(n, cursor_);

    if (actual == 0) {
        return false;
    }

    cursor_ -= actual;
    return true;
}

void CandleBuffer::seek(int64_t target_timestamp) {
    if (candles_.empty()) {
        return;
    }

    // Binary search for the first candle with timestamp >= target_timestamp.
    // We use a sentinel Candle with only the timestamp field set for comparison.
    auto it = std::lower_bound(
        candles_.begin(), candles_.end(), target_timestamp,
        [](const Candle& candle, int64_t ts) {
            return candle.timestamp < ts;
        });

    if (it == candles_.end()) {
        // Target is beyond all data — clamp to last candle.
        cursor_ = candles_.size() - 1;
    } else if (it == candles_.begin()) {
        // Target is at or before the first candle.
        cursor_ = 0;
    } else {
        // lower_bound found the first candle with timestamp >= target.
        // Choose the closer of (it - 1) and it.
        auto prev = it - 1;
        int64_t diff_prev = target_timestamp - prev->timestamp;
        int64_t diff_curr = it->timestamp - target_timestamp;

        if (diff_prev <= diff_curr) {
            cursor_ = static_cast<std::size_t>(std::distance(candles_.begin(), prev));
        } else {
            cursor_ = static_cast<std::size_t>(std::distance(candles_.begin(), it));
        }
    }
}

// -----------------------------------------------------------------------------
// Accessors
// -----------------------------------------------------------------------------

const Candle& CandleBuffer::current() const {
    if (candles_.empty()) {
        throw std::out_of_range("CandleBuffer::current() called on empty buffer");
    }
    return candles_[cursor_];
}

std::span<const Candle> CandleBuffer::visible_history() const {
    if (candles_.empty()) {
        return {};
    }
    // Return a zero-copy span from index 0 through cursor (inclusive).
    return std::span<const Candle>(candles_.data(), cursor_ + 1);
}

std::size_t CandleBuffer::size() const noexcept {
    return candles_.size();
}

std::size_t CandleBuffer::cursor() const noexcept {
    return cursor_;
}

bool CandleBuffer::at_end() const noexcept {
    if (candles_.empty()) {
        return true;
    }
    return cursor_ >= candles_.size() - 1;
}

bool CandleBuffer::empty() const noexcept {
    return candles_.empty();
}

int64_t CandleBuffer::start_timestamp() const {
    if (candles_.empty()) {
        throw std::out_of_range("CandleBuffer::start_timestamp() called on empty buffer");
    }
    return candles_.front().timestamp;
}

int64_t CandleBuffer::end_timestamp() const {
    if (candles_.empty()) {
        throw std::out_of_range("CandleBuffer::end_timestamp() called on empty buffer");
    }
    return candles_.back().timestamp;
}

const std::vector<Candle>& CandleBuffer::raw_candles() const noexcept {
    return candles_;
}

// -----------------------------------------------------------------------------
// Timeframe Aggregation
// -----------------------------------------------------------------------------

std::vector<Candle> CandleBuffer::aggregate(int minutes) const {
    if (minutes <= 0) {
        throw std::invalid_argument("CandleBuffer::aggregate() requires minutes > 0");
    }

    if (minutes == 1) {
        // 1-minute is the base timeframe — just copy the visible history.
        auto history = visible_history();
        return {history.begin(), history.end()};
    }

    auto history = visible_history();
    if (history.empty()) {
        return {};
    }

    const int64_t interval_seconds = static_cast<int64_t>(minutes) * 60;

    std::vector<Candle> result;
    // Pre-allocate a reasonable estimate to avoid repeated reallocation.
    result.reserve(history.size() / static_cast<std::size_t>(minutes) + 1);

    // Compute the alignment boundary for the first candle's timestamp.
    // This ensures aggregated bars align to clean clock boundaries
    // (e.g., 5-min bars start at :00, :05, :10, ...).
    int64_t current_boundary = (history[0].timestamp / interval_seconds) * interval_seconds;

    Candle agg{};
    bool in_bar = false;

    for (const auto& c : history) {
        // Determine which aggregation bucket this candle belongs to.
        int64_t candle_boundary = (c.timestamp / interval_seconds) * interval_seconds;

        if (!in_bar) {
            // Start a new aggregated bar.
            agg.timestamp = candle_boundary;
            agg.open      = c.open;
            agg.high      = c.high;
            agg.low       = c.low;
            agg.close     = c.close;
            agg.volume    = c.volume;
            current_boundary = candle_boundary;
            in_bar = true;
        } else if (candle_boundary != current_boundary) {
            // This candle belongs to a new time bucket — flush the current bar.
            result.push_back(agg);

            // Start the new bar.
            agg.timestamp = candle_boundary;
            agg.open      = c.open;
            agg.high      = c.high;
            agg.low       = c.low;
            agg.close     = c.close;
            agg.volume    = c.volume;
            current_boundary = candle_boundary;
        } else {
            // Same time bucket — merge into the current aggregated bar.
            agg.high   = std::max(agg.high, c.high);
            agg.low    = std::min(agg.low, c.low);
            agg.close  = c.close;
            agg.volume += c.volume;
        }
    }

    // Flush the final (possibly incomplete) bar.
    if (in_bar) {
        result.push_back(agg);
    }

    return result;
}

// -----------------------------------------------------------------------------
// Internal Helpers
// -----------------------------------------------------------------------------

void CandleBuffer::clamp_cursor() noexcept {
    if (candles_.empty()) {
        cursor_ = 0;
    } else if (cursor_ >= candles_.size()) {
        cursor_ = candles_.size() - 1;
    }
}
