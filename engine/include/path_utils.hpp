#pragma once

#include <filesystem>
#include <optional>
#include <string>

// =============================================================================
// Path and symbol validation for the engine.
//
// The engine accepts a `data_dir` query/body parameter.  This parameter MUST
// be one of the roots the application has already authorized:
//
//   - the configured managed data root (OPENREWIND_DATA_DIR / "data"), or
//   - an app-created Local Data root passed through OPENREWIND_LOCAL_DATA_DIR.
//
// Any other root, any traversal, or any absolute path outside these roots is
// rejected.  Symbols are validated against the generic ticker/import-symbol
// character contract (alphanumeric, dot, hyphen, underscore) and normalized to
// uppercase.
// =============================================================================

/**
 * Validate a symbol against the generic ticker/import-symbol contract.
 *
 * Accepts: A-Z, a-z, 0-9, dot, hyphen, underscore.  Length 1..20.
 * Rejects: path separators, traversal, nulls, control characters, percent
 * encoding, absolute-path syntax, and any other punctuation.
 *
 * Returns the uppercased symbol on success, std::nullopt on failure.
 */
std::optional<std::string> sanitize_symbol(const std::string& symbol);

/**
 * Resolve and authorize a requested data directory.
 *
 * - If `requested` is empty, the managed root is used.
 * - The path is canonicalized; it must exist and be a directory.
 * - The result is allowed only if it equals the canonical managed root or the
 *   canonical local root (when configured), or is a child/subdirectory of one
 *   of those roots.
 *
 * Returns std::nullopt if the path is missing, malformed, or unauthorized.
 */
std::optional<std::filesystem::path> resolve_data_dir(
    const std::string& requested,
    const std::string& managed_root,
    const std::optional<std::string>& local_root = std::nullopt);
