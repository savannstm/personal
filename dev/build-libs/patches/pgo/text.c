// PGO trainer for harfbuzz, shaping the way Qt does (QTextEngine::shapeTextWithHarfbuzzNG, qharfbuzzng.cpp), the only
// place the apps use it: UTF-16 buffers, filled from a string with the run as an offset into it (so harfbuzz sees the
// context around the run), explicit direction/script/language, one global `kern` feature, hb_shape_full with the
// graphite2/ot/fallback list, the buffer reversed for right-to-left runs, and a face made from table callbacks with
// Qt's font funcs (nominal glyph, advance, kerning, extents and contour point callbacks; Qt answers them from its font
// engine, here a harfbuzz OpenType font on the same face does). Qt itemizes a text into short runs, so every text is shaped
// as short runs of a few words, at the pixel sizes of the UI and the translation table. harfbuzz's unicode funcs are the
// default ones (Qt sets none). FreeType isn't used: on Windows Qt rasterizes with DirectWrite.
// Texts cover the scripts a translation tool meets (Latin with precomposed and decomposed diacritics, Cyrillic, Greek,
// Vietnamese, CJK, Hangul syllables and jamo, Arabic with and without harakat, Hebrew, Devanagari, Thai, emoji sequences)
// with pinned Noto fonts that cover them.
// argv[1]: the fonts directory.

#include <hb-ot.h>
#include <hb.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const char *text;
    const char *script; // ISO 15924, as harfbuzz knows the script of the run Qt itemized
    int rtl;
} Text;

static const Text LATIN = {"The innkeeper's daughter shouted: \"Hurry! The dragon's attacking the village, and the knights fled.\" "
                           "Affluent officials offered 1,250 gold — final offer — for the flawless crystal of Æthelwynn "
                           "(difficult & efficient). ¿Qué pasa? Naïve café, über-façade, łódź.",
                           "Latn", 0};
// The same accents as base letters followed by combining marks, as text from some sources and keyboards arrives.
static const Text LATIN_MARKS = {"Café naı̈ve, über-faca̧de, Zöe's piñata, "
                                 "ô à é î ü ç ñ š ž ř "
                                 "ḋ ą ǫ́ x̣́",
                                 "Latn", 0};
static const Text CYRILLIC = {"Хозяин таверны крикнул: «Скорее! Дракон напал на деревню, а рыцари сбежали». Чиновники предложили "
                              "1 250 золотых за безупречный кристалл — последнее предложение. Съешь же ещё этих мягких "
                              "французских булок, да выпей чаю.",
                              "Cyrl", 0};
static const Text GREEK = {"Ο ξενοδόχος φώναξε: «Βιαστείτε! Ο δράκος επιτίθεται στο χωριό και οι ιππότες έφυγαν». "
                           "Οι αξιωματούχοι πρότειναν 1.250 χρυσά νομίσματα για τον άψογο κρύσταλλο.",
                           "Grek", 0};
static const Text VIET_NFC = {"Con gái của chủ quán trọ hét lên: \"Nhanh lên! Con rồng đang tấn công ngôi làng, và các hiệp sĩ "
                              "đã bỏ chạy.\" Các quan chức đưa ra 1.250 đồng vàng cho viên pha lê hoàn hảo, Việt Nam, tiếng Việt.",
                              "Latn", 0};
static const Text VIET_NFD = {"Con gái của chủ quán trọ hét lên: \"Nhanh lên! Con rồng "
                              "đang tấn cống ngôi làng\", Việt Nam, tiếng "
                              "Việt.",
                              "Latn", 0};
static const Text JAPANESE = {"宿屋の娘が叫んだ。「急いで！ドラゴンが村を襲っている、騎士たちは逃げてしまった！」役人たちは完璧な水晶に"
                              "金貨千二百五十枚を差し出した。これが最後の申し出だ。ポーションを使いますか？　はい／いいえ",
                              "Hani", 0};
static const Text CHINESE = {"旅店老板的女儿喊道：“快！巨龙正在袭击村庄，骑士们都逃走了。”官员们出价一千二百五十金币购买那块完美的水晶，"
                             "这是最后的报价。你要使用药水吗？",
                             "Hani", 0};
static const Text KOREAN = {"여관 주인의 딸이 외쳤다. \"서둘러! 드래곤이 마을을 공격하고 있고 기사들은 도망쳤어!\" 관리들은 완벽한 수정에 "
                            "금화 1,250개를 제시했다. 이것이 마지막 제안이다. 포션을 사용하시겠습니까?",
                            "Hang", 0};
// Syllables spelled as conjoining jamo: harfbuzz's Hangul shaper composes them.
static const Text KOREAN_JAMO = {"한글 서울 간다 "
                                 "묵적 한글",
                                 "Hang", 0};
static const Text ARABIC = {"صاحت ابنة صاحب النزل: «أسرعوا! التنين يهاجم القرية، والفرسان هربوا». عرض المسؤولون ١٢٥٠ قطعة ذهبية "
                            "مقابل البلورة الخالية من العيوب، وهذا هو العرض الأخير.",
                            "Arab", 1};
static const Text ARABIC_HARAKAT = {"بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ، ٱلسَّلَامُ عَلَيْكُمْ وَرَحْمَةُ ٱللَّهِ وَبَرَكَاتُهُ، "
                                    "كَتَبَ ٱلْوَلَدُ ٱلدَّرْسَ فِي ٱلْمَدْرَسَةِ",
                                    "Arab", 1};
static const Text HEBREW = {"בתו של בעל הפונדק צעקה: \"מהרו! הדרקון תוקף את הכפר, והאבירים ברחו.\" הפקידים הציעו 1,250 מטבעות זהב "
                            "תמורת הגביש המושלם, וזו ההצעה האחרונה. שָׁלוֹם עֲלֵיכֶם",
                            "Hebr", 1};
static const Text DEVANAGARI = {"सराय मालिक की बेटी चिल्लाई: \"जल्दी करो! ड्रैगन गाँव पर हमला कर रहा है, और शूरवीर भाग गए।\" अधिकारियों ने "
                                "निर्दोष क्रिस्टल के लिए १२५० सोने के सिक्के पेश किए, यह अंतिम प्रस्ताव है।",
                                "Deva", 0};
static const Text THAI = {"ลูกสาวเจ้าของโรงเตี๊ยมตะโกนว่า \"เร็วเข้า! มังกรกำลังโจมตีหมู่บ้าน และอัศวินหนีไปแล้ว\" "
                          "เจ้าหน้าที่เสนอเหรียญทอง 1,250 เหรียญสำหรับคริสตัลที่ไร้ตำหนิ นี่คือข้อเสนอสุดท้าย",
                          "Thai", 0};
// ZWJ family and profession sequences, skin tones, regional indicator flags, keycaps and variation selectors.
static const Text EMOJI = {"😀 Hello 👍🏽 family 👨‍👩‍👧‍👦 flag 🇯🇵 🇷🇺 heart ❤️ keycap 1️⃣ "
                           "🧑🏻‍💻 gold 🪙 dragon 🐉 potion 🧪 ✨ ⚔️ 🛡️",
                           "Zyyy", 0};

static const struct {
    const char *file;
    const Text *texts[8];
} FONTS[] = {
    {"NotoSans.ttf", {&LATIN, &LATIN_MARKS, &CYRILLIC, &GREEK, &VIET_NFC, &VIET_NFD}},
    {"NotoSerif.ttf", {&LATIN, &CYRILLIC}},
    {"NotoSansMono.ttf", {&LATIN, &CYRILLIC}},
    {"NotoSansJP.ttf", {&JAPANESE, &LATIN}},
    {"NotoSansSC.ttf", {&CHINESE, &LATIN}},
    {"NotoSansKR.ttf", {&KOREAN, &KOREAN_JAMO, &LATIN}},
    {"NotoSansArabic.ttf", {&ARABIC, &ARABIC_HARAKAT}},
    {"NotoSansHebrew.ttf", {&HEBREW}},
    {"NotoSansDevanagari.ttf", {&DEVANAGARI}},
    {"NotoSansThai.ttf", {&THAI}},
    {"NotoEmoji.ttf", {&EMOJI}},
};

// Pixel sizes of Qt's UI and the translation table.
static const unsigned SIZES[] = {11, 12, 13, 14, 16, 18, 24, 36};

enum { REPS = 120, MAX_UNITS = 1024 };

// Table callbacks: Qt hands harfbuzz copies of the font's tables (QFontEngine::getSfntTable), as writable memory.
static hb_blob_t *referenceTable(hb_face_t *face, hb_tag_t tag, void *source) {
    (void)face;
    hb_blob_t *table = hb_face_reference_table((hb_face_t *)source, tag);
    unsigned length = 0;
    const char *data = hb_blob_get_data(table, &length);
    char *copy = length ? malloc(length) : NULL;
    if (copy) {
        memcpy(copy, data, length);
    }
    hb_blob_destroy(table);
    return copy ? hb_blob_create(copy, length, HB_MEMORY_MODE_WRITABLE, copy, free) : NULL;
}

// Qt's font funcs, answering from the reference font (data).
static hb_bool_t hExtents(hb_font_t *font, void *data, hb_font_extents_t *extents, void *user) {
    (void)font, (void)user;
    return hb_font_get_h_extents((hb_font_t *)data, extents);
}
static hb_bool_t nominalGlyph(hb_font_t *font, void *data, hb_codepoint_t unicode, hb_codepoint_t *glyph, void *user) {
    (void)font, (void)user;
    return hb_font_get_nominal_glyph((hb_font_t *)data, unicode, glyph);
}
static hb_bool_t variationGlyph(hb_font_t *font, void *data, hb_codepoint_t unicode, hb_codepoint_t selector,
                                hb_codepoint_t *glyph, void *user) {
    (void)font, (void)user;
    return hb_font_get_variation_glyph((hb_font_t *)data, unicode, selector, glyph);
}
static hb_position_t hAdvance(hb_font_t *font, void *data, hb_codepoint_t glyph, void *user) {
    (void)font, (void)user;
    return hb_font_get_glyph_h_advance((hb_font_t *)data, glyph);
}
static hb_position_t hKerning(hb_font_t *font, void *data, hb_codepoint_t left, hb_codepoint_t right, void *user) {
    (void)font, (void)user;
    return hb_font_get_glyph_h_kerning((hb_font_t *)data, left, right);
}
static hb_bool_t glyphExtents(hb_font_t *font, void *data, hb_codepoint_t glyph, hb_glyph_extents_t *extents, void *user) {
    (void)font, (void)user;
    return hb_font_get_glyph_extents((hb_font_t *)data, glyph, extents);
}
static hb_bool_t contourPoint(hb_font_t *font, void *data, hb_codepoint_t glyph, unsigned index, hb_position_t *x,
                              hb_position_t *y, void *user) {
    (void)font, (void)user;
    return hb_font_get_glyph_contour_point((hb_font_t *)data, glyph, index, x, y);
}

static hb_font_funcs_t *qtFuncs(void) {
    hb_font_funcs_t *funcs = hb_font_funcs_create();
    hb_font_funcs_set_font_h_extents_func(funcs, hExtents, NULL, NULL);
    hb_font_funcs_set_nominal_glyph_func(funcs, nominalGlyph, NULL, NULL);
    hb_font_funcs_set_variation_glyph_func(funcs, variationGlyph, NULL, NULL);
    hb_font_funcs_set_glyph_h_advance_func(funcs, hAdvance, NULL, NULL);
    hb_font_funcs_set_glyph_h_kerning_func(funcs, hKerning, NULL, NULL);
    hb_font_funcs_set_glyph_extents_func(funcs, glyphExtents, NULL, NULL);
    hb_font_funcs_set_glyph_contour_point_func(funcs, contourPoint, NULL, NULL);
    hb_font_funcs_make_immutable(funcs);
    return funcs;
}

/** UTF-8 to UTF-16 (QString's encoding); returns the length in code units. */
static unsigned toUtf16(const char *text, uint16_t *out) {
    unsigned length = 0;
    for (const unsigned char *at = (const unsigned char *)text; *at && length + 2 < MAX_UNITS;) {
        uint32_t cp;
        unsigned size = *at < 0x80 ? 1 : *at < 0xE0 ? 2 : *at < 0xF0 ? 3 : 4;
        cp = size == 1 ? *at : *at & (0x7Fu >> size);
        for (unsigned k = 1; k < size && at[k]; ++k) {
            cp = (cp << 6) | (at[k] & 0x3Fu);
        }
        at += size;
        if (cp >= 0x10000) {
            cp -= 0x10000;
            out[length++] = (uint16_t)(0xD800 + (cp >> 10));
            out[length++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
        } else {
            out[length++] = (uint16_t)cp;
        }
    }
    return length;
}

static unsigned long shapes;

/** One itemized run, as QTextEngine::shapeTextWithHarfbuzzNG shapes it. */
static void shapeRun(hb_font_t *font, hb_buffer_t *buffer, const uint16_t *text, unsigned length, unsigned pos, unsigned run,
                     const Text *info) {
    static const hb_feature_t KERN = {HB_TAG('k', 'e', 'r', 'n'), 1, HB_FEATURE_GLOBAL_START, HB_FEATURE_GLOBAL_END};
    static const char *const SHAPERS[] = {"graphite2", "ot", "fallback", NULL};
    hb_segment_properties_t props = HB_SEGMENT_PROPERTIES_DEFAULT;
    props.direction = info->rtl ? HB_DIRECTION_RTL : HB_DIRECTION_LTR;
    props.script = hb_script_from_string(info->script, -1);
    props.language = hb_language_from_string("en-US", -1);

    hb_buffer_clear_contents(buffer);
    hb_buffer_add_utf16(buffer, text, (int)length, pos, (int)run);
    hb_buffer_set_segment_properties(buffer, &props);
    hb_buffer_set_flags(buffer, HB_BUFFER_FLAG_DEFAULT);
    if (!hb_shape_full(font, buffer, &KERN, 1, SHAPERS)) {
        return;
    }
    if (info->rtl) {
        hb_buffer_reverse(buffer);
    }
    // Qt reads every glyph and its position afterwards.
    unsigned count;
    const hb_glyph_info_t *infos = hb_buffer_get_glyph_infos(buffer, &count);
    const hb_glyph_position_t *positions = hb_buffer_get_glyph_positions(buffer, NULL);
    for (unsigned i = 0; i < count; ++i) {
        shapes += infos[i].codepoint + (unsigned long)positions[i].x_advance;
    }
}

/** Shapes the text as runs of a few words (or of up to 18 units, where there are no spaces). */
static void shapeText(hb_font_t *font, hb_buffer_t *buffer, const Text *info) {
    uint16_t text[MAX_UNITS];
    const unsigned length = toUtf16(info->text, text);
    unsigned at = 0, words = 1;
    while (at < length) {
        unsigned end = at, seen = 0;
        while (end < length) {
            const uint16_t unit = text[end];
            if (unit == ' ') {
                if (++seen == words) {
                    break;
                }
            } else if (end - at >= 18 && (unit < 0xDC00 || unit > 0xDFFF) && (unit < 0x300 || unit > 0x36F) && unit != 0x200D) {
                break;
            }
            ++end;
        }
        if (end > at) {
            shapeRun(font, buffer, text, length, at, end - at, info);
        }
        at = end < length && text[end] == ' ' ? end + 1 : end;
        words = words % 6 + 1;
    }
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <fonts dir>\n", argv[0]);
        return 1;
    }

    hb_buffer_t *buffer = hb_buffer_create();
    hb_font_funcs_t *funcs = qtFuncs();
    unsigned fonts = 0;

    for (size_t f = 0; f < sizeof FONTS / sizeof *FONTS; ++f) {
        char path[1024];
        snprintf(path, sizeof path, "%s/%s", argv[1], FONTS[f].file);

        hb_blob_t *blob = hb_blob_create_from_file_or_fail(path);
        if (!blob) {
            fprintf(stderr, "text: missing font %s\n", FONTS[f].file);
            continue;
        }
        ++fonts;

        hb_face_t *source = hb_face_create(blob, 0);
        hb_face_t *face = hb_face_create_for_tables(referenceTable, source, NULL);
        hb_face_set_upem(face, hb_face_get_upem(source));

        // The reference font answers Qt's callbacks; the shaping font is the one Qt makes for the engine.
        hb_font_t *reference = hb_font_create(source);
        hb_ot_font_set_funcs(reference);
        for (size_t s = 0; s < sizeof SIZES / sizeof *SIZES; ++s) {
            const int scale = (int)SIZES[s] * 64;
            hb_font_set_scale(reference, scale, scale);

            hb_font_t *font = hb_font_create(face);
            hb_font_set_funcs(font, funcs, reference, NULL);
            hb_font_set_scale(font, scale, -scale);
            hb_font_set_ppem(font, SIZES[s], SIZES[s]);
            hb_font_set_ptem(font, (float)SIZES[s] * 0.75F);
            for (int rep = 0; rep < REPS; ++rep) {
                for (size_t t = 0; t < sizeof FONTS[f].texts / sizeof *FONTS[f].texts && FONTS[f].texts[t]; ++t) {
                    shapeText(font, buffer, FONTS[f].texts[t]);
                }
            }
            hb_font_destroy(font);
        }

        hb_font_destroy(reference);
        hb_face_destroy(face);
        hb_face_destroy(source);
        hb_blob_destroy(blob);
    }

    hb_font_funcs_destroy(funcs);
    hb_buffer_destroy(buffer);

    const unsigned expected = sizeof FONTS / sizeof *FONTS;
    printf("text: %u of %u fonts, checksum %lu\n", fonts, expected, shapes);
    return fonts == expected ? 0 : 1;
}
