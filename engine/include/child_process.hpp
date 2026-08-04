#pragma once

#include <string>
#include <vector>

// =============================================================================
// Child process launcher.
//
// Launch `program` directly (no shell) with the given argv.  Block until the
// child exits and return its exit code, or -1 if the launch failed.
//
// On Windows the program and arguments are converted from UTF-8 to UTF-16 and
// passed to _wspawnvp(_P_WAIT, ...) when no argument contains spaces or quotes.
// If _wspawnvp is unavailable, or if an argument needs quoting, the function
// falls back to CreateProcessW with a manually quoted command-line string.
//
// On POSIX systems the function uses posix_spawnp + waitpid.
//
// Arguments are passed unchanged to the child — no %, !, ^, &, |, quote,
// parenthesis or backslash interpretation is performed.
// =============================================================================

int run_child_process(const std::string& program, const std::vector<std::string>& args);
