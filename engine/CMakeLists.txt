cmake_minimum_required(VERSION 3.20)

project(openreplay-engine
    VERSION     0.1.0
    LANGUAGES   CXX
    DESCRIPTION "OpenReplay — High-performance C++20 market replay and backtesting engine"
)

# ==============================================================================
# C++ Standard
# ==============================================================================

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ==============================================================================
# Dependencies (resolved via vcpkg)
# ==============================================================================

find_package(Crow CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

# ==============================================================================
# Source Files
# ==============================================================================

set(ENGINE_SOURCES
    src/main.cpp
    src/candle.cpp
    src/csv_loader.cpp
    src/matching.cpp
    src/session.cpp
    src/server.cpp
)

set(ENGINE_HEADERS
    include/candle.hpp
    include/csv_loader.hpp
    include/matching.hpp
    include/session.hpp
    include/server.hpp
)

# ==============================================================================
# Executable Target
# ==============================================================================

add_executable(openreplay-engine ${ENGINE_SOURCES} ${ENGINE_HEADERS})

target_include_directories(openreplay-engine PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(openreplay-engine PRIVATE
    Crow::Crow
    nlohmann_json::nlohmann_json
)

# ==============================================================================
# MSVC-Specific Configuration
# ==============================================================================

if(MSVC)
    target_compile_options(openreplay-engine PRIVATE
        /W4             # High warning level
        /permissive-    # Strict conformance mode
        /utf-8          # Source and execution character set
        /Zc:__cplusplus # Report correct __cplusplus value
    )

    # Suppress Crow/Asio deprecation warnings on Windows.
    target_compile_definitions(openreplay-engine PRIVATE
        _WIN32_WINNT=0x0A00         # Target Windows 10+
        _CRT_SECURE_NO_WARNINGS     # Suppress CRT deprecation warnings
        NOMINMAX                    # Prevent Windows.h min/max macros
    )
else()
    target_compile_options(openreplay-engine PRIVATE
        -Wall -Wextra -Wpedantic
    )
endif()

# ==============================================================================
# Threading
# ==============================================================================

find_package(Threads REQUIRED)
target_link_libraries(openreplay-engine PRIVATE Threads::Threads)

# ==============================================================================
# Install (optional — for packaging)
# ==============================================================================

install(TARGETS openreplay-engine DESTINATION bin)
