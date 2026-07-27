#pragma once

#include "candle.hpp"
#include <cstdint>
#include <vector>
#include <optional>
#include <string>
#include <functional>

// =============================================================================
// Enumerations
// =============================================================================

// Trade direction.
enum class Side { Buy, Sell };

// Order classification.
//   Market — fill immediately at current candle close.
//   Limit  — fill when price reaches a more favorable level.
//   Stop   — fill when price breaches a less favorable level (breakout entry).
enum class OrdType { Market, Limit, Stop };

// Lifecycle status of an order.
enum class OrdStatus {
    Pending,        // Limit/Stop order waiting for trigger conditions
    Filled,         // Order executed — a Position was opened
    Cancelled,      // Order removed by the user before execution
    StopLossHit,    // Position closed because the SL price was breached
    TakeProfitHit   // Position closed because the TP price was breached
};

// Reason a position was closed — used in events emitted to the frontend.
enum class CloseReason { StopLoss, TakeProfit, Manual };

// =============================================================================
// String conversion utilities (for JSON serialization in the network layer)
// =============================================================================

inline const char* to_string(Side s) {
    return s == Side::Buy ? "buy" : "sell";
}

inline const char* to_string(OrdType t) {
    switch (t) {
        case OrdType::Market: return "market";
        case OrdType::Limit:  return "limit";
        case OrdType::Stop:   return "stop";
    }
    return "unknown";
}

inline const char* to_string(OrdStatus s) {
    switch (s) {
        case OrdStatus::Pending:       return "pending";
        case OrdStatus::Filled:        return "filled";
        case OrdStatus::Cancelled:     return "cancelled";
        case OrdStatus::StopLossHit:   return "stop_loss_hit";
        case OrdStatus::TakeProfitHit: return "take_profit_hit";
    }
    return "unknown";
}

inline const char* to_string(CloseReason r) {
    switch (r) {
        case CloseReason::StopLoss:   return "sl";
        case CloseReason::TakeProfit: return "tp";
        case CloseReason::Manual:     return "manual";
    }
    return "unknown";
}

// =============================================================================
// Order — A request to open a position at a given price.
// =============================================================================
struct Order {
    uint64_t              id;            // Unique order ID assigned by the engine
    Side                  side;          // Buy or Sell
    OrdType               type;          // Market, Limit, or Stop
    double                entry_price;   // Desired fill price (Market = 0, filled at close)
    double                stop_loss;     // Protective SL for the resulting position (0 = none)
    double                take_profit;   // Profit target for the resulting position (0 = none)
    double                quantity;      // Number of units (shares, lots, coins)
    OrdStatus             status;        // Current lifecycle status
    int64_t               created_at;    // Timestamp when the order was submitted
    int64_t               filled_at;     // Timestamp when the order was executed (0 if unfilled)
    std::optional<double> fill_price;    // Actual execution price (nullopt if unfilled)
};

// =============================================================================
// Position — An active trade with an entry, SL, TP, and floating P&L.
// =============================================================================
struct Position {
    uint64_t id;            // Matches the Order.id that opened this position
    Side     side;          // Direction of the trade
    double   entry_price;   // Actual fill price at entry
    double   quantity;      // Size of the position
    double   stop_loss;     // Current stop loss price (0 = none)
    double   take_profit;   // Current take profit price (0 = none)
    int64_t  opened_at;     // Timestamp when the position was opened

    // Compute unrealized profit/loss at a given mark-to-market price.
    //   Buy:  (current_price - entry_price) × quantity
    //   Sell: (entry_price - current_price) × quantity
    double unrealized_pnl(double current_price) const noexcept {
        double delta = (side == Side::Buy)
            ? (current_price - entry_price)
            : (entry_price - current_price);
        return delta * quantity;
    }
};

// =============================================================================
// ClosedTrade — Snapshot of a position that has been exited, for history.
// =============================================================================
struct ClosedTrade {
    uint64_t    id;             // Matches the Position/Order id
    Side        side;
    double      entry_price;
    double      exit_price;
    double      quantity;
    double      realized_pnl;   // Signed P&L: positive = profit, negative = loss
    double      stop_loss;      // Protective stop at entry (0 = none)
    double      take_profit;    // Profit target at entry (0 = none)
    CloseReason reason;
    int64_t     opened_at;
    int64_t     closed_at;
};

// =============================================================================
// Event types — callbacks the engine fires so the network layer can broadcast.
// =============================================================================
struct OrderFilledEvent {
    uint64_t order_id;
    Side     side;
    OrdType  type;
    double   fill_price;
    double   quantity;
    int64_t  timestamp;
};

struct PositionClosedEvent {
    uint64_t    position_id;
    Side        side;
    double      entry_price;
    double      exit_price;
    double      quantity;
    double      realized_pnl;
    double      stop_loss;
    double      take_profit;
    int64_t     opened_at;
    CloseReason reason;
    int64_t     timestamp;
};

struct AccountSnapshot {
    double   balance;
    double   equity;
    size_t   open_position_count;
    size_t   pending_order_count;
};

// =============================================================================
// MatchingEngine — The financial core of OpenRewind.
//
// Simulates a simplified exchange matching engine. Processes one candle at a
// time via on_candle(), checking pending orders and open positions against
// the candle's OHLC bounds.
//
// Key design rule: PESSIMISTIC FILL.
// When a single candle's range triggers both a position's SL and TP, the
// engine always executes the Stop Loss first. This prevents inflated backtest
// results from assuming favorable execution during violent price action.
//
// Thread safety: NOT thread-safe. Designed for single-session, single-thread
// operation. The Crow server serializes access through WebSocket commands.
// =============================================================================
class MatchingEngine {
public:
    // Callback types for engine events.
    using OnOrderFilled    = std::function<void(const OrderFilledEvent&)>;
    using OnPositionClosed = std::function<void(const PositionClosedEvent&)>;
    using OnAccountUpdate  = std::function<void(const AccountSnapshot&)>;

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    // Construct a new engine with the given starting capital.
    explicit MatchingEngine(double starting_balance);

    // Reset all state back to initial conditions.
    void reset(double starting_balance);

    // Restore engine state from saved vectors (for snapshot rewind).
    // This is more efficient than replaying from scratch.
    void restore_state(double balance,
                      const std::vector<Position>& positions,
                      const std::vector<Order>& pending_orders,
                      const std::vector<ClosedTrade>& trade_history);

    // -------------------------------------------------------------------------
    // Order Placement
    // -------------------------------------------------------------------------

    // Place a market order — fills immediately at the current candle's close.
    // `current_candle` is the candle visible to the user at the moment of placement.
    // Returns the assigned order ID.
    uint64_t place_market_order(Side side, double quantity,
                                double stop_loss, double take_profit,
                                const Candle& current_candle);

    // Place a limit order — queued until price reaches the entry level.
    //   Limit Buy:  triggers when candle.low  <= entry_price
    //   Limit Sell: triggers when candle.high >= entry_price
    // Returns the assigned order ID.
    uint64_t place_limit_order(Side side, double entry_price, double quantity,
                               double stop_loss, double take_profit,
                               int64_t created_at);

    // Place a stop order — queued until price breaches the entry level.
    //   Stop Buy:  triggers when candle.high >= entry_price
    //   Stop Sell: triggers when candle.low  <= entry_price
    // Returns the assigned order ID.
    uint64_t place_stop_order(Side side, double entry_price, double quantity,
                              double stop_loss, double take_profit,
                              int64_t created_at);

    // Cancel a pending (Limit/Stop) order by ID.
    // Returns true if the order was found and cancelled, false otherwise.
    bool cancel_order(uint64_t order_id);

    // Manually close an open position by ID at a given price.
    // Returns true if the position was found and closed.
    bool close_position(uint64_t position_id, double exit_price, int64_t timestamp);

    // Update stop loss and take profit for an open position.
    // Returns true if the position was found and updated.
    bool update_position_sltp(uint64_t position_id, double stop_loss, double take_profit);

    // -------------------------------------------------------------------------
    // Candle Processing — the critical path
    // -------------------------------------------------------------------------

    // Process one new candle. This is called every time the replay cursor
    // advances. Executes the 4-step matching pipeline:
    //   1. Check pending Limit/Stop orders for trigger conditions
    //   2. Check open positions for SL/TP breaches (pessimistic fill)
    //   3. Recalculate floating equity
    //   4. Fire events via callbacks
    void on_candle(const Candle& candle);

    // -------------------------------------------------------------------------
    // Accessors
    // -------------------------------------------------------------------------

    double                         balance()         const noexcept;
    double                         equity()          const noexcept;
    double                         starting_balance() const noexcept;
    const std::vector<Position>&   open_positions()  const noexcept;
    const std::vector<Order>&      pending_orders()  const noexcept;
    const std::vector<Order>&      order_history()   const noexcept;
    const std::vector<ClosedTrade>& trade_history()  const noexcept;
    AccountSnapshot                snapshot()        const noexcept;

    // Total realized P&L across all closed trades.
    double total_realized_pnl() const noexcept;

    // Total unrealized P&L across all open positions at a given price.
    double total_unrealized_pnl(double current_price) const noexcept;

    // -------------------------------------------------------------------------
    // Event Callbacks
    // -------------------------------------------------------------------------

    void set_on_order_filled(OnOrderFilled callback);
    void set_on_position_closed(OnPositionClosed callback);
    void set_on_account_update(OnAccountUpdate callback);

private:
    // --- Account State ---
    double starting_balance_;
    double balance_;        // Cash after all realized P&L
    double equity_;         // balance_ + sum(unrealized P&L)

    // --- Collections ---
    std::vector<Position>    open_positions_;
    std::vector<Order>       pending_orders_;
    std::vector<Order>       order_history_;    // Filled + Cancelled orders
    std::vector<ClosedTrade> trade_history_;    // Closed position records

    // --- ID Generator ---
    uint64_t next_order_id_ = 1;

    // --- Event Callbacks ---
    OnOrderFilled    on_order_filled_;
    OnPositionClosed on_position_closed_;
    OnAccountUpdate  on_account_update_;

    // --- Internal Methods ---

    // Fill a pending order: create a Position, archive the Order, fire events.
    void fill_order(Order& order, double fill_price, int64_t timestamp);

    // Close a position: compute realized P&L, update balance, archive, fire events.
    void close_position_internal(std::vector<Position>::iterator it,
                                 double exit_price, CloseReason reason,
                                 int64_t timestamp);

    // Recalculate equity from balance + unrealized P&L at a given mark price.
    void update_equity(double current_price) noexcept;

    // Fire the account snapshot callback if registered.
    void emit_account_update();
};
