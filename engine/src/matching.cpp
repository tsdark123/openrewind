#include "matching.hpp"

#include <algorithm>
#include <numeric>
#include <cmath>

// =============================================================================
// MatchingEngine — Implementation
// =============================================================================

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

MatchingEngine::MatchingEngine(double starting_balance)
    : starting_balance_(starting_balance)
    , balance_(starting_balance)
    , equity_(starting_balance)
    , next_order_id_(1)
{
}

void MatchingEngine::reset(double starting_balance) {
    starting_balance_ = starting_balance;
    balance_          = starting_balance;
    equity_           = starting_balance;
    next_order_id_    = 1;

    open_positions_.clear();
    pending_orders_.clear();
    order_history_.clear();
    trade_history_.clear();
}

void MatchingEngine::restore_state(double balance,
                                   const std::vector<Position>& positions,
                                   const std::vector<Order>& pending_orders,
                                   const std::vector<ClosedTrade>& trade_history) {
    starting_balance_ = balance;
    balance_          = balance;
    equity_           = balance;
    
    // Calculate next_order_id_ from max of all IDs in the restored state
    uint64_t max_id = 0;
    for (const auto& pos : positions) {
        max_id = std::max(max_id, pos.id);
    }
    for (const auto& ord : pending_orders) {
        max_id = std::max(max_id, ord.id);
    }
    for (const auto& trade : trade_history) {
        max_id = std::max(max_id, trade.id);
    }
    next_order_id_ = max_id + 1;

    open_positions_ = positions;
    pending_orders_ = pending_orders;
    trade_history_ = trade_history;
    
    // order_history_ is not needed for replay, but we can reconstruct it if needed
    order_history_.clear();
}

// -----------------------------------------------------------------------------
// Order Placement
// -----------------------------------------------------------------------------

uint64_t MatchingEngine::place_market_order(Side side, double quantity,
                                             double stop_loss, double take_profit,
                                             const Candle& current_candle) {
    uint64_t id = next_order_id_++;

    Order order{};
    order.id          = id;
    order.side        = side;
    order.type        = OrdType::Market;
    order.entry_price = 0.0;    // Market orders have no target price
    order.stop_loss   = stop_loss;
    order.take_profit = take_profit;
    order.quantity    = quantity;
    order.status      = OrdStatus::Pending;
    order.created_at  = current_candle.timestamp;
    order.filled_at   = 0;
    order.fill_price  = std::nullopt;

    // Market orders fill immediately at the current candle's close price.
    fill_order(order, current_candle.close, current_candle.timestamp);

    return id;
}

uint64_t MatchingEngine::place_limit_order(Side side, double entry_price,
                                            double quantity,
                                            double stop_loss, double take_profit,
                                            int64_t created_at) {
    uint64_t id = next_order_id_++;

    Order order{};
    order.id          = id;
    order.side        = side;
    order.type        = OrdType::Limit;
    order.entry_price = entry_price;
    order.stop_loss   = stop_loss;
    order.take_profit = take_profit;
    order.quantity    = quantity;
    order.status      = OrdStatus::Pending;
    order.created_at  = created_at;
    order.filled_at   = 0;
    order.fill_price  = std::nullopt;

    pending_orders_.push_back(order);

    return id;
}

uint64_t MatchingEngine::place_stop_order(Side side, double entry_price,
                                           double quantity,
                                           double stop_loss, double take_profit,
                                           int64_t created_at) {
    uint64_t id = next_order_id_++;

    Order order{};
    order.id          = id;
    order.side        = side;
    order.type        = OrdType::Stop;
    order.entry_price = entry_price;
    order.stop_loss   = stop_loss;
    order.take_profit = take_profit;
    order.quantity    = quantity;
    order.status      = OrdStatus::Pending;
    order.created_at  = created_at;
    order.filled_at   = 0;
    order.fill_price  = std::nullopt;

    pending_orders_.push_back(order);

    return id;
}

bool MatchingEngine::cancel_order(uint64_t order_id) {
    auto it = std::find_if(pending_orders_.begin(), pending_orders_.end(),
        [order_id](const Order& o) { return o.id == order_id; });

    if (it == pending_orders_.end()) {
        return false;
    }

    // Mark as cancelled and move to order history.
    it->status = OrdStatus::Cancelled;
    order_history_.push_back(*it);
    pending_orders_.erase(it);

    return true;
}

bool MatchingEngine::close_position(uint64_t position_id, double exit_price,
                                     int64_t timestamp) {
    auto it = std::find_if(open_positions_.begin(), open_positions_.end(),
        [position_id](const Position& p) { return p.id == position_id; });

    if (it == open_positions_.end()) {
        return false;
    }

    close_position_internal(it, exit_price, CloseReason::Manual, timestamp);
    return true;
}

bool MatchingEngine::update_position_sltp(uint64_t position_id, double stop_loss, double take_profit) {
    auto it = std::find_if(open_positions_.begin(), open_positions_.end(),
        [position_id](const Position& p) { return p.id == position_id; });

    if (it == open_positions_.end()) {
        return false;
    }

    it->stop_loss = stop_loss;
    it->take_profit = take_profit;
    return true;
}

// -----------------------------------------------------------------------------
// Candle Processing — The Critical Path
//
// This is the most important function in the entire engine. It executes the
// 4-step matching pipeline defined in ARCHITECTURE.md §4.2:
//
//   Step 1: Check pending Limit/Stop orders for trigger conditions
//   Step 2: Check open positions for SL/TP breaches (PESSIMISTIC FILL)
//   Step 3: Recalculate floating equity at candle.close
//   Step 4: Fire account snapshot event
//
// The pessimistic fill rule is enforced in Step 2: when a single candle's
// high/low range triggers BOTH the SL and TP of a position, the Stop Loss
// is always executed first. This prevents inflated backtest results.
// -----------------------------------------------------------------------------

void MatchingEngine::on_candle(const Candle& candle) {

    // =========================================================================
    // STEP 1: CHECK PENDING ORDERS (Limit / Stop)
    //
    // Iterate over all pending orders and check if the new candle's price
    // range satisfies their trigger conditions. Orders that trigger are
    // filled at their entry_price and converted into open Positions.
    //
    // We iterate with an index (not iterator) because fill_order() modifies
    // pending_orders_ by erasing the filled order. We walk backward to
    // avoid index invalidation when erasing.
    // =========================================================================

    for (int i = static_cast<int>(pending_orders_.size()) - 1; i >= 0; --i) {
        Order& order = pending_orders_[static_cast<size_t>(i)];
        bool triggered = false;

        switch (order.type) {
            case OrdType::Limit: {
                // Limit Buy: price must drop TO or BELOW entry_price.
                //   → Triggered when candle.low <= entry_price.
                //
                // Limit Sell: price must rise TO or ABOVE entry_price.
                //   → Triggered when candle.high >= entry_price.
                if (order.side == Side::Buy) {
                    triggered = (candle.low <= order.entry_price);
                } else {
                    triggered = (candle.high >= order.entry_price);
                }
                break;
            }

            case OrdType::Stop: {
                // Stop Buy: price must break ABOVE entry_price (breakout long).
                //   → Triggered when candle.high >= entry_price.
                //
                // Stop Sell: price must break BELOW entry_price (breakout short).
                //   → Triggered when candle.low <= entry_price.
                if (order.side == Side::Buy) {
                    triggered = (candle.high >= order.entry_price);
                } else {
                    triggered = (candle.low <= order.entry_price);
                }
                break;
            }

            case OrdType::Market:
                // Market orders are filled immediately at placement — they
                // should never appear in the pending queue. Skip gracefully.
                break;
        }

        if (triggered) {
            // Capture the order before erasing, since fill_order needs it.
            Order triggered_order = order;
            pending_orders_.erase(pending_orders_.begin() + i);

            fill_order(triggered_order, triggered_order.entry_price, candle.timestamp);
        }
    }

    // =========================================================================
    // STEP 2: CHECK OPEN POSITIONS FOR SL / TP BREACHES
    //
    // For each open position, determine if the candle's price range triggers
    // the Stop Loss and/or Take Profit.
    //
    // PESSIMISTIC FILL RULE:
    // If a single candle triggers BOTH SL and TP for the same position
    // (common during volatile wicks), we ALWAYS execute the Stop Loss.
    // Rationale: in real markets, violent candles typically wick through
    // your SL before reversing. Assuming the TP hit would inflate results.
    //
    // We iterate backward because close_position_internal() erases from
    // the open_positions_ vector.
    // =========================================================================

    for (int i = static_cast<int>(open_positions_.size()) - 1; i >= 0; --i) {
        Position& pos = open_positions_[static_cast<size_t>(i)];

        bool sl_triggered = false;
        bool tp_triggered = false;

        if (pos.side == Side::Buy) {
            // Buy position:
            //   SL is below entry — triggered when candle.low drops to or below SL.
            //   TP is above entry — triggered when candle.high rises to or above TP.
            if (pos.stop_loss > 0.0) {
                sl_triggered = (candle.low <= pos.stop_loss);
            }
            if (pos.take_profit > 0.0) {
                tp_triggered = (candle.high >= pos.take_profit);
            }
        } else {
            // Sell position:
            //   SL is above entry — triggered when candle.high rises to or above SL.
            //   TP is below entry — triggered when candle.low drops to or below TP.
            if (pos.stop_loss > 0.0) {
                sl_triggered = (candle.high >= pos.stop_loss);
            }
            if (pos.take_profit > 0.0) {
                tp_triggered = (candle.low <= pos.take_profit);
            }
        }

        // Apply the pessimistic fill rule: SL takes priority over TP.
        if (sl_triggered) {
            auto it = open_positions_.begin() + i;
            close_position_internal(it, pos.stop_loss, CloseReason::StopLoss,
                                    candle.timestamp);
        } else if (tp_triggered) {
            auto it = open_positions_.begin() + i;
            close_position_internal(it, pos.take_profit, CloseReason::TakeProfit,
                                    candle.timestamp);
        }
    }

    // =========================================================================
    // STEP 3: RECALCULATE FLOATING EQUITY
    //
    // equity = balance + Σ unrealized_pnl(candle.close) across all open positions
    // =========================================================================

    update_equity(candle.close);

    // =========================================================================
    // STEP 4: EMIT ACCOUNT SNAPSHOT EVENT
    // =========================================================================

    emit_account_update();
}

// -----------------------------------------------------------------------------
// Accessors
// -----------------------------------------------------------------------------

double MatchingEngine::balance() const noexcept {
    return balance_;
}

double MatchingEngine::equity() const noexcept {
    return equity_;
}

double MatchingEngine::starting_balance() const noexcept {
    return starting_balance_;
}

const std::vector<Position>& MatchingEngine::open_positions() const noexcept {
    return open_positions_;
}

const std::vector<Order>& MatchingEngine::pending_orders() const noexcept {
    return pending_orders_;
}

const std::vector<Order>& MatchingEngine::order_history() const noexcept {
    return order_history_;
}

const std::vector<ClosedTrade>& MatchingEngine::trade_history() const noexcept {
    return trade_history_;
}

AccountSnapshot MatchingEngine::snapshot() const noexcept {
    return AccountSnapshot{
        balance_,
        equity_,
        open_positions_.size(),
        pending_orders_.size()
    };
}

double MatchingEngine::total_realized_pnl() const noexcept {
    double total = 0.0;
    for (const auto& trade : trade_history_) {
        total += trade.realized_pnl;
    }
    return total;
}

double MatchingEngine::total_unrealized_pnl(double current_price) const noexcept {
    double total = 0.0;
    for (const auto& pos : open_positions_) {
        total += pos.unrealized_pnl(current_price);
    }
    return total;
}

// -----------------------------------------------------------------------------
// Event Callbacks
// -----------------------------------------------------------------------------

void MatchingEngine::set_on_order_filled(OnOrderFilled callback) {
    on_order_filled_ = std::move(callback);
}

void MatchingEngine::set_on_position_closed(OnPositionClosed callback) {
    on_position_closed_ = std::move(callback);
}

void MatchingEngine::set_on_account_update(OnAccountUpdate callback) {
    on_account_update_ = std::move(callback);
}

// -----------------------------------------------------------------------------
// Internal: Fill Order
//
// Converts a pending/market order into an open Position.
// Archives the order into order_history_ with Filled status.
// Fires the OnOrderFilled event callback.
// -----------------------------------------------------------------------------

void MatchingEngine::fill_order(Order& order, double fill_price, int64_t timestamp) {
    // Update order state.
    order.status     = OrdStatus::Filled;
    order.fill_price = fill_price;
    order.filled_at  = timestamp;

    // Archive into order history.
    order_history_.push_back(order);

    // Create the corresponding open Position.
    Position pos{};
    pos.id          = order.id;
    pos.side        = order.side;
    pos.entry_price = fill_price;
    pos.quantity    = order.quantity;
    pos.stop_loss   = order.stop_loss;
    pos.take_profit = order.take_profit;
    pos.opened_at   = timestamp;

    open_positions_.push_back(pos);

    // Fire event callback.
    if (on_order_filled_) {
        OrderFilledEvent event{};
        event.order_id   = order.id;
        event.side       = order.side;
        event.type       = order.type;
        event.fill_price = fill_price;
        event.quantity   = order.quantity;
        event.timestamp  = timestamp;

        on_order_filled_(event);
    }
}

// -----------------------------------------------------------------------------
// Internal: Close Position
//
// Computes realized P&L, updates the cash balance, creates a ClosedTrade
// history record, removes the position from open_positions_, and fires
// the OnPositionClosed event callback.
//
// Realized P&L formula (from ARCHITECTURE.md §4.4):
//   Buy:  (exit_price - entry_price) × quantity
//   Sell: (entry_price - exit_price) × quantity
// -----------------------------------------------------------------------------

void MatchingEngine::close_position_internal(std::vector<Position>::iterator it,
                                              double exit_price,
                                              CloseReason reason,
                                              int64_t timestamp) {
    const Position& pos = *it;

    // Compute realized P&L.
    double realized_pnl;
    if (pos.side == Side::Buy) {
        realized_pnl = (exit_price - pos.entry_price) * pos.quantity;
    } else {
        realized_pnl = (pos.entry_price - exit_price) * pos.quantity;
    }

    // Update cash balance.
    balance_ += realized_pnl;

    // Create closed trade record.
    ClosedTrade closed{};
    closed.id           = pos.id;
    closed.side         = pos.side;
    closed.entry_price  = pos.entry_price;
    closed.exit_price   = exit_price;
    closed.quantity     = pos.quantity;
    closed.realized_pnl = realized_pnl;
    closed.stop_loss    = pos.stop_loss;
    closed.take_profit  = pos.take_profit;
    closed.reason       = reason;
    closed.opened_at    = pos.opened_at;
    closed.closed_at    = timestamp;

    trade_history_.push_back(closed);

    // Update the corresponding order in history with the close reason.
    for (auto& order : order_history_) {
        if (order.id == pos.id && order.status == OrdStatus::Filled) {
            if (reason == CloseReason::StopLoss) {
                order.status = OrdStatus::StopLossHit;
            } else if (reason == CloseReason::TakeProfit) {
                order.status = OrdStatus::TakeProfitHit;
            }
            break;
        }
    }

    // Fire event callback before erasing (pos reference will be invalidated).
    if (on_position_closed_) {
        PositionClosedEvent event{};
        event.position_id  = pos.id;
        event.side         = pos.side;
        event.entry_price  = pos.entry_price;
        event.exit_price   = exit_price;
        event.quantity     = pos.quantity;
        event.realized_pnl = realized_pnl;
        event.stop_loss    = pos.stop_loss;
        event.take_profit  = pos.take_profit;
        event.opened_at    = pos.opened_at;
        event.reason       = reason;
        event.timestamp    = timestamp;

        on_position_closed_(event);
    }

    // Remove from open positions.
    open_positions_.erase(it);
}

// -----------------------------------------------------------------------------
// Internal: Update Equity
//
// equity = balance + Σ unrealized_pnl(current_price) across all open positions
// -----------------------------------------------------------------------------

void MatchingEngine::update_equity(double current_price) noexcept {
    double unrealized = 0.0;
    for (const auto& pos : open_positions_) {
        unrealized += pos.unrealized_pnl(current_price);
    }
    equity_ = balance_ + unrealized;
}

// -----------------------------------------------------------------------------
// Internal: Emit Account Update
// -----------------------------------------------------------------------------

void MatchingEngine::emit_account_update() {
    if (on_account_update_) {
        on_account_update_(snapshot());
    }
}
