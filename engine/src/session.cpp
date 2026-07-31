#include "session.hpp"

#include <algorithm>
#include <chrono>
#include <stdexcept>

// =============================================================================
// SessionManager — Implementation
// =============================================================================

// -----------------------------------------------------------------------------
// Construction / Destruction
// -----------------------------------------------------------------------------

SessionManager::SessionManager()
    : engine_(0.0)   // Will be reset on session start
{
    // Launch the background playback thread. It immediately blocks on the
    // condition variable, waiting for play() to wake it.
    playback_thread_ = std::thread(&SessionManager::playback_loop, this);
}

SessionManager::~SessionManager() {
    // Signal the playback thread to exit and join.
    {
        std::lock_guard<std::mutex> lock(mutex_);
        shutdown_.store(true);
        playing_.store(false);
    }
    cv_.notify_all();

    if (playback_thread_.joinable()) {
        playback_thread_.join();
    }
}

// -----------------------------------------------------------------------------
// Session Lifecycle
// -----------------------------------------------------------------------------

std::size_t SessionManager::start_session(const std::string& symbol,
                                           double starting_balance,
                                           const std::string& data_dir,
                                           const std::string& start_date) {
    std::lock_guard<std::mutex> lock(mutex_);

    // Stop any active playback.
    playing_.store(false);

    // Load market data from CSV files.
    // If the request is date-sliced (YYYY-MM-DD), pass the date prefix to the
    // loader so it can reject non-matching rows by raw timestamp prefix —
    // this avoids strict timestamp equality / timezone-suffix failures.
    CsvLoader::load_into_buffer(buffer_, symbol, data_dir,
                                start_date.size() == 10 ? start_date : "");

    if (buffer_.empty()) {
        throw std::runtime_error(
            "SessionManager::start_session() — no candle data loaded for '" +
            symbol + "'");
    }

    // Initialize the matching engine with fresh capital.
    engine_.reset(starting_balance);
    wire_engine_callbacks();

    // Store session metadata.
    symbol_ = symbol;
    active_ = true;

    // Reset playback defaults.
    speed_.store(1);
    timeframe_.store(1);
    stop_ts_.store(0);

    // ---------------------------------------------------------------------
    // Position the playback cursor at the requested start date.
    //
    // "YYYY-MM-DD" (10 chars) — NEW DATE-SLICE MODE
    //   Filters the buffer to the CLOSED interval
    //   [09:30:00 ET, 16:00:00 ET] on that calendar date, discarding all
    //   other bars.  Cursor lands at index 0 = market open.
    //   parse_timestamp() adds the correct EST/EDT offset internally, so
    //   "09:30:00" becomes the correct UTC epoch for the session open.
    //   Throws if the day has no data (weekend, holiday, outside the
    //   rolling 30-day window).
    //
    // "YYYY-MM-DD HH:MM:SS" (≥19 chars) — LEGACY SEEK MODE
    //   Does NOT slice the buffer.  Just positions the cursor at the
    //   closest candle ≥ that ET timestamp.  Retained for backward compat.
    //
    // Empty string — seek to the very first candle in the full buffer.
    // ---------------------------------------------------------------------
    if (start_date.size() == 10) {
        // Date-slice: keep only core market hours on the requested day.
        int64_t open_ts  = CsvLoader::parse_timestamp(start_date + " 09:30:00");
        int64_t close_ts = CsvLoader::parse_timestamp(start_date + " 16:00:00");

        if (open_ts <= 0 || close_ts <= 0) {
            throw std::runtime_error(
                "SessionManager::start_session() — invalid date string: '" +
                start_date + "'");
        }

        buffer_.filter_to_range(open_ts, close_ts);

        if (buffer_.empty()) {
            throw std::runtime_error(
                "No trading data found for '" + symbol + "' on " + start_date +
                " during core market hours (09:30–16:00 ET). "
                "Verify the date is a valid trading day within the last 30 days.");
        }
        // Cursor is already 0 (market open) — filter_to_range resets it.

    } else if (!start_date.empty()) {
        // Legacy: full datetime string — seek without slicing.
        int64_t epoch = CsvLoader::parse_timestamp(start_date);
        if (epoch > 0) {
            buffer_.seek(epoch);
        } else {
            buffer_.seek(buffer_.start_timestamp());
        }
    } else {
        buffer_.seek(buffer_.start_timestamp());
    }

    // Clear snapshots and create initial snapshot at the seeked cursor
    state_snapshots_.clear();
    create_snapshot_locked();

    return buffer_.size();
}

void SessionManager::stop_session() {
    std::lock_guard<std::mutex> lock(mutex_);

    playing_.store(false);
    active_ = false;
}

bool SessionManager::is_active() const {
    return active_;
}

// -----------------------------------------------------------------------------
// Playback Controls
// -----------------------------------------------------------------------------

bool SessionManager::next_candle() {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_) {
        return false;
    }

    return advance_one_locked();
}

bool SessionManager::rewind_one() {
    std::lock_guard<std::mutex> lock(mutex_);
    return rewind_one_locked();
}

bool SessionManager::rewind_one_locked() {
    if (!active_ || buffer_.cursor() == 0) {
        return false;
    }

    // Step 1: Rewind the buffer cursor by 1
    if (!buffer_.rewind(1)) {
        return false;
    }

    // Step 2: Efficient rewind using state snapshots
    restore_from_snapshot_locked();

    // Fire the candle-advanced callback (server broadcasts to clients).
    if (on_candle_advanced_) {
        CandleAdvancedEvent event{};
        event.candle        = buffer_.current();
        event.cursor        = buffer_.cursor();
        event.total_candles = buffer_.size();
        event.account       = engine_.snapshot();

        on_candle_advanced_(event);
    }

    return true;
}

void SessionManager::reset_to_start() {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_) {
        return;
    }

    // Stop playback
    playing_.store(false);

    // Reset engine to fresh state
    engine_.reset(engine_.starting_balance());
    wire_engine_callbacks();

    // Seek buffer to start
    buffer_.seek(buffer_.start_timestamp());

    // Clear user order snapshot and state snapshots — full reset
    user_orders_snapshot_.clear();
    state_snapshots_.clear();
    create_snapshot_locked();
}

void SessionManager::seek(int64_t target_timestamp) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_) {
        return;
    }

    buffer_.seek(target_timestamp);

    if (on_candle_advanced_) {
        CandleAdvancedEvent event{};
        event.candle        = buffer_.current();
        event.cursor        = buffer_.cursor();
        event.total_candles = buffer_.size();
        event.account       = engine_.snapshot();
        on_candle_advanced_(event);
    }
}

void SessionManager::play() {
    if (!active_) {
        return;
    }

    stop_ts_.store(0);
    playing_.store(true);
    if (on_playing_changed_) on_playing_changed_(*this, true);
    cv_.notify_one();
}

void SessionManager::play_until(int64_t stop_timestamp) {
    if (!active_) {
        return;
    }

    stop_ts_.store(stop_timestamp);
    playing_.store(true);
    if (on_playing_changed_) on_playing_changed_(*this, true);
    cv_.notify_one();
}

void SessionManager::set_stop_timestamp(int64_t stop_timestamp) {
    stop_ts_.store(stop_timestamp);
}

void SessionManager::clear_stop_timestamp() {
    stop_ts_.store(0);
}

void SessionManager::pause() {
    playing_.store(false);
    if (on_playing_changed_) on_playing_changed_(*this, false);
    cv_.notify_one();
}

bool SessionManager::is_playing() const {
    return playing_.load();
}

void SessionManager::set_speed(int candles_per_second) {
    // Clamp speed to [1, 50] range.
    int clamped = std::clamp(candles_per_second, 1, 50);
    speed_.store(clamped);

    // Wake the playback thread so it picks up the new interval immediately.
    cv_.notify_one();
}

int SessionManager::speed() const {
    return speed_.load();
}

void SessionManager::set_direction(PlayDirection dir) {
    direction_.store(dir == PlayDirection::Backward ? 1 : 0);
}

PlayDirection SessionManager::direction() const {
    return direction_.load() == 1 ? PlayDirection::Backward : PlayDirection::Forward;
}

// -----------------------------------------------------------------------------
// Timeframe
// -----------------------------------------------------------------------------

void SessionManager::set_timeframe(int minutes) {
    // Validate: only allow sensible timeframes.
    static constexpr int valid_timeframes[] = {1, 5, 15, 60, 240, 1440};

    bool is_valid = false;
    for (int tf : valid_timeframes) {
        if (minutes == tf) {
            is_valid = true;
            break;
        }
    }

    if (is_valid) {
        timeframe_.store(minutes);
    }
}

int SessionManager::timeframe() const {
    return timeframe_.load();
}

std::vector<Candle> SessionManager::aggregated_visible_history() const {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_ || buffer_.empty()) {
        return {};
    }

    int tf = timeframe_.load();
    return buffer_.aggregate(tf);
}

// -----------------------------------------------------------------------------
// Order Forwarding
// -----------------------------------------------------------------------------

uint64_t SessionManager::place_market_order(Side side, double quantity,
                                             double stop_loss, double take_profit) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_ || buffer_.empty()) {
        return 0;
    }

    // Snapshot for replay: record the user's order at the current timestamp
    Order snapshot{};
    snapshot.side        = side;
    snapshot.type        = OrdType::Market;
    snapshot.entry_price = 0.0;
    snapshot.quantity    = quantity;
    snapshot.stop_loss   = stop_loss;
    snapshot.take_profit = take_profit;
    snapshot.created_at  = buffer_.current().timestamp;
    user_orders_snapshot_.push_back(snapshot);

    return engine_.place_market_order(side, quantity, stop_loss, take_profit,
                                      buffer_.current());
}

uint64_t SessionManager::place_limit_order(Side side, double entry_price,
                                            double quantity,
                                            double stop_loss, double take_profit) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_ || buffer_.empty()) {
        return 0;
    }

    // Snapshot for replay
    Order snapshot{};
    snapshot.side        = side;
    snapshot.type        = OrdType::Limit;
    snapshot.entry_price = entry_price;
    snapshot.quantity    = quantity;
    snapshot.stop_loss   = stop_loss;
    snapshot.take_profit = take_profit;
    snapshot.created_at  = buffer_.current().timestamp;
    user_orders_snapshot_.push_back(snapshot);

    return engine_.place_limit_order(side, entry_price, quantity,
                                     stop_loss, take_profit,
                                     buffer_.current().timestamp);
}

uint64_t SessionManager::place_stop_order(Side side, double entry_price,
                                           double quantity,
                                           double stop_loss, double take_profit) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_ || buffer_.empty()) {
        return 0;
    }

    // Snapshot for replay
    Order snapshot{};
    snapshot.side        = side;
    snapshot.type        = OrdType::Stop;
    snapshot.entry_price = entry_price;
    snapshot.quantity    = quantity;
    snapshot.stop_loss   = stop_loss;
    snapshot.take_profit = take_profit;
    snapshot.created_at  = buffer_.current().timestamp;
    user_orders_snapshot_.push_back(snapshot);

    return engine_.place_stop_order(side, entry_price, quantity,
                                    stop_loss, take_profit,
                                    buffer_.current().timestamp);
}

bool SessionManager::cancel_order(uint64_t order_id) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_) {
        return false;
    }

    return engine_.cancel_order(order_id);
}

bool SessionManager::close_position(uint64_t position_id) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_ || buffer_.empty()) {
        return false;
    }

    return engine_.close_position(position_id, buffer_.current().close,
                                   buffer_.current().timestamp);
}

bool SessionManager::update_position_sltp(uint64_t position_id, double stop_loss, double take_profit) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_ || buffer_.empty()) {
        return false;
    }

    return engine_.update_position_sltp(position_id, stop_loss, take_profit);
}

// -----------------------------------------------------------------------------
// Accessors
// -----------------------------------------------------------------------------

const std::string& SessionManager::symbol() const {
    return symbol_;
}

Candle SessionManager::current_candle() const {
    std::lock_guard<std::mutex> lock(mutex_);

    if (!active_ || buffer_.empty()) {
        throw std::runtime_error("SessionManager::current_candle() — no active session");
    }

    return buffer_.current();
}

std::size_t SessionManager::cursor() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return buffer_.cursor();
}

std::size_t SessionManager::total_candles() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return buffer_.size();
}

AccountSnapshot SessionManager::account_snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return engine_.snapshot();
}

std::vector<Position> SessionManager::open_positions() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return engine_.open_positions();
}

std::vector<Order> SessionManager::pending_orders() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return engine_.pending_orders();
}

std::vector<ClosedTrade> SessionManager::trade_history() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return engine_.trade_history();
}

int64_t SessionManager::start_timestamp() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return buffer_.start_timestamp();
}

int64_t SessionManager::end_timestamp() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return buffer_.end_timestamp();
}

// -----------------------------------------------------------------------------
// Event Callbacks
// -----------------------------------------------------------------------------

void SessionManager::set_on_candle_advanced(OnCandleAdvanced callback) {
    std::lock_guard<std::mutex> lock(mutex_);
    on_candle_advanced_ = std::move(callback);
}

void SessionManager::set_on_playing_changed(OnPlayingChanged callback) {
    std::lock_guard<std::mutex> lock(mutex_);
    on_playing_changed_ = std::move(callback);
}

void SessionManager::set_on_order_filled(MatchingEngine::OnOrderFilled callback) {
    std::lock_guard<std::mutex> lock(mutex_);
    on_order_filled_ = std::move(callback);
    if (active_) {
        engine_.set_on_order_filled(on_order_filled_);
    }
}

void SessionManager::set_on_position_closed(MatchingEngine::OnPositionClosed callback) {
    std::lock_guard<std::mutex> lock(mutex_);
    on_position_closed_ = std::move(callback);
    if (active_) {
        engine_.set_on_position_closed(on_position_closed_);
    }
}

// -----------------------------------------------------------------------------
// Internal: Wire Engine Callbacks
// -----------------------------------------------------------------------------

void SessionManager::wire_engine_callbacks() {
    // Forward matching engine events through the callbacks the server set.
    if (on_order_filled_) {
        engine_.set_on_order_filled(on_order_filled_);
    }
    if (on_position_closed_) {
        engine_.set_on_position_closed(on_position_closed_);
    }
    // We handle account updates ourselves via advance_one_locked(),
    // so we don't set on_account_update on the engine.
}

// -----------------------------------------------------------------------------
// Internal: Fast-Forward Re-run
//
// Resets the matching engine to starting balance, then replays all candles
// from index 0 through the current buffer cursor. User-placed orders are
// re-submitted at their original timestamps so that fills, SL/TP triggers,
// and PnL calculations are perfectly reconstructed.
//
// Orders placed AFTER the current cursor time are discarded.
// Callbacks are suppressed during replay to avoid spamming WebSocket events.
// Precondition: caller holds mutex_.
// -----------------------------------------------------------------------------

void SessionManager::replay_to_cursor_locked() {
    const std::size_t target_cursor = buffer_.cursor();
    const int64_t target_ts = buffer_.current().timestamp;

    // Filter user orders: only keep those placed at or before the target time
    std::vector<Order> valid_orders;
    for (const auto& o : user_orders_snapshot_) {
        if (o.created_at <= target_ts) {
            valid_orders.push_back(o);
        }
    }
    user_orders_snapshot_ = valid_orders;

    // Sort valid orders by created_at for efficient replay
    std::sort(valid_orders.begin(), valid_orders.end(),
        [](const Order& a, const Order& b) { return a.created_at < b.created_at; });

    // Reset engine to clean slate
    engine_.reset(engine_.starting_balance());

    // Suppress callbacks during replay (avoid spamming the WS connection)
    engine_.set_on_order_filled(nullptr);
    engine_.set_on_position_closed(nullptr);
    engine_.set_on_account_update(nullptr);

    // Seek buffer to start
    buffer_.seek(buffer_.start_timestamp());

    // Replay loop: advance from candle 0 to target_cursor
    std::size_t order_idx = 0;
    for (std::size_t i = 0; i <= target_cursor; ++i) {
        const Candle& candle = buffer_.current();

        // Re-place any user orders that were created at this candle's timestamp
        while (order_idx < valid_orders.size() &&
               valid_orders[order_idx].created_at == candle.timestamp) {
            const Order& o = valid_orders[order_idx];
            switch (o.type) {
                case OrdType::Market:
                    engine_.place_market_order(o.side, o.quantity,
                                               o.stop_loss, o.take_profit, candle);
                    break;
                case OrdType::Limit:
                    engine_.place_limit_order(o.side, o.entry_price, o.quantity,
                                              o.stop_loss, o.take_profit,
                                              candle.timestamp);
                    break;
                case OrdType::Stop:
                    engine_.place_stop_order(o.side, o.entry_price, o.quantity,
                                             o.stop_loss, o.take_profit,
                                             candle.timestamp);
                    break;
            }
            ++order_idx;
        }

        // Run the matching engine on this candle (fills pending, checks SL/TP)
        engine_.on_candle(candle);

        // Advance buffer to next candle (except on the last iteration)
        if (i < target_cursor) {
            buffer_.advance(1);
        }
    }

    // Restore callbacks
    wire_engine_callbacks();
}

// -----------------------------------------------------------------------------
// Internal: Create State Snapshot
//
// Captures the current engine state (balance, positions, orders, trades)
// and stores it in the snapshot vector at the current cursor position.
// Precondition: caller holds mutex_.
// -----------------------------------------------------------------------------

void SessionManager::create_snapshot_locked() {
    StateSnapshot snapshot;
    snapshot.cursor = buffer_.cursor();
    snapshot.balance = engine_.starting_balance();
    snapshot.positions = engine_.open_positions();
    snapshot.pending_orders = engine_.pending_orders();
    snapshot.trade_history = engine_.trade_history();
    snapshot.user_orders = user_orders_snapshot_;
    
    state_snapshots_.push_back(std::move(snapshot));
}

// -----------------------------------------------------------------------------
// Internal: Restore from Snapshot
//
// Finds the nearest snapshot before the current cursor, restores the engine
// to that state, then replays only the delta (snapshot cursor → current cursor).
// This is much faster than replaying from 0 for large datasets.
// Precondition: caller holds mutex_.
// -----------------------------------------------------------------------------

void SessionManager::restore_from_snapshot_locked() {
    const std::size_t target_cursor = buffer_.cursor();
    
    // Find the most recent snapshot at or before the target cursor
    auto it = std::find_if(state_snapshots_.rbegin(), state_snapshots_.rend(),
        [target_cursor](const StateSnapshot& snap) {
            return snap.cursor <= target_cursor;
        });
    
    if (it != state_snapshots_.rend()) {
        // Found a snapshot - restore from it
        const StateSnapshot& snapshot = *it;
        
        // Restore engine state directly from snapshot (fast path)
        engine_.restore_state(snapshot.balance, snapshot.positions, 
                              snapshot.pending_orders, snapshot.trade_history);
        
        // Restore user orders snapshot
        user_orders_snapshot_ = snapshot.user_orders;
        
        // Seek buffer to snapshot cursor
        buffer_.seek(buffer_.start_timestamp());
        for (std::size_t i = 0; i < snapshot.cursor; ++i) {
            buffer_.advance(1);
        }
        
        // Replay only the delta from snapshot cursor to target cursor
        // This is the key optimization - we only replay at most SNAPSHOT_INTERVAL candles
        const std::size_t delta = target_cursor - snapshot.cursor;
        for (std::size_t i = 0; i < delta; ++i) {
            if (!buffer_.advance(1)) break;
            
            // Re-place any user orders that were created at this candle's timestamp
            for (const auto& o : user_orders_snapshot_) {
                if (o.created_at == buffer_.current().timestamp) {
                    switch (o.type) {
                        case OrdType::Market:
                            engine_.place_market_order(o.side, o.quantity,
                                                       o.stop_loss, o.take_profit, buffer_.current());
                            break;
                        case OrdType::Limit:
                            engine_.place_limit_order(o.side, o.entry_price, o.quantity,
                                                      o.stop_loss, o.take_profit,
                                                      buffer_.current().timestamp);
                            break;
                        case OrdType::Stop:
                            engine_.place_stop_order(o.side, o.entry_price, o.quantity,
                                                     o.stop_loss, o.take_profit,
                                                     buffer_.current().timestamp);
                            break;
                    }
                }
            }
            
            // Run the matching engine on this candle
            engine_.on_candle(buffer_.current());
        }
    } else {
        // No snapshot available - fall back to full replay from 0
        replay_to_cursor_locked();
    }
}

// -----------------------------------------------------------------------------
// Internal: Advance One Candle (under lock)
//
// Moves the cursor forward by one bar, runs the matching engine on the new
// candle, and fires the on_candle_advanced callback with a full state snapshot.
// Returns false if already at end.
// Precondition: caller holds mutex_.
// -----------------------------------------------------------------------------

bool SessionManager::advance_one_locked() {
    if (buffer_.at_end()) {
        playing_.store(false);
        return false;
    }

    if (!buffer_.advance(1)) {
        playing_.store(false);
        return false;
    }

    // Run the matching engine on the newly revealed candle.
    const Candle& candle = buffer_.current();
    engine_.on_candle(candle);

    // Fire the candle-advanced callback (server broadcasts to clients).
    if (on_candle_advanced_) {
        CandleAdvancedEvent event{};
        event.candle        = candle;
        event.cursor        = buffer_.cursor();
        event.total_candles = buffer_.size();
        event.account       = engine_.snapshot();

        on_candle_advanced_(event);
    }

    // Create snapshot at regular intervals for efficient rewind
    const std::size_t cursor = buffer_.cursor();
    if (cursor % SNAPSHOT_INTERVAL == 0) {
        create_snapshot_locked();
    }

    return true;
}

// -----------------------------------------------------------------------------
// Internal: Playback Loop (background thread)
//
// This function runs on a dedicated std::thread for the entire lifetime of the
// SessionManager. It blocks on a condition_variable when paused, and advances
// one candle per tick when playing, sleeping (1000ms / speed) between ticks.
//
// The loop respects three signals:
//   - shutdown_:  exit the thread (destructor sets this)
//   - playing_:   advance candles (play/pause toggle)
//   - speed_:     adjust sleep interval (set_speed changes this)
// -----------------------------------------------------------------------------

void SessionManager::playback_loop() {
    while (!shutdown_.load()) {
        // Block until we should be playing or shutting down.
        {
            std::unique_lock<std::mutex> lock(mutex_);
            cv_.wait(lock, [this] {
                return shutdown_.load() || playing_.load();
            });
        }

        if (shutdown_.load()) {
            break;
        }

        // Auto-play loop: advance one candle, sleep, repeat.
        while (playing_.load() && !shutdown_.load()) {
            // Compute sleep duration from current speed setting.
            int current_speed = speed_.load();
            if (current_speed < 1) current_speed = 1;

            auto sleep_duration = std::chrono::milliseconds(1000 / current_speed);

            {
                std::lock_guard<std::mutex> lock(mutex_);

                if (!active_) {
                    playing_.store(false);
                    break;
                }

                // Check playback direction and call appropriate step function
                bool stepped = false;
                if (direction_.load() == 1) {
                    // Backward playback
                    if (buffer_.cursor() == 0) {
                        playing_.store(false);
                        break;
                    }

                    const int64_t stop = stop_ts_.load();
                    if (stop > 0 && buffer_.current().timestamp <= stop) {
                        playing_.store(false);
                        break;
                    }

                    stepped = rewind_one_locked();

                    if (stepped && stop > 0 && buffer_.current().timestamp <= stop) {
                        playing_.store(false);
                        break;
                    }
                } else {
                    // Forward playback
                    const int64_t stop = stop_ts_.load();
                    if (buffer_.at_end()) {
                        playing_.store(false);
                        break;
                    }

                    // Stop guard: if the current candle is already at or past the
                    // requested stop timestamp, halt playback before advancing.
                    if (stop > 0 && buffer_.current().timestamp >= stop) {
                        playing_.store(false);
                        break;
                    }

                    stepped = advance_one_locked();

                    // After stepping, check again so the last emitted candle is the
                    // first one at or past the stop timestamp.
                    if (stepped && stop > 0 && buffer_.current().timestamp >= stop) {
                        playing_.store(false);
                        break;
                    }
                }

                // Stop if we couldn't step (reached boundary)
                if (!stepped) {
                    playing_.store(false);
                    break;
                }
            }

            // Sleep outside the lock to allow other operations (orders, etc.)
            // to proceed while we wait for the next tick.
            //
            // Use condition_variable wait_for instead of raw sleep so that
            // speed changes, pause, and shutdown can interrupt the sleep.
            {
                std::unique_lock<std::mutex> lock(mutex_);
                cv_.wait_for(lock, sleep_duration, [this] {
                    return shutdown_.load() || !playing_.load();
                });
            }
        }

        // If this thread drove the transition to stopped, fire the callback
        // outside the lock so server-side state snapshots can't deadlock.
        if (!shutdown_.load() && on_playing_changed_) {
            on_playing_changed_(*this, playing_.load());
        }
    }
}
