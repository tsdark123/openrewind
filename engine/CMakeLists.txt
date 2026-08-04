cmake_minimum_required(VERSION 3.20)

project(openrewind-engine
    VERSION     0.1.0
    LANGUAGES   CXX
    DESCRIPTION "OpenRewind — High-performance C++20 market replay and backtesting engine"
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
    src/child_process.cpp
    src/path_utils.cpp
)

set(ENGINE_HEADERS
    include/candle.hpp
    include/csv_loader.hpp
    include/matching.hpp
    include/session.hpp
    include/server.hpp
    include/child_process.hpp
    include/path_utils.hpp
)

# ==============================================================================
# Executable Target
# ==============================================================================

add_executable(openrewind-engine ${ENGINE_SOURCES} ${ENGINE_HEADERS})

target_include_directories(openrewind-engine PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(openrewind-engine PRIVATE
    Crow::Crow
    nlohmann_json::nlohmann_json
)

# ==============================================================================
# MSVC-Specific Configuration
# ==============================================================================

if(MSVC)
    target_compile_options(openrewind-engine PRIVATE
        /W4             # High warning level
        /permissive-    # Strict conformance mode
        /utf-8          # Source and execution character set
        /Zc:__cplusplus # Report correct __cplusplus value
    )

    # Suppress Crow/Asio deprecation warnings on Windows.
    target_compile_definitions(openrewind-engine PRIVATE
        _WIN32_WINNT=0x0A00         # Target Windows 10+
        _CRT_SECURE_NO_WARNINGS     # Suppress CRT deprecation warnings
        NOMINMAX                    # Prevent Windows.h min/max macros
    )

    # Static link the MSVC runtime so the binary needs no VC++ redistributable.
    # Switch /MD (dynamic CRT) → /MT (static CRT) for Release builds.
    set_property(TARGET openrewind-engine PROPERTY
        MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
    )
else()
    target_compile_options(openrewind-engine PRIVATE
        -Wall -Wextra -Wpedantic
    )

    # Static link libstdc++ and libgcc on GCC/Clang so the binary is
    # self-contained on Linux/macOS without requiring matching system libs.
    if(NOT APPLE)
        target_link_options(openrewind-engine PRIVATE
            -static-libgcc
            -static-libstdc++
        )
    endif()
endif()

# ==============================================================================
# Threading
# ==============================================================================

find_package(Threads REQUIRED)
target_link_libraries(openrewind-engine PRIVATE Threads::Threads)

# ==============================================================================
# Tauri Sidecar — Copy binary into src-tauri/binaries/ after build
#
# Tauri requires sidecars to be named:  <name>-<target-triple>[.exe]
# e.g. openrewind-engine-x86_64-pc-windows-msvc.exe
#
# We detect the triple from CMake's system info so CI and local builds
# both produce the correctly-named file automatically.
# ==============================================================================

if(WIN32)
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(TAURI_TARGET_TRIPLE "x86_64-pc-windows-msvc")
    else()
        set(TAURI_TARGET_TRIPLE "i686-pc-windows-msvc")
    endif()
    set(SIDECAR_EXT ".exe")
elseif(APPLE)
    execute_process(COMMAND uname -m OUTPUT_VARIABLE HOST_ARCH OUTPUT_STRIP_TRAILING_WHITESPACE)
    if(HOST_ARCH STREQUAL "arm64")
        set(TAURI_TARGET_TRIPLE "aarch64-apple-darwin")
    else()
        set(TAURI_TARGET_TRIPLE "x86_64-apple-darwin")
    endif()
    set(SIDECAR_EXT "")
else()
    set(TAURI_TARGET_TRIPLE "x86_64-unknown-linux-gnu")
    set(SIDECAR_EXT "")
endif()

set(SIDECAR_NAME "openrewind-engine-${TAURI_TARGET_TRIPLE}${SIDECAR_EXT}")
set(SIDECAR_DEST "${CMAKE_CURRENT_SOURCE_DIR}/../src-tauri/binaries/${SIDECAR_NAME}")

add_custom_command(TARGET openrewind-engine POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory
        "${CMAKE_CURRENT_SOURCE_DIR}/../src-tauri/binaries"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE:openrewind-engine>"
        "${SIDECAR_DEST}"
    COMMENT "Copying engine sidecar → src-tauri/binaries/${SIDECAR_NAME}"
)

# ==============================================================================
# Engine utility tests
#
# A focused test executable for child_process and path_utils.  It intentionally
# does NOT link Crow or nlohmann_json — only the two utility sources and the
# test file itself.
# ==============================================================================

set(ENGINE_TEST_SOURCES
    tests/engine_utils_test.cpp
    src/child_process.cpp
    src/path_utils.cpp
)

add_executable(openrewind-engine-tests ${ENGINE_TEST_SOURCES})

target_include_directories(openrewind-engine-tests PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(MSVC)
    target_compile_options(openrewind-engine-tests PRIVATE
        /W4
        /permissive-
        /utf-8
        /Zc:__cplusplus
    )
    target_compile_definitions(openrewind-engine-tests PRIVATE
        _WIN32_WINNT=0x0A00
        _CRT_SECURE_NO_WARNINGS
        NOMINMAX
    )
    set_property(TARGET openrewind-engine-tests PROPERTY
        MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
    )
else()
    target_compile_options(openrewind-engine-tests PRIVATE
        -Wall -Wextra -Wpedantic
    )
    if(NOT APPLE)
        target_link_options(openrewind-engine-tests PRIVATE
            -static-libgcc
            -static-libstdc++
        )
    endif()
endif()

find_package(Threads REQUIRED)
target_link_libraries(openrewind-engine-tests PRIVATE Threads::Threads)

# ==============================================================================
# Install (optional — for packaging)
# ==============================================================================

install(TARGETS openrewind-engine DESTINATION bin)
