// PGO trainer for nuspell: for each dictionary, spell-checks a sample of its words (as written, capitalized and
// upper-cased) and misspelled variants of them, and asks for suggestions for part of the misspellings, as a
// spell-checking editor does.
// argv[1..]: .aff paths; the .dic next to each is read for the word sample.

#include <nuspell/dictionary.hxx>

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

namespace {
    // Code points of a UTF-8 string, so misspellings never split a multi-byte character.
    auto decode(const std::string &text) -> std::u32string {
        std::u32string out;
        out.reserve(text.size());
        for (size_t i = 0; i < text.size();) {
            const auto byte = static_cast<unsigned char>(text[i]);
            const int length = byte < 0x80 ? 1 : byte < 0xE0 ? 2 : byte < 0xF0 ? 3 : 4;
            char32_t cp = length == 1 ? byte : byte & (0x7F >> length);
            for (int k = 1; k < length && i + k < text.size(); ++k) {
                cp = (cp << 6) | (static_cast<unsigned char>(text[i + k]) & 0x3F);
            }
            out.push_back(cp);
            i += length;
        }
        return out;
    }

    auto encode(const std::u32string &text) -> std::string {
        std::string out;
        out.reserve(text.size() * 2);
        for (const char32_t cp : text) {
            if (cp < 0x80) {
                out.push_back(static_cast<char>(cp));
            } else if (cp < 0x800) {
                out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
                out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            } else if (cp < 0x10000) {
                out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
                out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
                out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            } else {
                out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
                out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
                out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
                out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            }
        }
        return out;
    }

    // Upper-cases ASCII and basic Cyrillic only: enough to exercise nuspell's casing paths.
    auto upper(char32_t cp) -> char32_t {
        if (cp >= U'a' && cp <= U'z') {
            return cp - 32;
        }
        if (cp >= U'а' && cp <= U'я') {
            return cp - 32;
        }
        return cp == U'ё' ? U'Ё' : cp;
    }

    // One of four typos, chosen by `kind`: swapped neighbours, dropped, doubled or replaced character.
    auto misspell(std::u32string word, unsigned kind) -> std::u32string {
        const size_t at = (kind / 4) % word.size();
        switch (kind % 4) {
            case 0:
                if (at + 1 < word.size()) {
                    std::swap(word[at], word[at + 1]);
                }
                break;
            case 1:
                word.erase(at, 1);
                break;
            case 2:
                word.insert(at, 1, word[at]);
                break;
            default:
                word[at] = word[(at + 1) % word.size()];
                break;
        }
        return word;
    }
} // namespace

auto main(int argc, char **argv) -> int {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <dictionary.aff>...\n", argv[0]);
        return 1;
    }

    unsigned long checked = 0, correct = 0, asked = 0, suggested = 0;
    std::vector<std::string> suggestions;

    for (int arg = 1; arg < argc; ++arg) {
        const std::string aff = argv[arg];
        nuspell::Dictionary dictionary;
        try {
            dictionary.load_aff_dic(aff);
        } catch (const nuspell::Dictionary_Loading_Error &error) {
            std::fprintf(stderr, "nuspell: %s: %s\n", aff.c_str(), error.what());
            return 1;
        }

        // The .dic's stems (before the affix flags), every 7th one, at most 6000.
        std::ifstream dic(aff.substr(0, aff.size() - 4) + ".dic");
        std::vector<std::u32string> words;
        std::string line;
        std::getline(dic, line); // word count
        for (unsigned n = 0; std::getline(dic, line) && words.size() < 6000; ++n) {
            const std::string stem = line.substr(0, line.find('/'));
            if (n % 7 == 0 && stem.size() > 2) {
                words.push_back(decode(stem));
            }
        }

        unsigned kind = 0;
        for (size_t n = 0; n < words.size(); ++n) {
            const auto &word = words[n];
            std::u32string capitalized = word, upperCased = word;
            capitalized[0] = upper(capitalized[0]);
            for (auto &cp : upperCased) {
                cp = upper(cp);
            }

            for (const auto &variant : {word, capitalized, upperCased, misspell(word, kind++), misspell(word, kind++)}) {
                ++checked;
                correct += dictionary.spell(encode(variant));
            }

            // Suggestions are far more expensive than checks; the editor asks for them only on demand.
            if (n % 40 == 0) {
                dictionary.suggest(encode(misspell(word, kind++)), suggestions);
                ++asked;
                suggested += suggestions.size();
            }
        }
    }

    std::printf("nuspell: %lu checked, %lu correct, %lu suggestions for %lu words\n", checked, correct, suggested, asked);
    return 0;
}
