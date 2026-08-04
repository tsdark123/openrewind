#include "child_process.hpp"

#include <cerrno>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <process.h>
#include <io.h>
#else
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace {

#ifdef _WIN32

// Convert a UTF-8 std::string to a null-terminated UTF-16 std::wstring.
std::wstring to_wstring(const std::string& s) {
    if (s.empty()) {
        return std::wstring();
    }

    int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                       s.c_str(), -1, nullptr, 0);
    if (required <= 0) {
        // Fallback: copy each byte as a code unit.  This only happens for
        // invalid UTF-8 when MB_ERR_INVALID_CHARS is set.
        std::wstring out;
        out.reserve(s.size());
        for (unsigned char c : s) {
            out.push_back(static_cast<wchar_t>(c));
        }
        return out;
    }

    std::vector<wchar_t> buf(static_cast<std::size_t>(required), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                        s.c_str(), -1, buf.data(), required);

    // The buffer's last element is the null terminator; construct a wstring
    // that does not include it in its length but is still null-terminated.
    return std::wstring(buf.data(), buf.size() - 1);
}

// Quote a single argument for a CreateProcessW command-line string using the
// CommandLineToArgvW rules.
std::wstring quote_arg(const std::wstring& arg) {
    if (arg.find_first_of(L" \"\t\n\v") == std::wstring::npos) {
        return arg;
    }

    std::wstring out;
    out.reserve(arg.size() + 2);
    out.push_back(L'"');

    std::size_t backslash_run = 0;
    for (wchar_t c : arg) {
        if (c == L'\\') {
            ++backslash_run;
        } else if (c == L'"') {
            out.append(backslash_run * 2, L'\\');
            backslash_run = 0;
            out += L"\\\"";
        } else {
            out.append(backslash_run, L'\\');
            backslash_run = 0;
            out += c;
        }
    }

    // Double the trailing backslashes before the closing quote.
    out.append(backslash_run * 2, L'\\');
    out.push_back(L'"');
    return out;
}

int run_with_createprocess(const std::wstring& /*program*/,
                           const std::vector<std::wstring>& wargs) {
    std::wostringstream cmdline;
    cmdline << quote_arg(wargs[0]);
    for (std::size_t i = 1; i < wargs.size(); ++i) {
        cmdline << L' ' << quote_arg(wargs[i]);
    }

    std::wstring cmd = cmdline.str();

    STARTUPINFOW si = {};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi = {};

    // CreateProcessW modifies the command-line buffer, so copy into a writable
    // vector.
    std::vector<wchar_t> cmd_buf(cmd.begin(), cmd.end());
    cmd_buf.push_back(L'\0');

    if (!CreateProcessW(
            nullptr,
            cmd_buf.data(),
            nullptr,
            nullptr,
            TRUE,
            0,
            nullptr,
            nullptr,
            &si,
            &pi)) {
        return -1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exit_code = 0;
    if (!GetExitCodeProcess(pi.hProcess, &exit_code)) {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return -1;
    }

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return static_cast<int>(exit_code);
}

int run_with_wspawnvp(const std::wstring& program,
                      const std::vector<std::wstring>& wargs) {
    std::vector<const wchar_t*> argv;
    argv.reserve(wargs.size() + 1);
    for (const auto& a : wargs) {
        argv.push_back(a.c_str());
    }
    argv.push_back(nullptr);

    (void)program; // argv[0] is already the program.
    intptr_t rc = _wspawnvp(_P_WAIT, wargs[0].c_str(),
                            reinterpret_cast<const wchar_t* const*>(argv.data()));
    if (rc == -1) {
        return -1;
    }
    return static_cast<int>(rc);
}

#endif // _WIN32

} // namespace

int run_child_process(const std::string& program, const std::vector<std::string>& args) {
#ifdef _WIN32
    std::vector<std::wstring> wargs;
    wargs.reserve(args.size() + 1);
    wargs.push_back(to_wstring(program));
    for (const auto& a : args) {
        wargs.push_back(to_wstring(a));
    }

    // _wspawnvp is the preferred direct launcher, but some CRT builds
    // construct an unquoted command-line string from argv, which breaks
    // arguments that contain spaces or quotes.  Use CreateProcessW with a
    // manually quoted command line in those cases, or if _wspawnvp fails.
    bool needs_quoting = false;
    for (const auto& a : wargs) {
        if (a.find_first_of(L" \"\t\n\v") != std::wstring::npos) {
            needs_quoting = true;
            break;
        }
    }

    int rc = -1;
    if (!needs_quoting) {
        rc = run_with_wspawnvp(wargs[0], wargs);
    }
    if (rc == -1) {
        rc = run_with_createprocess(wargs[0], wargs);
    }
    return rc;
#else
    std::vector<std::string> arg_storage;
    arg_storage.reserve(args.size() + 1);
    arg_storage.push_back(program);
    for (const auto& a : args) {
        arg_storage.push_back(a);
    }

    std::vector<char*> argv;
    argv.reserve(arg_storage.size() + 1);
    for (auto& s : arg_storage) {
        argv.push_back(s.data());
    }
    argv.push_back(nullptr);

    extern char** environ;
    pid_t pid = 0;
    int status = posix_spawnp(&pid, program.c_str(), nullptr, nullptr,
                              argv.data(), environ);
    if (status != 0) {
        return -1;
    }

    int child_status = 0;
    pid_t waited = waitpid(pid, &child_status, 0);
    if (waited == -1) {
        return -1;
    }

    if (WIFEXITED(child_status)) {
        return WEXITSTATUS(child_status);
    }
    if (WIFSIGNALED(child_status)) {
        return 128 + WTERMSIG(child_status);
    }
    return -1;
#endif
}
