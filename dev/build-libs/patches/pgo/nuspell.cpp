// PGO trainer for nuspell and the ICU it calls on every check (UTF-8 conversion and casing). For each dictionary:
// - prose: spell-checks every word of a public-domain text in the dictionary's language, as an editor does as text is
//   shown (mostly inflected words in running text, capitalized sentence starts, names, apostrophes and hyphens), and asks for
//   suggestions for a few of the misspelled ones (the editor asks only on demand);
// - stems: a sample of the dictionary's own words (as written, capitalized and upper-cased), misspelled and inflected
//   variants of them, compounds, and words with apostrophes, hyphens and digits.
// argv: pairs of a .aff path and the text; the .dic next to each .aff is read for the word sample.

#include <nuspell/dictionary.hxx>

#include <array>
#include <cstdio>
#include <fstream>
#include <iterator>
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

    // The words of a UTF-8 text: letters, with apostrophes and hyphens between them; punctuation (ASCII, guillemets, general
    // punctuation) separates.
    auto tokenize(const std::string &text) -> std::vector<std::string> {
        std::vector<std::string> words;
        std::string word;
        const auto flush = [&]() {
            while (!word.empty() && (word.back() == '\'' || word.back() == '-')) {
                word.pop_back();
            }
            if (!word.empty()) {
                words.push_back(std::move(word));
            }
            word.clear();
        };
        for (size_t i = 0; i < text.size();) {
            const auto byte = static_cast<unsigned char>(text[i]);
            if (byte < 0x80) {
                const bool letter = (byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z');
                if (letter || ((byte == '\'' || byte == '-') && !word.empty())) {
                    word.push_back(static_cast<char>(byte));
                } else {
                    flush();
                }
                ++i;
            } else if ((byte == 0xC2 && i + 1 < text.size() && (static_cast<unsigned char>(text[i + 1]) == 0xA0 || static_cast<unsigned char>(text[i + 1]) == 0xAB || static_cast<unsigned char>(text[i + 1]) == 0xBB)) ||
                       (byte == 0xE2 && i + 1 < text.size() && static_cast<unsigned char>(text[i + 1]) == 0x80)) {
                flush();
                i += byte == 0xC2 ? 2 : 3;
            } else {
                const size_t length = byte < 0xE0 ? 2 : byte < 0xF0 ? 3 : 4;
                word.append(text, i, length);
                i += length;
            }
        }
        flush();
        return words;
    }

    // Common inflection endings of English, Russian and German; applied to every dictionary's stems.
    constexpr std::array<std::u32string_view, 14> SUFFIXES{
        U"s", U"es", U"ed", U"ing", U"ly", U"er", U"en", U"n", U"е", U"ом", U"ами", U"ых", U"ая", U"ть",
    };

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

    for (int arg = 1; arg + 1 < argc; arg += 2) {
        const std::string aff = argv[arg];
        nuspell::Dictionary dictionary;
        try {
            dictionary.load_aff_dic(aff);
        } catch (const nuspell::Dictionary_Loading_Error &error) {
            std::fprintf(stderr, "nuspell: %s: %s\n", aff.c_str(), error.what());
            return 1;
        }

        // The .dic's stems (before the affix flags), every 14th one, at most 3000.
        std::ifstream dic(aff.substr(0, aff.size() - 4) + ".dic");
        std::vector<std::u32string> words;
        std::string line;
        std::getline(dic, line); // word count
        for (unsigned n = 0; std::getline(dic, line) && words.size() < 3000; ++n) {
            const std::string stem = line.substr(0, line.find('/'));
            if (n % 14 == 0 && stem.size() > 2) {
                words.push_back(decode(stem));
            }
        }

        // Prose: the words of the text, four times over.
        std::ifstream proseFile(argv[arg + 1]);
        const std::string prose((std::istreambuf_iterator<char>(proseFile)), std::istreambuf_iterator<char>());
        const auto tokens = tokenize(prose);
        if (tokens.empty()) {
            std::fprintf(stderr, "nuspell: no text in %s\n", argv[arg + 1]);
            return 1;
        }
        unsigned misspelled = 0;
        for (int pass = 0; pass < 4; ++pass) {
            for (const auto &token : tokens) {
                ++checked;
                if (dictionary.spell(token)) {
                    ++correct;
                } else if (++misspelled % 60 == 0) {
                    dictionary.suggest(token, suggestions);
                    ++asked;
                    suggested += suggestions.size();
                }
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

            // Prose is mostly inflected words, so the affix-stripping success path matters more than stems: a stem
            // plus a common suffix is valid for many words and a wrong guess still walks the same rules. A compound
            // with the next stem trains the compounding languages' path, and apostrophes, hyphens and digits go through
            // the break patterns.
            std::vector<std::u32string> variants{word, capitalized, upperCased, misspell(word, kind++), misspell(word, kind++)};
            for (size_t k = 0; k < 3; ++k) {
                variants.push_back(word + std::u32string(SUFFIXES[(kind + k) % SUFFIXES.size()]));
            }
            variants.push_back(word + U"'s");
            variants.push_back(word + U"-" + words[(n + 1) % words.size()]);
            variants.push_back(word + words[(n + 1) % words.size()]);
            variants.push_back(word + U"1");
            for (const auto &variant : variants) {
                ++checked;
                correct += dictionary.spell(encode(variant));
            }

            // Suggestions are far more expensive than checks; the editor asks for them only on demand.
            if (n % 400 == 0) {
                dictionary.suggest(encode(misspell(word, kind++)), suggestions);
                ++asked;
                suggested += suggestions.size();
            }
        }
    }

    std::printf("nuspell: %lu checked, %lu correct, %lu suggestions for %lu words\n", checked, correct, suggested, asked);
    return 0;
}
