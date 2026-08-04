#include "server.hpp"

#include <iostream>
#include <cstdlib>
#include <filesystem>
#include <optional>
#include <string>
#include <system_error>

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

    // Optional: local data directory that the user may import CSVs into.
    // The Tauri sidecar passes this as an absolute path.
    std::optional<std::string> local_data_dir;
    const char* local_env = std::getenv("OPENREWIND_LOCAL_DATA_DIR");
    if (local_env && local_env[0] != '\0') {
        std::error_code ec;
        std::filesystem::path local_path = std::filesystem::absolute(local_env, ec);
        if (!ec) {
            local_data_dir = local_path.string();
        } else {
            std::cerr << "[OpenRewind] Ignoring invalid OPENREWIND_LOCAL_DATA_DIR: "
                      << local_env << std::endl;
        }
    }

    std::cout << "========================================" << std::endl;
    std::cout << "  OpenRewind Engine v0.1.0"              << std::endl;
    std::cout << "  Market Replay & Backtesting Server"    << std::endl;
    std::cout << "  Data directory: " << data_dir          << std::endl;
    if (local_data_dir) {
        std::cout << "  Local data dir: " << *local_data_dir << std::endl;
    }
    std::cout << "========================================" << std::endl;

    try {
        OpenRewindServer server(port, data_dir, local_data_dir);
        server.run();
    }
    catch (const std::exception& e) {
        std::cerr << "[OpenRewind] Fatal error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
