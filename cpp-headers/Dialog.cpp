#include "Dialog.hpp"

#include "Logger.hpp"
#include "tinyfiledialogs.h"

#include <FL/Fl_Color_Chooser.H>
#include <FL/Fl_Native_File_Chooser.H>
#include <FL/fl_ask.H>

#ifndef APP_NAME
#error "Dialog.cpp: define APP_NAME as a string literal, e.g. -DAPP_NAME=\"myapp\""
#endif

namespace {
// tinyfd does not allow quotes in the messages - requote to Unicode equivalents
auto requote(const string_view message) -> string {
    string out;
    out.reserve(message.size());

    for (const char chr : message) {
        switch (chr) {
            case '"':
                out += "”";
                break;
            case '\'':
            case '`':
                out += "’";
                break;
            default:
                out.push_back(chr);
                break;
        }
    }

    return out;
}

// Passing "tinyfd_query" as a dialog's title makes tinyfd report the backend it would use, without
// opening anything, as its own return value: every tinyfd_*Dialog/tinyfd_messageBox/tinyfd_notifyPopup
// returns a truthy (non-NULL / non-zero) sentinel for a real GUI backend (native, applescript, zenity,
// kdialog, tkinter, ...) and a falsy one for the "dialog"/"whiptail"/"basicinput"/"no_solution" console
// fallbacks (see tinyfiledialogs.h) - e.g. a Linux session with none of zenity/kdialog/tkinter installed.
// Each check below is cached in a function-local static since the desktop's backend can't change
// mid-run and probing it on unix shells out to detect each candidate binary.
auto tinyfdMessageBoxIsGraphical() -> bool {
    static const bool graphical = tinyfd_messageBox("tinyfd_query", "", "ok", "info", 1) != 0;
    return graphical;
}

auto tinyfdNotifyPopupIsGraphical() -> bool {
    static const bool graphical = tinyfd_notifyPopup("tinyfd_query", "", "info") != 0;
    return graphical;
}

auto tinyfdColorChooserIsGraphical() -> bool {
    static const bool graphical = [] -> bool {
        array<u8, 3> rgb{};
        return tinyfd_colorChooser("tinyfd_query", nullptr, rgb.data(), rgb.data()) != nullptr;
    }();

    return graphical;
}

auto tinyfdInputBoxIsGraphical() -> bool {
    static const bool graphical = tinyfd_inputBox("tinyfd_query", nullptr, nullptr) != nullptr;
    return graphical;
}

auto tinyfdSelectFolderDialogIsGraphical() -> bool {
    static const bool graphical = tinyfd_selectFolderDialog("tinyfd_query", nullptr) != nullptr;
    return graphical;
}

constexpr i32 PROMPT_MAX_LENGTH = 1024;  // matches tinyfd_response's own buffer size

auto nativeFilterString(const string_view allLabel, const span<const FilterGroup> groups) -> string {
    if (groups.empty()) {
        return {};
    }

    const auto appendExtension = [](string& out, const string_view glob, const bool first) -> void {
        if (!first) {
            out += ',';
        }

        out += glob.starts_with("*."sv) ? glob.substr(2) : glob;
    };

    string result;
    result += allLabel;
    result += "	*.{";

    bool first = true;

    for (const FilterGroup& group : groups) {
        for (const string_view glob : group.globs) {
            appendExtension(result, glob, first);
            first = false;
        }
    }

    result += '}';

    for (const FilterGroup& group : groups) {
        result += '\n';

        for (const char chr : group.label) {
            result += chr == '\t' || chr == '\n' ? ' ' : chr;
        }

        result += "	*.{";
        first = true;

        for (const string_view glob : group.globs) {
            appendExtension(result, glob, first);
            first = false;
        }

        result += '}';
    }

    return result;
}

}  // namespace

void showWarning(const string_view message, const std::source_location& where) {
    logging::write(LogLevel::Warning, where, message);

    if (tinyfdMessageBoxIsGraphical()) {
        tinyfd_messageBox(APP_NAME, requote(message).c_str(), "ok", "warning", 1);
    } else {
        fl_alert("%s", string(message).c_str());
    }
}

void showInfo(const string_view message, const std::source_location& where) {
    logging::write(LogLevel::Info, where, message);

    if (tinyfdMessageBoxIsGraphical()) {
        tinyfd_messageBox(APP_NAME, requote(message).c_str(), "ok", "info", 1);
    } else {
        fl_message("%s", string(message).c_str());
    }
}

auto showConfirm(const string_view message, const std::source_location& where) -> bool {
    logging::write(LogLevel::Warning, where, message);

    if (tinyfdMessageBoxIsGraphical()) {
        return tinyfd_messageBox(APP_NAME, requote(message).c_str(), "yesno", "warning", 0) != 0;
    }

    return fl_choice("%s", "No", "Yes", nullptr, string(message).c_str()) == 1;
}

auto showChoice(
    const string_view message,
    const string_view primary,
    const string_view secondary,
    const std::source_location& where
) -> Choice {
    logging::write(LogLevel::Warning, where, message);

    if (tinyfdMessageBoxIsGraphical()) {
        switch (tinyfd_messageBox(APP_NAME, requote(message).c_str(), "yesnocancel", "question", 1)) {
            case 1:
                return Choice::Primary;
            case 2:
                return Choice::Secondary;
            default:
                return Choice::Cancel;
        }
    }

    switch (fl_choice("%s", "Cancel", string(primary).c_str(), string(secondary).c_str(), string(message).c_str())) {
        case 1:
            return Choice::Primary;
        case 2:
            return Choice::Secondary;
        default:
            return Choice::Cancel;
    }
}

void showNotification(const string_view title, const string_view message, const string_view iconType) {
    if (tinyfdNotifyPopupIsGraphical()) {
        tinyfd_notifyPopup(requote(title).c_str(), requote(message).c_str(), string(iconType).c_str());
        return;
    }

    fl_message("%s", string(message).c_str());
}

auto pickColor(const string_view title, u8& red, u8& green, u8& blue) -> bool {
    if (tinyfdColorChooserIsGraphical()) {
        const array<u8, 3> defaultRgb = { red, green, blue };
        array<u8, 3> resultRgb{};

        if (tinyfd_colorChooser(requote(title).c_str(), nullptr, defaultRgb.data(), resultRgb.data()) == nullptr) {
            return false;
        }

        red = resultRgb[0];
        green = resultRgb[1];
        blue = resultRgb[2];
        return true;
    }

    f64 redD = f64(red) / UINT8_MAX;
    f64 greenD = f64(green) / UINT8_MAX;
    f64 blueD = f64(blue) / UINT8_MAX;

    if (fl_color_chooser(string(title).c_str(), redD, greenD, blueD) == 0) {
        return false;
    }

    red = u8(redD * UINT8_MAX);
    green = u8(greenD * UINT8_MAX);
    blue = u8(blueD * UINT8_MAX);
    return true;
}

auto promptInput(const string_view title, const string_view message, const string_view defaultText)
    -> optional<string> {
    if (tinyfdInputBoxIsGraphical()) {
        char* const result =
            tinyfd_inputBox(requote(title).c_str(), requote(message).c_str(), requote(defaultText).c_str());
        return result == nullptr ? nullopt : optional(string(result));
    }

    const char* const result = fl_input(PROMPT_MAX_LENGTH, "%s", string(defaultText).c_str(), string(message).c_str());
    return result == nullptr ? nullopt : optional(string(result));
}

auto promptPassword(const string_view title, const string_view message) -> optional<string> {
    if (tinyfdInputBoxIsGraphical()) {
        // NULL default (as opposed to "") is what puts tinyfd_inputBox into password-masked mode
        char* const result = tinyfd_inputBox(requote(title).c_str(), requote(message).c_str(), nullptr);
        return result == nullptr ? nullopt : optional(string(result));
    }

    const char* const result = fl_password(PROMPT_MAX_LENGTH, "%s", "", string(message).c_str());
    return result == nullptr ? nullopt : optional(string(result));
}

auto pickOpenFile(
    const string_view title,
    const string_view defaultPath,
    const span<const FilterGroup> groups,
    const string_view allLabel,
    const bool allowMultiple
) -> vector<string> {
    auto chooser = Fl_Native_File_Chooser(
        allowMultiple ? Fl_Native_File_Chooser::BROWSE_MULTI_FILE : Fl_Native_File_Chooser::BROWSE_FILE
    );
    chooser.title(string(title).c_str());

    if (!defaultPath.empty()) {
        chooser.directory(string(defaultPath).c_str());
    }

    if (const string filter = nativeFilterString(allLabel, groups); !filter.empty()) {
        chooser.filter(filter.c_str());
    }

    if (chooser.show() != 0) {
        return {};
    }

    vector<string> files;
    files.reserve(scast<usize>(chooser.count()));

    for (i32 index = 0; index < chooser.count(); index++) {
        files.emplace_back(chooser.filename(index));
    }

    return files;
}

auto pickSaveFile(
    const string_view title,
    const string_view defaultPath,
    const span<const FilterGroup> groups,
    const string_view allLabel
) -> optional<string> {
    auto chooser = Fl_Native_File_Chooser(Fl_Native_File_Chooser::BROWSE_SAVE_FILE);
    chooser.title(string(title).c_str());
    chooser.options(Fl_Native_File_Chooser::SAVEAS_CONFIRM);

    if (!defaultPath.empty()) {
        chooser.preset_file(string(defaultPath).c_str());
    }

    if (const string filter = nativeFilterString(allLabel, groups); !filter.empty()) {
        chooser.filter(filter.c_str());
    }

    if (chooser.show() != 0) {
        return nullopt;
    }

    const char* const name = chooser.filename();
    return name == nullptr || *name == '\0' ? nullopt : optional(string(name));
}

auto pickFolder(const string_view title, const string_view defaultPath) -> optional<string> {
    if (tinyfdSelectFolderDialogIsGraphical()) {
        const char* const result = tinyfd_selectFolderDialog(requote(title).c_str(), string(defaultPath).c_str());
        return result == nullptr ? nullopt : optional(string(result));
    }

    auto chooser = Fl_Native_File_Chooser(Fl_Native_File_Chooser::BROWSE_DIRECTORY);
    chooser.title(string(title).c_str());

    if (!defaultPath.empty()) {
        chooser.directory(string(defaultPath).c_str());
    }

    if (chooser.show() != 0) {
        return nullopt;
    }

    return string(chooser.filename());
}

void beep() {
    tinyfd_beep();
}

void showError(const string_view message, const std::source_location& where) {
    logging::write(LogLevel::Error, where, message);

    if (tinyfdMessageBoxIsGraphical()) {
        tinyfd_messageBox(APP_NAME, requote(message).c_str(), "ok", "error", 1);
    } else {
        fl_alert("%s", string(message).c_str());
    }
}
