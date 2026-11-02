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

// Bounds the live file, and with the rotation in openFile() bounds the shared
// log's footprint at twice this.
constexpr u64 MAX_LOG_BYTES = u64{ 1 } << 20;

// Per-process names never repeat, so the size rotation never meets an old file:
// the newest this many (the current run included) are kept instead.
constexpr usize MAX_PER_PROCESS_LOGS = 5;

constexpr string_view RESET_COLOR = "\x1b[0m";

mutex sink;
std::ofstream logFile;
bool colored = false;
bool enabled = false;

// Lines written before openFile() picked a destination. Anything logged early
// in startup belongs in the file as much as anything after it. Cleared once, at
// open; capped at MAX_LOG_BYTES, since openFile() may never run.
vector<string> pending;
u64 pendingBytes = 0;

// what the file already holds plus what this run has added; the cap is checked
// per line, since the startup check alone lets one long session grow without
// bound
u64 logBytes = 0;
// the file takes no more lines: the cap was reached, or it could not be opened
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

        return chr >= 'A' && chr <= 'Z' ? static_cast<char>(chr - 'A' + 'a') : chr;
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

// function_name() is a whole signature. Everything before the argument list,
// past the last space, is the qualified name - which is what is worth reading
// in a log line.
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

// Deletes the oldest "<APP_NAME>-<digits>.log" files in `directory`, leaving room for the one about to be created.
void prunePerProcessLogs(const path& directory) {
    const string prefix = (APP_NAME_VIEW % "-"sv).str();
    constexpr auto suffix = ".log"sv;

    vector<pair<fs::file_time_type, path>> logs;
    std::error_code error;

    auto entries = fs::directory_iterator(directory, error);

    for (; !error && entries != fs::directory_iterator(); entries.increment(error)) {
        const string name = entries->path().filename().string();

        if (name.size() <= prefix.size() + suffix.size() || !name.starts_with(prefix) || !name.ends_with(suffix)) {
            continue;
        }

        const string_view digits = string_view(name).substr(prefix.size(), name.size() - prefix.size() - suffix.size());

        if (ranges::all_of(digits, [](const char chr) -> bool { return chr >= '0' && chr <= '9'; })) {
            logs.emplace_back(entries->last_write_time(error), entries->path());
        }
    }

    if (logs.size() < MAX_PER_PROCESS_LOGS) {
        return;
    }

    ranges::sort(logs, [](const auto& left, const auto& right) -> bool { return left.first > right.first; });

    for (const auto& [time, file] : logs | views::drop(MAX_PER_PROCESS_LOGS - 1)) {
        fs::remove(file, error);
    }
}
}  // namespace

void logging::init(const bool enable) {
    enabled = enable;

    if (!enabled) {
        return;
    }

#ifdef _WIN32
    // a GUI-subsystem exe has no console of its own; attach the parent's if
    // launched from one
    if (AttachConsole(ATTACH_PARENT_PROCESS) != 0) {
        FILE* stream = nullptr;
        freopen_s(&stream, "CONOUT$", "w", stdout);
        freopen_s(&stream, "CONOUT$", "w", stderr);

        void* const handle = GetStdHandle(STD_ERROR_HANDLE);
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

    if (which == LogFile::PerProcess) {
        prunePerProcessLogs(directory);
    } else if (const u64 size = fs::file_size(file, error); !error && size > MAX_LOG_BYTES) {
        // One generation back, kept rather than deleted: the run worth reading is
        // usually the one that just went wrong, and relaunching to look at the log is
        // what would otherwise destroy it.
        fs::rename(file, directory / (APP_NAME_VIEW % ".log.1"sv).str(), error);
    }

    logFile.open(file, std::ios::app);

    if (!logFile.is_open()) {
        println(cerr, "could not open the log file at {}", file.string());
        pending.clear();
        pending.shrink_to_fit();
        logFull = true;
        return;
    }

    const u64 carried = fs::file_size(file, error);
    logBytes = error ? 0 : carried;

    const auto started = std::chrono::floor<std::chrono::seconds>(std::chrono::system_clock::now());
    println(logFile, "\n=== {} {} started {:%d-%m-%Y %H:%M:%S} UTC ===", APP_NAME, itos(processId()).view(), started);

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
        if (pendingBytes + line.size() + 1 <= MAX_LOG_BYTES) {
            pendingBytes += line.size() + 1;
            pending.push_back(line);
        }

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
