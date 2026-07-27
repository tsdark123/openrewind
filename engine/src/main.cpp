#include "server.hpp"

#include <iostream>
#include <cstdlib>

// =============================================================================
// OpenRewind Engine — Entry Point
//
// Starts the Crow HTTP/WebSocket server on localhost:9000.
// The port can be overridden via the OPENREWIND_PORT environment variable.
// =============================================================================

int main() {
    int port = 9000;

    const char* port_env = std::getenv("OPENREWIND_PORT");
    if (port_env) {
        try {
            port = std::stoi(port_env);
        }
        catch (...) {
            std::cerr << "[OpenRewind] Invalid OPENREWIND_PORT value, using default 9000"
                      << std::endl;
        }
    }

    // Optional: override the default data directory (used when the engine is
    // bundled as a Tauri sidecar and the CWD is not the resource directory).
    std::string data_dir = "data";
    const char* data_dir_env = std::getenv("OPENREWIND_DATA_DIR");
    if (data_dir_env && data_dir_env[0] != '\0') {
        data_dir = data_dir_env;
    }

    std::cout << "========================================" << std::endl;
    std::cout << "  OpenRewind Engine v0.1.0"              << std::endl;
    std::cout << "  Market Replay & Backtesting Server"    << std::endl;
    std::cout << "  Data directory: " << data_dir          << std::endl;
    std::cout << "========================================" << std::endl;

    try {
        OpenRewindServer server(port, data_dir);
        server.run();
    }
    catch (const std::exception& e) {
        std::cerr << "[OpenRewind] Fatal error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
