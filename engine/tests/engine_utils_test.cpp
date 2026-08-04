#include "child_process.hpp"
#include "path_utils.hpp"

// Force assert() to be active even in a Release build so the tests actually
// validate their conditions.
#ifdef NDEBUG
#undef NDEBUG
#endif

#include <cassert>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

namespace fs = std::filesystem;

// =============================================================================
// sanitize_symbol tests
// =============================================================================

static void test_sanitize_symbol() {
    std::cerr << "test: sanitize_symbol\n";

    auto ok = [](const std::string& in, const std::string& expected) {
        auto out = sanitize_symbol(in);
        assert(out.has_value());
        assert(*out == expected);
        std::cerr << "  " << in << " -> " << *out << "\n";
    };

    auto bad = [](const std::string& in) {
        auto out = sanitize_symbol(in);
        assert(!out.has_value());
        std::cerr << "  " << in << " -> rejected\n";
    };

    ok("AAPL", "AAPL");
    ok("aapl", "AAPL");
    ok("BrK-b", "BRK-B");
    ok("GOOG_1", "GOOG_1");
    ok("SPY.US", "SPY.US");

    // valid lengths
    std::string max_symbol(20, 'A');
    ok(max_symbol, max_symbol);
    bad(std::string(21, 'A'));

    bad("");
    bad("AAPL US");          // whitespace
    bad("AAPL/USD");         // path separator
    bad("AAPL\\USD");        // backslash
    bad("C:AAPL");           // drive colon
    bad("A%20APL");          // percent encoding
    bad("A..B");             // traversal marker
    bad("..");
    bad(".A");               // leading dot
    bad("A.");               // trailing dot
    bad("-A");               // leading hyphen
    bad("A-");               // trailing hyphen
    bad("_A");               // leading underscore
    bad("A_");               // trailing underscore
    bad("A&B");
    bad("A|B");
    bad("A!B");
    bad("A^B");
    bad("A(B)");
    bad("A\"B");
    bad("A\\B");
    bad("A\x00B");           // embedded null

    std::cerr << "  sanitize_symbol passed\n";
}

// =============================================================================
// resolve_data_dir tests
// =============================================================================

static void test_resolve_data_dir() {
    std::cerr << "test: resolve_data_dir\n";

    fs::path base = fs::temp_directory_path() / "orw_path_utils_test";
    fs::remove_all(base);

    fs::path managed = base / "managed";
    fs::path local = base / "local";
    fs::path child = managed / "AAPL";
    fs::path local_child = local / "sub";
    fs::path unrelated = base / "unrelated";

    fs::create_directories(child);
    fs::create_directories(local_child);
    fs::create_directories(unrelated);

    std::string managed_str = managed.string();
    std::string local_str = local.string();

    // empty requested -> managed root
    auto r1 = resolve_data_dir("", managed_str, std::nullopt);
    assert(r1.has_value() && *r1 == fs::canonical(managed));
    std::cerr << "  empty -> " << r1->string() << "\n";

    // exact managed root
    auto r2 = resolve_data_dir(managed_str, managed_str, std::nullopt);
    assert(r2.has_value() && *r2 == fs::canonical(managed));
    std::cerr << "  managed exact -> " << r2->string() << "\n";

    // child of managed root
    auto r3 = resolve_data_dir(child.string(), managed_str, std::nullopt);
    assert(r3.has_value() && *r3 == fs::canonical(child));
    std::cerr << "  managed child -> " << r3->string() << "\n";

    // child via forward slash separator
    auto r4 = resolve_data_dir(managed_str + "/AAPL", managed_str, std::nullopt);
    assert(r4.has_value() && *r4 == fs::canonical(child));
    std::cerr << "  forward slash child -> " << r4->string() << "\n";

    // child of local root
    auto r5 = resolve_data_dir(local_child.string(), managed_str, local_str);
    assert(r5.has_value() && *r5 == fs::canonical(local_child));
    std::cerr << "  local child -> " << r5->string() << "\n";

    // child via backslash separator (Windows)
    auto r6 = resolve_data_dir(local_str + "\\sub", managed_str, local_str);
    assert(r6.has_value() && *r6 == fs::canonical(local_child));
    std::cerr << "  backslash child -> " << r6->string() << "\n";

    // .. traversal rejected
    auto r7 = resolve_data_dir((local_child / ".." / "..").string(), managed_str, local_str);
    assert(!r7.has_value());
    std::cerr << "  .. traversal rejected\n";

    // encoded traversal rejected
    auto r8 = resolve_data_dir((managed / "%2e%2e").string(), managed_str, std::nullopt);
    assert(!r8.has_value());
    std::cerr << "  %% encoded traversal rejected\n";

    // unrelated directory rejected
    auto r9 = resolve_data_dir(unrelated.string(), managed_str, local_str);
    assert(!r9.has_value());
    std::cerr << "  unrelated dir rejected\n";

    // absolute unrelated path rejected (use Windows/Temp root, not in allowed roots)
    fs::path abs_unrelated = fs::temp_directory_path().root_path() / "Windows";
    if (fs::exists(abs_unrelated) && fs::is_directory(abs_unrelated)) {
        auto r10 = resolve_data_dir(abs_unrelated.string(), managed_str, local_str);
        assert(!r10.has_value());
        std::cerr << "  absolute unrelated rejected\n";
    }

    // non-existent directory
    auto r11 = resolve_data_dir((base / "nope").string(), managed_str, std::nullopt);
    assert(!r11.has_value());
    std::cerr << "  non-existent dir rejected\n";

    fs::remove_all(base);
    std::cerr << "  resolve_data_dir passed\n";
}

// =============================================================================
// child_process tests
// =============================================================================

static std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    for (unsigned char c : s) {
        if (c == '\\') {
            out += "\\\\";
        } else if (c == '"') {
            out += "\\\"";
        } else if (c < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
        } else {
            out += static_cast<char>(c);
        }
    }
    return out;
}

static std::string json_array_string(const std::vector<std::string>& v) {
    std::string out = "[";
    for (std::size_t i = 0; i < v.size(); ++i) {
        if (i > 0) out += ", ";
        out += '"';
        out += json_escape(v[i]);
        out += '"';
    }
    out += "]";
    return out;
}

static void test_run_child_process() {
    std::cerr << "test: run_child_process\n";

    std::vector<std::string> payload = {
        "arg with space",
        "%",
        "!",
        "^",
        "&",
        "|",
        "(",
        ")",
        "\"quote\"",
        "back\\",
        "üñι¢óδé"
    };

    fs::path temp = fs::temp_directory_path() / "orw_child_test.json";
    fs::remove(temp);

    // python -c "..." <temp> <payload...>
    std::string script =
        "import json,sys; open(sys.argv[1],'w',encoding='utf-8').write("
        "json.dumps(sys.argv[2:], ensure_ascii=False))";

    std::vector<std::string> args = {"-c", script, temp.string()};
    args.insert(args.end(), payload.begin(), payload.end());

    std::cerr << "  launching python child\n";
    int rc1 = run_child_process("python", args);
    if (rc1 != 0) {
        std::cerr << "  run_child_process returned " << rc1 << "\n";
    }
    assert(rc1 == 0);

    std::string expected_json = json_array_string(payload);

    std::string verify_script =
        "import json,sys; got=json.load(open(sys.argv[1],encoding='utf-8')); "
        "expected=json.loads(sys.argv[2]); "
        "sys.exit(0 if got==expected else 1)";

    std::vector<std::string> verify_args = {
        "-c", verify_script, temp.string(), expected_json
    };

    std::cerr << "  verifying argv round-trip\n";
    int rc2 = run_child_process("python", verify_args);
    if (rc2 != 0) {
        std::cerr << "  argv round-trip mismatch (exit " << rc2 << ")\n";
    }
    assert(rc2 == 0);

    fs::remove(temp);
    std::cerr << "  run_child_process passed\n";
}

// =============================================================================
// Main
// =============================================================================

int main() {
    test_sanitize_symbol();
    test_resolve_data_dir();
    test_run_child_process();

    std::cerr << "\nAll engine utility tests passed.\n";
    return 0;
}
