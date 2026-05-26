#include "server.hpp"

#include <iostream>
#include <cstdlib>

// =============================================================================
// OpenReplay Engine — Entry Point
//
// Starts the Crow HTTP/WebSocket server on localhost:9000.
// The port can be overridden via the OPENREPLAY_PORT environment variable.
// =============================================================================

int main() {
    int port = 9000;

    const char* port_env = std::getenv("OPENREPLAY_PORT");
    if (port_env) {
        try {
            port = std::stoi(port_env);
        }
        catch (...) {
            std::cerr << "[OpenReplay] Invalid OPENREPLAY_PORT value, using default 9000"
                      << std::endl;
        }
    }

    std::cout << "========================================" << std::endl;
    std::cout << "  OpenReplay Engine v0.1.0"              << std::endl;
    std::cout << "  Market Replay & Backtesting Server"    << std::endl;
    std::cout << "========================================" << std::endl;

    try {
        OpenReplayServer server(port);
        server.run();
    }
    catch (const std::exception& e) {
        std::cerr << "[OpenReplay] Fatal error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
