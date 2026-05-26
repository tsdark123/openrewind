#pragma once

#include "session.hpp"

#include <crow.h>
#include <nlohmann/json.hpp>

#include <string>
#include <mutex>
#include <unordered_set>
#include <atomic>
#include <memory>

// =============================================================================
// OpenReplayServer — Crow-based HTTP/WebSocket server for OpenReplay.
//
// Binds to localhost:9000 and exposes:
//   - REST endpoints under /api/* for session and order management
//   - WebSocket endpoint at /ws for real-time bidirectional communication
//
// The server owns a SessionManager and wires its event callbacks to broadcast
// JSON-serialized events to all connected WebSocket clients. Every outbound
// message is wrapped in a standard envelope:
//
//   { "type": "<event_type>", "seq": <monotonic_int>, "payload": { ... } }
//
// Thread safety:
//   - Crow handles HTTP/WS on its internal thread pool.
//   - WebSocket connection set is protected by ws_mutex_.
//   - SessionManager has its own internal mutex for state access.
//   - The sequence counter is atomic.
// =============================================================================

using json = nlohmann::json;

class OpenReplayServer {
public:
    explicit OpenReplayServer(int port = 9000);
    ~OpenReplayServer();

    // Start the Crow server (blocking). Call from main().
    void run();

    // Stop the server gracefully.
    void stop();

private:
    // --- Crow App ---
    crow::SimpleApp app_;
    int port_;

    // --- Core Session ---
    SessionManager session_;

    // --- WebSocket State ---
    mutable std::mutex ws_mutex_;
    std::unordered_set<crow::websocket::connection*> ws_clients_;
    std::atomic<uint64_t> seq_{0};

    // -------------------------------------------------------------------------
    // Route Setup
    // -------------------------------------------------------------------------

    void setup_rest_routes();
    void setup_websocket();

    // -------------------------------------------------------------------------
    // WebSocket Broadcasting
    // -------------------------------------------------------------------------

    // Wrap a payload in the standard { type, seq, payload } envelope and
    // broadcast to all connected WebSocket clients.
    void broadcast(const std::string& event_type, const json& payload);

    // Send a message to a single WebSocket connection.
    void send_to(crow::websocket::connection& conn,
                 const std::string& event_type, const json& payload);

    // -------------------------------------------------------------------------
    // Event Wiring
    // -------------------------------------------------------------------------

    // Wire SessionManager and MatchingEngine callbacks to broadcast events.
    void wire_event_callbacks();

    // -------------------------------------------------------------------------
    // WebSocket Command Handling
    // -------------------------------------------------------------------------

    // Parse and execute a client→server WebSocket command.
    void handle_ws_command(crow::websocket::connection& conn, const std::string& msg);

    // -------------------------------------------------------------------------
    // JSON Serialization Helpers
    // -------------------------------------------------------------------------

    static json candle_to_json(const Candle& c);
    static json position_to_json(const Position& p);
    static json order_to_json(const Order& o);
    static json closed_trade_to_json(const ClosedTrade& t);
    static json account_snapshot_to_json(const AccountSnapshot& snap);

    // Build the full session state response (for REST /api/session/state
    // and for the initial WS sync).
    json build_full_state() const;

    // -------------------------------------------------------------------------
    // Utility
    // -------------------------------------------------------------------------

    // Parse a JSON string from request body. Returns empty json on failure.
    static json parse_body(const crow::request& req);

    // Parse Side from string ("buy"/"sell"). Returns std::nullopt on failure.
    static std::optional<Side> parse_side(const std::string& s);

    // Parse OrdType from string ("market"/"limit"/"stop"). Returns nullopt on failure.
    static std::optional<OrdType> parse_ord_type(const std::string& s);
};
