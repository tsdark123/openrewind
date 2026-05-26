#pragma once

#include "candle.hpp"
#include "csv_loader.hpp"
#include "matching.hpp"

#include <string>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <functional>
#include <vector>

// =============================================================================
// SessionManager — Orchestrates the replay session lifecycle.
//
// Owns a CandleBuffer (the market data) and a MatchingEngine (the financial
// ledger). Manages playback state: play/pause, speed, timeframe. Drives the
// auto-play background thread that advances the chart cursor and runs the
// matching pipeline on each new candle.
//
// Thread model:
//   - The main thread (Crow request handlers) calls command methods.
//   - A dedicated playback thread runs the auto-advance loop.
//   - All shared state is protected by a single mutex.
//   - The condition_variable wakes the playback thread on play/pause/speed
//     changes and signals shutdown.
//
// The SessionManager does NOT know about Crow, WebSockets, or JSON.
// It communicates outward through typed callback functions that the server
// layer wires up to broadcast events.
// =============================================================================

// Playback direction for bidirectional auto-play.
enum class PlayDirection { Forward, Backward };

// Callback fired after each candle advance (manual or auto-play).
// The server layer uses this to push candle_update + account_snapshot to clients.
struct CandleAdvancedEvent {
    Candle      candle;          // The newly revealed candle
    std::size_t cursor;          // Current cursor index
    std::size_t total_candles;   // Total candles in the buffer
    AccountSnapshot account;     // Account state after matching
};

class SessionManager {
public:
    using OnCandleAdvanced = std::function<void(const CandleAdvancedEvent&)>;

    SessionManager();
    ~SessionManager();

    // -------------------------------------------------------------------------
    // Session Lifecycle
    // -------------------------------------------------------------------------

    // Start a new session: load CSV data for the given symbol, initialize the
    // matching engine with the starting balance, and reset all playback state.
    // Returns the total number of candles loaded.
    // Throws std::runtime_error if data cannot be loaded.
    std::size_t start_session(const std::string& symbol,
                              double starting_balance,
                              const std::string& data_dir = "data");

    // Stop the current session: pause playback, return summary stats.
    // Safe to call even if no session is active.
    void stop_session();

    // Is a session currently active (data loaded)?
    bool is_active() const;

    // -------------------------------------------------------------------------
    // Playback Controls
    // -------------------------------------------------------------------------

    // Advance the cursor by one candle, run the matching engine, and fire
    // the on_candle_advanced callback. Returns false if already at end.
    bool next_candle();

    // Rewind the cursor by one candle. Uses Fast-Forward Re-run:
    // resets engine, rewinds buffer, then replays from 0 → new cursor
    // re-placing any user orders that existed before the new cursor time.
    // Returns false if already at start.
    bool rewind_one();

    // Reset the entire session to candle 0 with a fresh engine.
    // Stops playback, clears all positions/orders/trades.
    void reset_to_start();

    // Jump to the candle closest to the given timestamp.
    void seek(int64_t target_timestamp);

    // Start auto-play: the background thread advances candles at the
    // configured speed until paused or the data ends.
    void play();

    // Pause auto-play.
    void pause();

    // Is auto-play currently running?
    bool is_playing() const;

    // Set playback speed in candles per second (1–50). Clamped to range.
    void set_speed(int candles_per_second);

    // Get current playback speed.
    int speed() const;

    // Set playback direction (forward or backward).
    void set_direction(PlayDirection dir);

    // Get current playback direction.
    PlayDirection direction() const;

    // -------------------------------------------------------------------------
    // Timeframe
    // -------------------------------------------------------------------------

    // Set the display timeframe in minutes (1, 5, 15, 60, 240, 1440).
    // This controls what aggregate() returns — the base data is always 1-min.
    void set_timeframe(int minutes);

    // Get current display timeframe.
    int timeframe() const;

    // Get aggregated candles for the current visible history at the current
    // timeframe setting.
    std::vector<Candle> aggregated_visible_history() const;

    // -------------------------------------------------------------------------
    // Order Forwarding (delegates to MatchingEngine)
    // -------------------------------------------------------------------------

    uint64_t place_market_order(Side side, double quantity,
                                double stop_loss, double take_profit);

    uint64_t place_limit_order(Side side, double entry_price, double quantity,
                               double stop_loss, double take_profit);

    uint64_t place_stop_order(Side side, double entry_price, double quantity,
                              double stop_loss, double take_profit);

    bool cancel_order(uint64_t order_id);

    bool close_position(uint64_t position_id);

    bool update_position_sltp(uint64_t position_id, double stop_loss, double take_profit);

    // -------------------------------------------------------------------------
    // Accessors (thread-safe snapshots)
    // -------------------------------------------------------------------------

    const std::string& symbol() const;

    // Get the current candle. Throws if no session is active.
    Candle current_candle() const;

    std::size_t cursor() const;
    std::size_t total_candles() const;

    AccountSnapshot account_snapshot() const;

    std::vector<Position>    open_positions() const;
    std::vector<Order>       pending_orders() const;
    std::vector<ClosedTrade> trade_history() const;

    int64_t start_timestamp() const;
    int64_t end_timestamp() const;

    // -------------------------------------------------------------------------
    // Event Callbacks (set by the server layer)
    // -------------------------------------------------------------------------

    void set_on_candle_advanced(OnCandleAdvanced callback);

    // These are forwarded directly to the MatchingEngine.
    void set_on_order_filled(MatchingEngine::OnOrderFilled callback);
    void set_on_position_closed(MatchingEngine::OnPositionClosed callback);

private:
    // --- Core Components ---
    CandleBuffer   buffer_;
    MatchingEngine engine_;
    std::string    symbol_;
    bool           active_ = false;

    // --- Playback State ---
    std::atomic<bool> playing_{false};
    std::atomic<int>  speed_{1};        // candles per second
    std::atomic<int>  timeframe_{1};    // aggregation minutes
    std::atomic<int>  direction_{0};    // 0 = forward, 1 = backward

    // --- Background Playback Thread ---
    std::thread             playback_thread_;
    mutable std::mutex      mutex_;
    std::condition_variable cv_;
    std::atomic<bool>       shutdown_{false};

    // --- Event Callbacks ---
    OnCandleAdvanced                   on_candle_advanced_;
    MatchingEngine::OnOrderFilled      on_order_filled_;
    MatchingEngine::OnPositionClosed   on_position_closed_;

    // --- Internal ---

    // The playback thread's main loop function.
    void playback_loop();

    // Advance one candle under the lock, run matching, fire events.
    // Returns false if at end. Caller must hold mutex_.
    bool advance_one_locked();

    // Rewind one candle under the lock, run replay, fire events.
    // Returns false if at start. Caller must hold mutex_.
    bool rewind_one_locked();

    // Fast-Forward Re-run: reset engine, then replay candles 0 → cursor,
    // re-placing user orders at their original timestamps.
    // Caller must hold mutex_.
    void replay_to_cursor_locked();

    // Create a state snapshot at the current cursor position.
    // Caller must hold mutex_.
    void create_snapshot_locked();

    // Restore engine state from the nearest snapshot and replay delta.
    // Caller must hold mutex_.
    void restore_from_snapshot_locked();

    // Wire up matching engine callbacks to forward through our own callbacks.
    void wire_engine_callbacks();

    // Snapshot of user-placed orders (for replay after rewind).
    std::vector<Order> user_orders_snapshot_;

    // --- State Snapshot System for Efficient Rewind ---
    
    // Snapshot of engine state at regular intervals for fast rewind.
    struct StateSnapshot {
        std::size_t cursor;                          // Cursor position when snapshot was taken
        double balance;                              // Account balance at this point
        std::vector<Position> positions;              // All open positions
        std::vector<Order> pending_orders;            // All pending orders
        std::vector<ClosedTrade> trade_history;      // Trade history up to this point
        std::vector<Order> user_orders;              // User orders placed up to this point
    };
    
    std::vector<StateSnapshot> state_snapshots_;      // Snapshots for fast rewind
    static constexpr std::size_t SNAPSHOT_INTERVAL = 100; // Create snapshot every 100 candles
};
