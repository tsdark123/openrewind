#include "path_utils.hpp"

#include <cctype>
#include <cstddef>
#include <cstring>
#include <filesystem>
#include <iostream>

namespace {

// Reject common path separator / drive characters.
bool is_separator(char c) {
    return c == '/' || c == '\\' || c == ':';
}

} // namespace

// =============================================================================
// Symbol sanitization
// =============================================================================

std::optional<std::string> sanitize_symbol(const std::string& symbol) {
    if (symbol.empty() || symbol.size() > 20) {
        return std::nullopt;
    }

    // Reject path traversal markers, nulls, and percent-encoding indicators.
    if (symbol.find('\0') != std::string::npos ||
        symbol.find("..") != std::string::npos ||
        symbol.find('%') != std::string::npos) {
        return std::nullopt;
    }

    std::string out;
    out.reserve(symbol.size());

    for (unsigned char c : symbol) {
        // Whitespace is never allowed.
        if (std::isspace(static_cast<unsigned char>(c))) {
            return std::nullopt;
        }

        // Path separators or drive-letter delimiters are forbidden.
        if (is_separator(static_cast<char>(c))) {
            return std::nullopt;
        }

        // Allowed set: A-Z, a-z, 0-9, '.', '-', '_'.
        bool allowed = (c >= 'A' && c <= 'Z') ||
                       (c >= 'a' && c <= 'z') ||
                       (c >= '0' && c <= '9') ||
                       c == '.' || c == '-' || c == '_';

        if (!allowed) {
            return std::nullopt;
        }

        out.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(c))));
    }

    // Do not allow leading or trailing punctuation that could be used to
    // construct hidden files or ambiguous names.
    if (out.empty()) {
        return std::nullopt;
    }
    if (out.front() == '.' || out.front() == '-' || out.front() == '_') {
        return std::nullopt;
    }
    if (out.back() == '.' || out.back() == '-' || out.back() == '_') {
        return std::nullopt;
    }

    return out;
}

// =============================================================================
// Data-directory resolution
// =============================================================================

static std::optional<std::filesystem::path> canonicalize_root(
    const std::string& root) {
    namespace fs = std::filesystem;

    if (root.empty()) {
        return std::nullopt;
    }

    std::error_code ec;
    fs::path canonical = fs::canonical(root, ec);
    if (ec || canonical.empty()) {
        return std::nullopt;
    }

    bool is_dir = fs::is_directory(canonical, ec);
    if (ec || !is_dir) {
        return std::nullopt;
    }

    return canonical;
}

static bool is_within(const std::filesystem::path& canonical_path,
                      const std::filesystem::path& canonical_root) {
    // Exact match is always allowed.
    if (canonical_path == canonical_root) {
        return true;
    }

    // Compare the native (system-encoded) string forms.  canonical_path is a
    // child of canonical_root when it starts with the root string and the next
    // character is the preferred path separator.
    const auto& root_native = canonical_root.native();
    const auto& path_native = canonical_path.native();

    if (path_native.size() <= root_native.size()) {
        return false;
    }

    if (path_native.compare(0, root_native.size(), root_native) != 0) {
        return false;
    }

    const auto sep = std::filesystem::path::preferred_separator;
    return path_native[root_native.size()] == sep;
}

std::optional<std::filesystem::path> resolve_data_dir(
    const std::string& requested,
    const std::string& managed_root,
    const std::optional<std::string>& local_root) {
    namespace fs = std::filesystem;

    // Reject nulls, percent-encoded paths, and obvious traversal attempts before
    // any filesystem operations.
    if (requested.find('\0') != std::string::npos ||
        requested.find('%') != std::string::npos ||
        requested.find("..") != std::string::npos) {
        return std::nullopt;
    }

    // Empty requested means "use the managed root".
    const std::string& target = requested.empty() ? managed_root : requested;
    if (target.empty()) {
        return std::nullopt;
    }

    // Canonicalize the target.  It must exist and be a directory.
    std::error_code ec;
    fs::path canonical = fs::canonical(target, ec);
    if (ec || canonical.empty() || !fs::is_directory(canonical, ec) || ec) {
        return std::nullopt;
    }

    // Canonicalize and authorize against the managed root.
    auto managed = canonicalize_root(managed_root);
    if (managed && is_within(canonical, *managed)) {
        return canonical;
    }

    // Authorize against the optional local-data root.
    if (local_root) {
        auto local = canonicalize_root(*local_root);
        if (local && is_within(canonical, *local)) {
            return canonical;
        }
    }

    return std::nullopt;
}
