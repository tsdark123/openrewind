#include "server.hpp"

#include <iostream>
#include <optional>
#include <sstream>

// =============================================================================
// OpenReplayServer — Implementation
// =============================================================================

// -----------------------------------------------------------------------------
// Construction / Destruction
// -----------------------------------------------------------------------------

OpenReplayServer::OpenReplayServer(int port)
    : port_(port)
{
    setup_rest_routes();
    setup_websocket();
    wire_event_callbacks();
}

OpenReplayServer::~OpenReplayServer() {
    stop();
}

// -----------------------------------------------------------------------------
// Server Lifecycle
// -----------------------------------------------------------------------------

void OpenReplayServer::run() {
    std::cout << "[OpenReplay] Starting server on http://localhost:"
              << port_ << std::endl;

    app_.port(static_cast<uint16_t>(port_))
        .multithreaded()
        .run();
}

void OpenReplayServer::stop() {
    app_.stop();
    session_.stop_session();
}

// -----------------------------------------------------------------------------
// REST Route Setup
// -----------------------------------------------------------------------------

void OpenReplayServer::setup_rest_routes() {

    // =========================================================================
    // POST /api/session/start
    //
    // Request:  { "symbol": "AAPL", "starting_balance": 100000.0,
    //             "data_dir": "data" (optional) }
    // Response: { "session_id": "1", "symbol": "AAPL",
    //             "total_candles": 98280, "start_ts": ..., "end_ts": ... }
    // =========================================================================

    CROW_ROUTE(app_, "/api/session/start").methods(crow::HTTPMethod::POST)
    ([this](const crow::request& req) {
        json body = parse_body(req);

        if (body.empty() || !body.contains("symbol")) {
            return crow::response(400, "application/json",
                json{{"error", "Missing required field: symbol"}}.dump());
        }

        std::string symbol = body["symbol"].get<std::string>();
        double starting_balance = body.value("starting_balance", 100000.0);
        std::string data_dir = body.value("data_dir", "data");

        try {
            std::size_t total = session_.start_session(symbol, starting_balance, data_dir);

            json response = {
                {"session_id",     "1"},
                {"symbol",         symbol},
                {"total_candles",  total},
                {"start_ts",       session_.start_timestamp()},
                {"end_ts",         session_.end_timestamp()}
            };

            // Broadcast session_started to all WS clients.
            broadcast("session_started", response);

            return crow::response(200, "application/json", response.dump());
        }
        catch (const std::exception& e) {
            return crow::response(500, "application/json",
                json{{"error", e.what()}}.dump());
        }
    });

    // =========================================================================
    // POST /api/session/stop
    //
    // Request:  {} (empty or { "session_id": "1" })
    // Response: { "summary": { balance, equity, total_trades, realized_pnl } }
    // =========================================================================

    CROW_ROUTE(app_, "/api/session/stop").methods(crow::HTTPMethod::POST)
    ([this](const crow::request&) {
        auto snap = session_.account_snapshot();
        auto trades = session_.trade_history();

        double total_pnl = 0.0;
        for (const auto& t : trades) {
            total_pnl += t.realized_pnl;
        }

        session_.stop_session();

        json summary = {
            {"balance",       snap.balance},
            {"equity",        snap.equity},
            {"total_trades",  trades.size()},
            {"realized_pnl",  total_pnl}
        };

        return crow::response(200, "application/json",
            json{{"summary", summary}}.dump());
    });

    // =========================================================================
    // GET /api/session/state
    //
    // Response: Full session state snapshot (fallback if WS disconnects).
    // =========================================================================

    CROW_ROUTE(app_, "/api/session/state").methods(crow::HTTPMethod::GET)
    ([this](const crow::request&) {
        if (!session_.is_active()) {
            return crow::response(400, "application/json",
                json{{"error", "No active session"}}.dump());
        }

        json state = build_full_state();
        return crow::response(200, "application/json", state.dump());
    });

    // =========================================================================
    // POST /api/order
    //
    // Request:  { "side": "buy"|"sell", "type": "market"|"limit"|"stop",
    //             "quantity": 100, "entry_price": 150.0 (limit/stop only),
    //             "stop_loss": 149.0, "take_profit": 155.0 }
    // Response: { "order_id": 1, "status": "filled"|"pending" }
    // =========================================================================

    CROW_ROUTE(app_, "/api/order").methods(crow::HTTPMethod::POST)
    ([this](const crow::request& req) {
        if (!session_.is_active()) {
            return crow::response(400, "application/json",
                json{{"error", "No active session"}}.dump());
        }

        json body = parse_body(req);

        if (body.empty() || !body.contains("side") || !body.contains("type") ||
            !body.contains("quantity")) {
            return crow::response(400, "application/json",
                json{{"error", "Missing required fields: side, type, quantity"}}.dump());
        }

        auto side = parse_side(body["side"].get<std::string>());
        auto type = parse_ord_type(body["type"].get<std::string>());

        if (!side || !type) {
            return crow::response(400, "application/json",
                json{{"error", "Invalid side or type value"}}.dump());
        }

        double quantity    = body["quantity"].get<double>();
        double stop_loss   = body.value("stop_loss", 0.0);
        double take_profit = body.value("take_profit", 0.0);

        uint64_t order_id = 0;
        std::string status;

        switch (*type) {
            case OrdType::Market: {
                order_id = session_.place_market_order(*side, quantity,
                                                       stop_loss, take_profit);
                status = "filled";
                break;
            }
            case OrdType::Limit: {
                double entry_price = body.value("entry_price", 0.0);
                if (entry_price <= 0.0) {
                    return crow::response(400, "application/json",
                        json{{"error", "Limit order requires entry_price > 0"}}.dump());
                }
                order_id = session_.place_limit_order(*side, entry_price, quantity,
                                                      stop_loss, take_profit);
                status = "pending";
                break;
            }
            case OrdType::Stop: {
                double entry_price = body.value("entry_price", 0.0);
                if (entry_price <= 0.0) {
                    return crow::response(400, "application/json",
                        json{{"error", "Stop order requires entry_price > 0"}}.dump());
                }
                order_id = session_.place_stop_order(*side, entry_price, quantity,
                                                     stop_loss, take_profit);
                status = "pending";
                break;
            }
        }

        return crow::response(200, "application/json",
            json{{"order_id", order_id}, {"status", status}}.dump());
    });

    // =========================================================================
    // POST /api/order/cancel
    //
    // Request:  { "order_id": 1 }
    // Response: { "success": true|false }
    // =========================================================================

    CROW_ROUTE(app_, "/api/order/cancel").methods(crow::HTTPMethod::POST)
    ([this](const crow::request& req) {
        if (!session_.is_active()) {
            return crow::response(400, "application/json",
                json{{"error", "No active session"}}.dump());
        }

        json body = parse_body(req);

        if (body.empty() || !body.contains("order_id")) {
            return crow::response(400, "application/json",
                json{{"error", "Missing required field: order_id"}}.dump());
        }

        uint64_t order_id = body["order_id"].get<uint64_t>();
        bool success = session_.cancel_order(order_id);

        return crow::response(200, "application/json",
            json{{"success", success}}.dump());
    });

    // CORS is handled by the Vite dev proxy (/api → localhost:9000).
    // In production, a reverse proxy (nginx) would add CORS headers.
}

// -----------------------------------------------------------------------------
// WebSocket Setup
// -----------------------------------------------------------------------------

void OpenReplayServer::setup_websocket() {

    CROW_WEBSOCKET_ROUTE(app_, "/ws")
        .onopen([this](crow::websocket::connection& conn) {
            std::lock_guard<std::mutex> lock(ws_mutex_);
            ws_clients_.insert(&conn);
            std::cout << "[OpenReplay] WebSocket client connected ("
                      << ws_clients_.size() << " total)" << std::endl;

            // If a session is active, send the current state as an initial sync.
            if (session_.is_active()) {
                json state = build_full_state();
                send_to(conn, "session_state", state);
            }
        })
        .onclose([this](crow::websocket::connection& conn, const std::string& reason, uint16_t /*code*/) {
            std::lock_guard<std::mutex> lock(ws_mutex_);
            ws_clients_.erase(&conn);
            std::cout << "[OpenReplay] WebSocket client disconnected: "
                      << reason << " (" << ws_clients_.size() << " remaining)"
                      << std::endl;
        })
        .onmessage([this](crow::websocket::connection& conn,
                          const std::string& data, bool is_binary) {
            if (!is_binary) {
                handle_ws_command(conn, data);
            }
        });
}

// -----------------------------------------------------------------------------
// Event Wiring
//
// Connects SessionManager and MatchingEngine callbacks to WebSocket broadcasts.
// Called once during construction. The session manager forwards these callbacks
// to the matching engine when a session starts.
// -----------------------------------------------------------------------------

void OpenReplayServer::wire_event_callbacks() {

    // On candle advance (manual or auto-play): broadcast candle_update.
    session_.set_on_candle_advanced(
        [this](const CandleAdvancedEvent& event) {
            json payload = {
                {"timestamp",     event.candle.timestamp},
                {"open",          event.candle.open},
                {"high",          event.candle.high},
                {"low",           event.candle.low},
                {"close",         event.candle.close},
                {"volume",        event.candle.volume},
                {"cursor",        event.cursor},
                {"total",         event.total_candles}
            };
            broadcast("candle_update", payload);

            // Piggy-back account snapshot on every candle update.
            broadcast("account_snapshot", account_snapshot_to_json(event.account));
        });

    // On order fill: broadcast order_filled.
    session_.set_on_order_filled(
        [this](const OrderFilledEvent& event) {
            json payload = {
                {"order_id",    event.order_id},
                {"side",        to_string(event.side)},
                {"type",        to_string(event.type)},
                {"fill_price",  event.fill_price},
                {"quantity",    event.quantity},
                {"timestamp",   event.timestamp}
            };
            broadcast("order_filled", payload);
        });

    // On position close (SL/TP/manual): broadcast position_closed.
    session_.set_on_position_closed(
        [this](const PositionClosedEvent& event) {
            json payload = {
                {"position_id",   event.position_id},
                {"side",          to_string(event.side)},
                {"entry_price",   event.entry_price},
                {"exit_price",    event.exit_price},
                {"quantity",      event.quantity},
                {"realized_pnl",  event.realized_pnl},
                {"reason",        to_string(event.reason)},
                {"timestamp",     event.timestamp}
            };
            broadcast("position_closed", payload);
        });
}

// -----------------------------------------------------------------------------
// WebSocket Command Handling
//
// Parses a JSON command from a client and dispatches to the appropriate
// SessionManager method. Supported commands (from ARCHITECTURE.md §5.3):
//
//   next_candle, rewind, seek, play, pause, set_speed, set_timeframe,
//   place_order, cancel_order, close_position
// -----------------------------------------------------------------------------

void OpenReplayServer::handle_ws_command(crow::websocket::connection& conn,
                                          const std::string& msg) {
    json cmd;
    try {
        cmd = json::parse(msg);
    }
    catch (...) {
        send_to(conn, "error", {{"message", "Invalid JSON"}});
        return;
    }

    if (!cmd.contains("cmd")) {
        send_to(conn, "error", {{"message", "Missing 'cmd' field"}});
        return;
    }

    std::string command = cmd["cmd"].get<std::string>();

    if (!session_.is_active() && command != "ping") {
        send_to(conn, "error", {{"message", "No active session"}});
        return;
    }

    // --- next_candle ---
    if (command == "next_candle") {
        bool advanced = session_.next_candle();
        if (!advanced) {
            send_to(conn, "error", {{"message", "Already at end of data"}});
        }
    }

    // --- rewind ---
    else if (command == "rewind") {
        bool rewound = session_.rewind_one();
        if (!rewound) {
            send_to(conn, "error", {{"message", "Already at start of data"}});
        } else {
            // Send updated state so the frontend can rewind its candle array.
            send_to(conn, "session_state", build_full_state());
        }
    }

    // --- seek ---
    else if (command == "seek") {
        if (!cmd.contains("timestamp")) {
            send_to(conn, "error", {{"message", "seek requires 'timestamp' field"}});
            return;
        }
        int64_t ts = cmd["timestamp"].get<int64_t>();
        session_.seek(ts);

        // Send updated state after seek.
        json state = build_full_state();
        send_to(conn, "session_state", state);
    }

    // --- play ---
    else if (command == "play") {
        session_.play();
    }

    // --- pause ---
    else if (command == "pause") {
        session_.pause();
    }

    // --- set_speed ---
    else if (command == "set_speed") {
        if (!cmd.contains("speed")) {
            send_to(conn, "error", {{"message", "set_speed requires 'speed' field"}});
            return;
        }
        int speed = cmd["speed"].get<int>();
        session_.set_speed(speed);
    }

    // --- set_direction ---
    else if (command == "set_direction") {
        if (!cmd.contains("direction")) {
            send_to(conn, "error", {{"message", "set_direction requires 'direction' field"}});
            return;
        }
        std::string dir_str = cmd["direction"].get<std::string>();
        PlayDirection dir;
        if (dir_str == "forward") {
            dir = PlayDirection::Forward;
        } else if (dir_str == "backward") {
            dir = PlayDirection::Backward;
        } else {
            send_to(conn, "error", {{"message", "direction must be 'forward' or 'backward'"}});
            return;
        }
        session_.set_direction(dir);
    }

    // --- set_timeframe ---
    else if (command == "set_timeframe") {
        if (!cmd.contains("minutes")) {
            send_to(conn, "error", {{"message", "set_timeframe requires 'minutes' field"}});
            return;
        }
        int minutes = cmd["minutes"].get<int>();
        session_.set_timeframe(minutes);
    }

    // --- place_order ---
    else if (command == "place_order") {
        if (!cmd.contains("side") || !cmd.contains("type") || !cmd.contains("quantity")) {
            send_to(conn, "error",
                {{"message", "place_order requires side, type, quantity"}});
            return;
        }

        auto side = parse_side(cmd["side"].get<std::string>());
        auto type = parse_ord_type(cmd["type"].get<std::string>());

        if (!side || !type) {
            send_to(conn, "error", {{"message", "Invalid side or type"}});
            return;
        }

        double quantity    = cmd["quantity"].get<double>();
        double stop_loss   = cmd.value("stop_loss", 0.0);
        double take_profit = cmd.value("take_profit", 0.0);

        uint64_t order_id = 0;

        switch (*type) {
            case OrdType::Market:
                order_id = session_.place_market_order(*side, quantity,
                                                       stop_loss, take_profit);
                break;
            case OrdType::Limit: {
                double entry_price = cmd.value("entry_price", 0.0);
                order_id = session_.place_limit_order(*side, entry_price, quantity,
                                                      stop_loss, take_profit);
                break;
            }
            case OrdType::Stop: {
                double entry_price = cmd.value("entry_price", 0.0);
                order_id = session_.place_stop_order(*side, entry_price, quantity,
                                                     stop_loss, take_profit);
                break;
            }
        }

        send_to(conn, "order_accepted", {{"order_id", order_id}});

        // Send full state refresh so the client immediately sees the new
        // position, updated balance/equity, etc.
        json state = build_full_state();
        send_to(conn, "session_state", state);
    }

    // --- update_position_sltp ---
    else if (command == "update_position_sltp") {
        if (!cmd.contains("position_id")) {
            send_to(conn, "error", {{"message", "update_position_sltp requires position_id"}});
            return;
        }

        uint64_t position_id = cmd["position_id"].get<uint64_t>();
        double stop_loss = cmd.value("stop_loss", 0.0);
        double take_profit = cmd.value("take_profit", 0.0);

        bool success = session_.update_position_sltp(position_id, stop_loss, take_profit);

        if (success) {
            send_to(conn, "position_sltp_updated", {{"position_id", position_id}});
            json state = build_full_state();
            send_to(conn, "session_state", state);
        } else {
            send_to(conn, "error", {{"message", "Position not found"}});
        }
    }

    // --- cancel_order ---
    else if (command == "cancel_order") {
        if (!cmd.contains("order_id")) {
            send_to(conn, "error", {{"message", "cancel_order requires 'order_id'"}});
            return;
        }
        uint64_t order_id = cmd["order_id"].get<uint64_t>();
        bool success = session_.cancel_order(order_id);
        send_to(conn, "order_cancelled", {{"order_id", order_id}, {"success", success}});
        send_to(conn, "session_state", build_full_state());
    }

    // --- close_position ---
    else if (command == "close_position") {
        if (!cmd.contains("position_id")) {
            send_to(conn, "error", {{"message", "close_position requires 'position_id'"}});
            return;
        }
        uint64_t pos_id = cmd["position_id"].get<uint64_t>();
        bool success = session_.close_position(pos_id);
        send_to(conn, "position_closed_ack",
            {{"position_id", pos_id}, {"success", success}});
        send_to(conn, "session_state", build_full_state());
    }

    // --- reset_session ---
    else if (command == "reset_session") {
        session_.reset_to_start();
        send_to(conn, "session_state", build_full_state());
    }

    // --- ping (heartbeat) ---
    else if (command == "ping") {
        send_to(conn, "pong", {});
    }

    // --- unknown command ---
    else {
        send_to(conn, "error",
            {{"message", "Unknown command: " + command}});
    }
}

// -----------------------------------------------------------------------------
// WebSocket Broadcasting
// -----------------------------------------------------------------------------

void OpenReplayServer::broadcast(const std::string& event_type, const json& payload) {
    uint64_t current_seq = seq_.fetch_add(1, std::memory_order_relaxed);

    json envelope = {
        {"type",    event_type},
        {"seq",     current_seq},
        {"payload", payload}
    };

    std::string message = envelope.dump();

    std::lock_guard<std::mutex> lock(ws_mutex_);
    for (auto* conn : ws_clients_) {
        try {
            conn->send_text(message);
        }
        catch (const std::exception& e) {
            std::cerr << "[OpenReplay] Failed to send to client: "
                      << e.what() << std::endl;
        }
    }
}

void OpenReplayServer::send_to(crow::websocket::connection& conn,
                                const std::string& event_type,
                                const json& payload) {
    uint64_t current_seq = seq_.fetch_add(1, std::memory_order_relaxed);

    json envelope = {
        {"type",    event_type},
        {"seq",     current_seq},
        {"payload", payload}
    };

    try {
        conn.send_text(envelope.dump());
    }
    catch (const std::exception& e) {
        std::cerr << "[OpenReplay] Failed to send to client: "
                  << e.what() << std::endl;
    }
}

// -----------------------------------------------------------------------------
// JSON Serialization Helpers
// -----------------------------------------------------------------------------

json OpenReplayServer::candle_to_json(const Candle& c) {
    return {
        {"timestamp", c.timestamp},
        {"open",      c.open},
        {"high",      c.high},
        {"low",       c.low},
        {"close",     c.close},
        {"volume",    c.volume}
    };
}

json OpenReplayServer::position_to_json(const Position& p) {
    return {
        {"id",           p.id},
        {"side",         to_string(p.side)},
        {"entry_price",  p.entry_price},
        {"quantity",     p.quantity},
        {"stop_loss",    p.stop_loss},
        {"take_profit",  p.take_profit},
        {"opened_at",    p.opened_at}
    };
}

json OpenReplayServer::order_to_json(const Order& o) {
    json j = {
        {"id",           o.id},
        {"side",         to_string(o.side)},
        {"type",         to_string(o.type)},
        {"entry_price",  o.entry_price},
        {"stop_loss",    o.stop_loss},
        {"take_profit",  o.take_profit},
        {"quantity",     o.quantity},
        {"status",       to_string(o.status)},
        {"created_at",   o.created_at}
    };

    if (o.fill_price.has_value()) {
        j["fill_price"] = o.fill_price.value();
        j["filled_at"]  = o.filled_at;
    }

    return j;
}

json OpenReplayServer::closed_trade_to_json(const ClosedTrade& t) {
    return {
        {"id",            t.id},
        {"side",          to_string(t.side)},
        {"entry_price",   t.entry_price},
        {"exit_price",    t.exit_price},
        {"quantity",      t.quantity},
        {"realized_pnl",  t.realized_pnl},
        {"reason",        to_string(t.reason)},
        {"opened_at",     t.opened_at},
        {"closed_at",     t.closed_at}
    };
}

json OpenReplayServer::account_snapshot_to_json(const AccountSnapshot& snap) {
    return {
        {"balance",              snap.balance},
        {"equity",               snap.equity},
        {"open_position_count",  snap.open_position_count},
        {"pending_order_count",  snap.pending_order_count}
    };
}

json OpenReplayServer::build_full_state() const {
    auto snap = session_.account_snapshot();
    auto positions = session_.open_positions();
    auto pending = session_.pending_orders();
    auto trades = session_.trade_history();

    json positions_arr = json::array();
    for (const auto& p : positions) {
        positions_arr.push_back(position_to_json(p));
    }

    json pending_arr = json::array();
    for (const auto& o : pending) {
        pending_arr.push_back(order_to_json(o));
    }

    json trades_arr = json::array();
    for (const auto& t : trades) {
        trades_arr.push_back(closed_trade_to_json(t));
    }

    json state = {
        {"symbol",           session_.symbol()},
        {"cursor",           session_.cursor()},
        {"total_candles",    session_.total_candles()},
        {"is_playing",       session_.is_playing()},
        {"speed",            session_.speed()},
        {"timeframe",        session_.timeframe()},
        {"account",          account_snapshot_to_json(snap)},
        {"open_positions",   positions_arr},
        {"pending_orders",   pending_arr},
        {"trade_history",    trades_arr}
    };

    // Include current candle if session is active.
    try {
        Candle c = session_.current_candle();
        state["candle"] = candle_to_json(c);
    }
    catch (...) {
        state["candle"] = nullptr;
    }

    return state;
}

// -----------------------------------------------------------------------------
// Utility
// -----------------------------------------------------------------------------

json OpenReplayServer::parse_body(const crow::request& req) {
    try {
        if (req.body.empty()) {
            return {};
        }
        return json::parse(req.body);
    }
    catch (...) {
        return {};
    }
}

std::optional<Side> OpenReplayServer::parse_side(const std::string& s) {
    if (s == "buy")  return Side::Buy;
    if (s == "sell") return Side::Sell;
    return std::nullopt;
}

std::optional<OrdType> OpenReplayServer::parse_ord_type(const std::string& s) {
    if (s == "market") return OrdType::Market;
    if (s == "limit")  return OrdType::Limit;
    if (s == "stop")   return OrdType::Stop;
    return std::nullopt;
}
