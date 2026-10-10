#pragma once

// Requires: "Aliases.hpp", and in Logger.cpp: "Numbers.hpp", "StringBuilder.hpp", compile definitions
// APP_NAME (string literal, e.g. "yuri") and optionally APP_SOURCE_ROOT (string literal, stripped from file names).

#include "Aliases.hpp"

#include <source_location>

enum class LogLevel : u8 {
    Info,
    Warning,
    Error,
};

enum class LogFile : u8 {
    // <APP_NAME>.log
    Shared,
    // <APP_NAME>-<pid>.log
    PerProcess,
};

namespace logging {
void init(bool enabled);

// Opens the log in `directory` and flushes everything buffered since init()
void openFile(LogFile which, const path& directory);

void write(LogLevel level, const std::source_location& where, string_view message);
}  // namespace logging

template <typename... Args>
struct LogFormat final {
    template <typename T>
        requires std::constructible_from<std::format_string<Args...>, T>
    consteval LogFormat(const T& text, const std::source_location& where = std::source_location::current()) :
        where(where),
        text(text) {}

    std::source_location where;
    std::format_string<Args...> text;
};

template <typename... Args>
void logInfo(LogFormat<std::type_identity_t<Args>...> message, Args&&... args) {
    logging::write(LogLevel::Info, message.where, format(message.text, std::forward<Args>(args)...));
}

template <typename... Args>
void logWarning(LogFormat<std::type_identity_t<Args>...> message, Args&&... args) {
    logging::write(LogLevel::Warning, message.where, format(message.text, std::forward<Args>(args)...));
}

template <typename... Args>
void logError(LogFormat<std::type_identity_t<Args>...> message, Args&&... args) {
    logging::write(LogLevel::Error, message.where, format(message.text, std::forward<Args>(args)...));
}
