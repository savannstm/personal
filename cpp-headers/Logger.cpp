#include "Logger.hpp"

#include "Numbers.hpp"
#include "StringBuilder.hpp"

#include <chrono>
#include <fstream>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

#ifndef APP_NAME
#error "Logger.cpp: define APP_NAME as a string literal, e.g. -DAPP_NAME=\"myapp\""
#endif

// if source root wasn't auto-generated we still need something
#ifndef APP_SOURCE_ROOT
#define APP_SOURCE_ROOT ""
#endif

namespace {
constexpr auto APP_NAME_VIEW = string_view(APP_NAME);

// Bounds the live file, and with the rotation in openFile() bounds the whole footprint at twice this.
constexpr u64 MAX_LOG_BYTES = u64{ 1 } << 20;

constexpr string_view RESET_COLOR = "\x1b[0m";

mutex sink;
std::ofstream logFile;
bool colored = false;
bool enabled = false;

// Lines written before openFile() picked a destination. Anything logged early in startup belongs in the
// file as much as anything after it. Cleared once, at open.
vector<string> pending;

// what the file already holds plus what this run has added; the cap is checked per line, since the
// startup check alone lets one long session grow without bound
u64 logBytes = 0;
bool logFull = false;

auto processId() -> u32 {
#ifdef _WIN32
    return GetCurrentProcessId();
#else
    return u32(getpid());
#endif
}

constexpr auto levelName(const LogLevel level) -> string_view {
    switch (level) {
        case LogLevel::Info:
            return "INFO";
        case LogLevel::Warning:
            return "WARN";
        case LogLevel::Error:
            return "ERROR";
    }

    std::unreachable();
}

constexpr auto levelColor(const LogLevel level) -> string_view {
    switch (level) {
        case LogLevel::Info:
            return "\x1b[1;36m";
        case LogLevel::Warning:
            return "\x1b[1;33m";
        case LogLevel::Error:
            return "\x1b[1;31m";
    }

    std::unreachable();
}

constexpr auto sameChar(const char left, const char right) -> bool {
    const auto fold = [](const char chr) -> char {
        if (chr == '\\') {
            return '/';
        }

        return chr >= 'A' && chr <= 'Z' ? char(chr - 'A' + 'a') : chr;
    };

    return fold(left) == fold(right);
}

auto relativeToRoot(const char* const file) -> string_view {
    constexpr auto root = string_view(APP_SOURCE_ROOT);
    const auto full = string_view(file);

    if (root.empty() || full.size() <= root.size()) {
        return full;
    }

    for (usize index = 0; index < root.size(); index++) {
        if (!sameChar(full[index], root[index])) {
            return full;
        }
    }

    string_view relative = full.substr(root.size());

    while (!relative.empty() && (relative.front() == '/' || relative.front() == '\\')) {
        relative.remove_prefix(1);
    }

    return relative;
}

// function_name() is a whole signature. Everything before the argument list, past the last space,
// is the qualified name - which is what is worth reading in a log line.
auto functionName(const char* const signature) -> string_view {
    auto full = string_view(signature);

    if (const usize paren = full.find('('); paren != string_view::npos) {
        full = full.substr(0, paren);
    }

    const usize space = full.rfind(' ');
    return space == string_view::npos ? full : full.substr(space + 1);
}

auto locationText(const std::source_location& where) -> string {
    const string_view relative = relativeToRoot(where.file_name());
    const Digits<> line = itos(where.line());

    string out;
    out.reserve(relative.size() + line.size() + 1);

    for (const char chr : relative) {
        out.push_back(chr == '\\' ? '/' : chr);
    }

    out.push_back(':');
    out.append(line.data(), line.size());

    return out;
}
}  // namespace

void logging::init(const bool enable) {
    enabled = enable;

    if (!enabled) {
        return;
    }

#ifdef _WIN32
    // a GUI-subsystem exe has no console of its own; attach the parent's if launched from one
    if (AttachConsole(ATTACH_PARENT_PROCESS) != 0) {
        FILE* stream = nullptr;
        freopen_s(&stream, "CONOUT$", "w", stdout);
        freopen_s(&stream, "CONOUT$", "w", stderr);

        const HANDLE handle = GetStdHandle(STD_ERROR_HANDLE);
        DWORD mode = 0;

        colored = GetConsoleMode(handle, &mode) != 0 &&
                  SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0;
    }
#else
    colored = isatty(STDERR_FILENO) != 0;
#endif
}

void logging::openFile(const LogFile which, const path& directory) {
    if (!enabled) {
        return;
    }

    const auto guard = std::scoped_lock(sink);

    const string name = which == LogFile::Shared ? (APP_NAME_VIEW % ".log"sv).str()
                                                 : (APP_NAME_VIEW % "-"sv % processId() % ".log"sv).str();
    const path file = directory / name;

    std::error_code error;

    // One generation back, kept rather than deleted: the run worth reading is usually the one that just
    // went wrong, and relaunching to look at the log is what would otherwise destroy it.
    if (const u64 size = fs::file_size(file, error); !error && size > MAX_LOG_BYTES) {
        fs::rename(file, directory / (APP_NAME_VIEW % ".log.1"sv).str(), error);
    }

    logFile.open(file, std::ios::app);

    if (!logFile.is_open()) {
        println(cerr, "could not open the log file at {}", file.string());
        pending.clear();
        pending.shrink_to_fit();
        return;
    }

    const u64 carried = fs::file_size(file, error);
    logBytes = error ? 0 : carried;

    const auto started = std::chrono::floor<std::chrono::seconds>(std::chrono::system_clock::now());
    println(logFile, "\n=== {} {} started {:%d-%m-%Y %H:%M:%S} ===", APP_NAME, itos(processId()).view(), started);

    for (const string& line : pending) {
        logBytes += line.size() + 1;
        println(logFile, "{}", line);
    }

    pending.clear();
    pending.shrink_to_fit();

    logFile.flush();
}

void logging::write(const LogLevel level, const std::source_location& where, const string_view message) {
    if (!enabled) {
        return;
    }

    const string location = locationText(where);
    const string_view function = functionName(where.function_name());
    const string_view name = levelName(level);

    const string line = "["sv % name % "] "sv % location % " "sv % function % ": "sv % message;

    const auto guard = std::scoped_lock(sink);

    if (colored) {
        println(cerr, "{}[{}]{} {} {}: {}", levelColor(level), name, RESET_COLOR, location, function, message);
    } else {
        println(cerr, "{}", line);
    }

    if (logFull) {
        return;
    }

    // openFile() has not run yet, and may never
    if (!logFile.is_open()) {
        pending.push_back(line);
        return;
    }

    logBytes += line.size() + 1;

    if (logBytes > MAX_LOG_BYTES) {
        logFull = true;
        println(
            logFile,
            "=== log reached {} MB and stops here; restart {} for a fresh one ===",
            itos(MAX_LOG_BYTES >> 20).view(),
            APP_NAME
        );
    } else {
        println(logFile, "{}", line);
    }

    logFile.flush();
}
