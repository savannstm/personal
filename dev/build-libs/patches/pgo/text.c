// PGO trainer for harfbuzz and freetype: shapes text in the scripts a translation tool meets (Latin, Cyrillic, CJK,
// Arabic, Hebrew, Devanagari, Thai) with fonts that cover them, as Qt does, and rasterizes the shaped glyphs at several
// sizes and hinting modes, as ImageMagick's captions do. Fonts missing on this machine are skipped.
// argv[1]: the fonts directory.

#include <ft2build.h>
#include FT_FREETYPE_H
#include <hb-ft.h>
#include <hb.h>
#include <stdio.h>
#include <string.h>

static const char *const LATIN =
    "The innkeeper's daughter shouted: \"Hurry! The dragon's attacking the village, and the knights fled.\" "
    "Affluent officials offered 1,250 gold — final offer — for the flawless crystal of Æthelwynn (difficult & efficient).";
static const char *const CYRILLIC =
    "Хозяин таверны крикнул: «Скорее! Дракон напал на деревню, а рыцари сбежали». Чиновники предложили 1 250 золотых "
    "за безупречный кристалл — последнее предложение. Съешь же ещё этих мягких французских булок, да выпей чаю.";
static const char *const JAPANESE =
    "宿屋の娘が叫んだ。「急いで！ドラゴンが村を襲っている、騎士たちは逃げてしまった！」役人たちは完璧な水晶に"
    "金貨千二百五十枚を差し出した。これが最後の申し出だ。ポーションを使いますか？　はい／いいえ";
static const char *const CHINESE =
    "旅店老板的女儿喊道：“快！巨龙正在袭击村庄，骑士们都逃走了。”官员们出价一千二百五十金币购买那块完美的水晶，"
    "这是最后的报价。你要使用药水吗？";
static const char *const KOREAN =
    "여관 주인의 딸이 외쳤다. \"서둘러! 드래곤이 마을을 공격하고 있고 기사들은 도망쳤어!\" 관리들은 완벽한 수정에 "
    "금화 1,250개를 제시했다. 이것이 마지막 제안이다. 포션을 사용하시겠습니까?";
static const char *const ARABIC =
    "صاحت ابنة صاحب النزل: «أسرعوا! التنين يهاجم القرية، والفرسان هربوا». عرض المسؤولون ١٢٥٠ قطعة ذهبية "
    "مقابل البلورة الخالية من العيوب، وهذا هو العرض الأخير.";
static const char *const HEBREW =
    "בתו של בעל הפונדק צעקה: \"מהרו! הדרקון תוקף את הכפר, והאבירים ברחו.\" הפקידים הציעו 1,250 מטבעות זהב "
    "תמורת הגביש המושלם, וזו ההצעה האחרונה.";
static const char *const DEVANAGARI =
    "सराय मालिक की बेटी चिल्लाई: \"जल्दी करो! ड्रैगन गाँव पर हमला कर रहा है, और शूरवीर भाग गए।\" अधिकारियों ने "
    "निर्दोष क्रिस्टल के लिए १२५० सोने के सिक्के पेश किए, यह अंतिम प्रस्ताव है।";
static const char *const THAI =
    "ลูกสาวเจ้าของโรงเตี๊ยมตะโกนว่า \"เร็วเข้า! มังกรกำลังโจมตีหมู่บ้าน และอัศวินหนีไปแล้ว\" "
    "เจ้าหน้าที่เสนอเหรียญทอง 1,250 เหรียญสำหรับคริสตัลที่ไร้ตำหนิ นี่คือข้อเสนอสุดท้าย";

static const struct {
    const char *file;
    const char *texts[4];
} FONTS[] = {
    {"segoeui.ttf", {LATIN, CYRILLIC, ARABIC, HEBREW}},
    {"arial.ttf", {LATIN, CYRILLIC, ARABIC, HEBREW}},
    {"times.ttf", {LATIN, CYRILLIC}},
    {"consola.ttf", {LATIN, CYRILLIC}},
    {"tahoma.ttf", {LATIN, THAI}},
    {"YuGothM.ttc", {JAPANESE, LATIN}},
    {"msgothic.ttc", {JAPANESE}},
    {"meiryo.ttc", {JAPANESE}},
    {"msyh.ttc", {CHINESE, LATIN}},
    {"simsun.ttc", {CHINESE}},
    {"malgun.ttf", {KOREAN, LATIN}},
    {"Nirmala.ttc", {DEVANAGARI}},
    {"Nirmala.ttf", {DEVANAGARI}},
    {"LeelawUI.ttf", {THAI}},
};

static const unsigned SIZES[] = {11, 14, 18, 24, 36, 64};

static const struct {
    FT_Int32 load;
    FT_Render_Mode render;
} RENDER_MODES[] = {
    {FT_LOAD_DEFAULT, FT_RENDER_MODE_NORMAL},
    {FT_LOAD_TARGET_LIGHT, FT_RENDER_MODE_LIGHT},
    {FT_LOAD_TARGET_MONO, FT_RENDER_MODE_MONO},
    {FT_LOAD_NO_HINTING, FT_RENDER_MODE_NORMAL},
};

static void shape(hb_font_t *font, const char *text, hb_buffer_t *buffer) {
    hb_buffer_clear_contents(buffer);
    hb_buffer_add_utf8(buffer, text, -1, 0, -1);
    hb_buffer_guess_segment_properties(buffer);
    hb_shape(font, buffer, NULL, 0);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <fonts dir>\n", argv[0]);
        return 1;
    }

    FT_Library ft;
    if (FT_Init_FreeType(&ft)) {
        fprintf(stderr, "FT_Init_FreeType failed\n");
        return 1;
    }

    hb_buffer_t *buffer = hb_buffer_create();
    unsigned fonts = 0;
    unsigned long glyphs = 0;

    for (size_t f = 0; f < sizeof FONTS / sizeof *FONTS; ++f) {
        char path[1024];
        snprintf(path, sizeof path, "%s/%s", argv[1], FONTS[f].file);

        hb_blob_t *blob = hb_blob_create_from_file_or_fail(path);
        FT_Face ftFace;
        if (!blob || FT_New_Face(ft, path, 0, &ftFace)) {
            fprintf(stderr, "skip: %s\n", FONTS[f].file);
            hb_blob_destroy(blob);
            continue;
        }
        ++fonts;

        // Shaping with harfbuzz's own OpenType functions (as Qt does through its font tables), many times per size.
        hb_face_t *face = hb_face_create(blob, 0);
        hb_font_t *font = hb_font_create(face);
        for (size_t s = 0; s < sizeof SIZES / sizeof *SIZES; ++s) {
            hb_font_set_ptem(font, (float)SIZES[s]);
            hb_font_set_scale(font, (int)SIZES[s] * 64, (int)SIZES[s] * 64);
            for (int rep = 0; rep < 40; ++rep) {
                for (size_t t = 0; t < 4 && FONTS[f].texts[t]; ++t) {
                    shape(font, FONTS[f].texts[t], buffer);
                }
            }
        }

        // Rasterizing the shaped glyphs through freetype, then shaping once more through hb-ft (freetype-backed metrics).
        hb_font_t *ftFont = hb_ft_font_create_referenced(ftFace);
        for (size_t s = 0; s < sizeof SIZES / sizeof *SIZES; ++s) {
            FT_Set_Pixel_Sizes(ftFace, 0, SIZES[s]);
            hb_ft_font_changed(ftFont);
            for (size_t t = 0; t < 4 && FONTS[f].texts[t]; ++t) {
                shape(ftFont, FONTS[f].texts[t], buffer);
                unsigned count;
                const hb_glyph_info_t *info = hb_buffer_get_glyph_infos(buffer, &count);
                for (size_t m = 0; m < sizeof RENDER_MODES / sizeof *RENDER_MODES; ++m) {
                    for (unsigned g = 0; g < count; ++g) {
                        if (!FT_Load_Glyph(ftFace, info[g].codepoint, RENDER_MODES[m].load) &&
                            !FT_Render_Glyph(ftFace->glyph, RENDER_MODES[m].render)) {
                            ++glyphs;
                        }
                    }
                }
            }
        }

        hb_font_destroy(ftFont);
        hb_font_destroy(font);
        hb_face_destroy(face);
        hb_blob_destroy(blob);
        FT_Done_Face(ftFace);
    }

    hb_buffer_destroy(buffer);
    FT_Done_FreeType(ft);

    if (fonts == 0) {
        fprintf(stderr, "no fonts found in %s\n", argv[1]);
        return 1;
    }
    printf("text: %u fonts, %lu glyphs rendered\n", fonts, glyphs);
    return 0;
}
