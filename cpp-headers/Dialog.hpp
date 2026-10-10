#pragma once

// Requires: "Aliases.hpp", "Logger.hpp" (in Dialog.cpp), tinyfiledialogs, FLTK (fallback dialogs when tinyfd has no
// graphical backend, and Fl_Native_File_Chooser for file pickers), compile definition APP_NAME.

#include "Aliases.hpp"

#include <source_location>

struct FilterGroup final {
    vector<string_view> globs;
    string_view label;
};

void showError(string_view message, const std::source_location& where = std::source_location::current());
void showWarning(string_view message, const std::source_location& where = std::source_location::current());
void showInfo(string_view message, const std::source_location& where = std::source_location::current());

[[nodiscard]] auto showConfirm(string_view message, const std::source_location& where = std::source_location::current())
    -> bool;

enum class Choice : u8 {
    Primary,
    Secondary,
    Cancel,
};

[[nodiscard]] auto showChoice(
    string_view message,
    string_view primary,
    string_view secondary,
    const std::source_location& where = std::source_location::current()
) -> Choice;

void showNotification(string_view title, string_view message, string_view iconType = "info");

[[nodiscard]] auto pickColor(string_view title, u8& red, u8& green, u8& blue) -> bool;

[[nodiscard]] auto promptInput(string_view title, string_view message, string_view defaultText = "")
    -> optional<string>;
[[nodiscard]] auto promptPassword(string_view title, string_view message) -> optional<string>;

[[nodiscard]] auto pickOpenFile(
    string_view title,
    string_view defaultPath,
    span<const FilterGroup> groups,
    string_view allLabel,
    bool allowMultiple = false
) -> vector<string>;

[[nodiscard]] auto
pickSaveFile(string_view title, string_view defaultPath, span<const FilterGroup> groups, string_view allLabel)
    -> optional<string>;

[[nodiscard]] auto pickFolder(string_view title, string_view defaultPath = "") -> optional<string>;

void beep();
