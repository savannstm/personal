// PGO trainer for quickjs: runs the kind of script a translation tool runs over a project's text - regex matching and
// replacement across many entries, string building and splitting, maps and sets, JSON round trips, closures and classes.

#include <quickjs.h>
#include <stdio.h>
#include <string.h>

static const char SCRIPT[] =
    "'use strict';\n"
    "const words = ['dragon', 'village', 'knight', 'potion', 'crystal', 'gold', 'innkeeper', 'quest', 'sword', 'shield',\n"
    "    'ドラゴン', '村', '騎士', 'ポーション', '水晶', '金貨', '宿屋', 'クエスト', 'дракон', 'деревня', 'рыцарь', 'зелье'];\n"
    "let seed = 12345;\n"
    "const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };\n"
    "const sentence = () => { const n = 4 + rand(12); const out = [];\n"
    "    for (let i = 0; i < n; ++i) out.push(words[rand(words.length)]);\n"
    "    if (rand(3) === 0) out.push(`\\\\C[${rand(32)}]` + words[rand(words.length)] + '\\\\C[0]');\n"
    "    if (rand(4) === 0) out.push(`\\\\V[${rand(500)}]`);\n"
    "    return out.join(rand(2) ? ' ' : '、') + (rand(2) ? '.' : '！'); };\n"
    "class Entry { constructor(id, source) { this.id = id; this.source = source; this.translation = ''; this.tags = new Set(); }\n"
    "    get length() { return this.source.length; } }\n"
    "const project = [];\n"
    "for (let i = 0; i < 20000; ++i) project.push(new Entry(i, Array.from({ length: 1 + rand(3) }, sentence).join('\\n')));\n"
    "const glossary = new Map([['dragon', 'wyrm'], ['ドラゴン', 'Dragon'], ['騎士', 'Knight'], ['дракон', 'Dragon'], ['gold', 'coins']]);\n"
    "const glossaryRe = new RegExp([...glossary.keys()].map((k) => k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|'), 'gu');\n"
    "let replaced = 0, matched = 0;\n"
    "for (let pass = 0; pass < 4; ++pass) {\n"
    "    for (const entry of project) {\n"
    "        const codes = entry.source.match(/\\\\[A-Z]\\[\\d+\\]/g);\n"
    "        if (codes) { matched += codes.length; for (const code of codes) entry.tags.add(code.slice(0, 2)); }\n"
    "        let text = entry.source.replace(glossaryRe, (m) => { ++replaced; return glossary.get(m); });\n"
    "        text = text.replace(/\\\\C\\[(\\d+)\\](.*?)\\\\C\\[0\\]/gu, (_, color, inner) => `<c${color}>${inner.toUpperCase()}</c>`);\n"
    "        text = text.split('\\n').map((line) => line.trim().replace(/\\s+/g, ' ')).filter((line) => line.length > 0).join('\\n');\n"
    "        if (/^[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]/u.test(text)) entry.tags.add('ja');\n"
    "        if (/[а-яё]/iu.test(text)) entry.tags.add('ru');\n"
    "        entry.translation = text.normalize('NFC');\n"
    "    }\n"
    "}\n"
    "const byTag = {};\n"
    "for (const entry of project) for (const tag of entry.tags) (byTag[tag] ?\?= []).push(entry.id);\n"
    "const json = JSON.stringify(project.map((e) => ({ id: e.id, source: e.source, translation: e.translation, tags: [...e.tags] })));\n"
    "const parsed = JSON.parse(json);\n"
    "const counts = new Map();\n"
    "for (const e of parsed) for (const w of e.translation.split(/[\\s、.！]+/u)) counts.set(w, (counts.get(w) ?? 0) + 1);\n"
    "const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20);\n"
    "let total = 0;\n"
    "for (const e of parsed) total += e.translation.length + e.tags.length;\n"
    "`${parsed.length} entries, ${matched} codes, ${replaced} replacements, ${top.length} top words, ${total} chars, ${Object.keys(byTag).length} tags`;\n";

// The app's interrupt handler: polled every few thousand operations, so a stuck script can be stopped.
static int interrupt(JSContext *ctx, void *opaque) {
    (void)ctx;
    return *(const int *)opaque;
}

static JSValue hostLog(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    const char *text = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

// The app evaluates a user script once and then calls its functions from C for every entry, building the string and
// object arguments and reading the result back at each call: that boundary is a large part of what it runs.
static const char CALLBACKS[] =
    "globalThis.translateEntry = (text, id, info) => {\n"
    "    let out = text.replace(/\\\\C\\[(\\d+)\\]/g, '<c$1>').replace(/\\s+/g, ' ').trim();\n"
    "    if (info.upper) out = out.toUpperCase();\n"
    "    return id % 7 === 0 ? { text: out, skip: out.length > 80, note: info.file + ':' + id } : out;\n"
    "};\n";

enum { ENTRIES = 40000 };

// The single-cell and endpoint scripts: every call builds a runtime of its own with the app's limits and host functions,
// evaluates the script, calls its callback once with a string, an array, a string, a number and an options object, reads
// the array it returns and tears everything down. Creating and destroying runtimes and contexts, and parsing, is what
// those calls spend their time on.
static const char CELL_SCRIPT[] =
    "globalThis.rpgmLineCallback = (source, translations, file, line, options) => {\n"
    "    const text = translations[options.column].replace(/\\s+/g, ' ').trim();\n"
    "    const words = text.split(' '); let out = '', row = '';\n"
    "    for (const word of words) { if ((row + word).length > options.limit) { out += row.trim() + '\\n'; row = ''; } row += word + ' '; }\n"
    "    translations[options.column] = out + row.trim();\n"
    "    return translations;\n"
    "};\n";

enum { CELL_RUNS = 1500 };

static int callCells(void) {
    int stop = 0, status = 0;
    size_t total = 0;
    for (int run = 0; run < CELL_RUNS && status == 0; ++run) {
        JSRuntime *rt = JS_NewRuntime();
        JS_SetMemoryLimit(rt, 256u << 20);
        JS_SetMaxStackSize(rt, 1u << 20);
        JS_SetInterruptHandler(rt, interrupt, &stop);
        JSContext *ctx = JS_NewContext(rt);
        const JSValue global = JS_GetGlobalObject(ctx);
        JS_SetPropertyStr(ctx, global, "log", JS_NewCFunction(ctx, hostLog, "log", 1));
        const JSValue eval = JS_Eval(ctx, CELL_SCRIPT, strlen(CELL_SCRIPT), "<built-in-script>", JS_EVAL_TYPE_GLOBAL);
        JS_FreeValue(ctx, eval);
        const JSValue function = JS_GetPropertyStr(ctx, global, "rpgmLineCallback");
        JSValue translations = JS_NewArray(ctx);
        JS_SetPropertyUint32(ctx, translations, 0, JS_NewString(ctx, ""));
        JS_SetPropertyUint32(ctx, translations, 1, JS_NewString(ctx, "The innkeeper's   daughter shouted: hurry, the dragon is attacking the village and the knights fled"));
        JSValue options = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, options, "column", JS_NewInt32(ctx, 1));
        JS_SetPropertyStr(ctx, options, "limit", JS_NewInt32(ctx, 40 + run % 20));
        JSValue args[5] = {JS_NewString(ctx, ""), translations, JS_NewString(ctx, ""), JS_NewInt32(ctx, 0), options};
        const JSValue result = JS_Call(ctx, function, JS_UNDEFINED, 5, args);
        if (JS_IsException(result)) {
            status = 1;
        } else {
            const JSValue element = JS_GetPropertyUint32(ctx, result, 1);
            const char *text = JS_ToCString(ctx, element);
            total += text ? strlen(text) : 0;
            JS_FreeCString(ctx, text);
            JS_FreeValue(ctx, element);
        }
        for (int i = 0; i < 5; ++i) {
            JS_FreeValue(ctx, args[i]);
        }
        JS_FreeValue(ctx, result);
        JS_FreeValue(ctx, function);
        JS_FreeValue(ctx, global);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
    }
    printf("quickjs: %d runtimes, %zu bytes back\n", CELL_RUNS, total);
    return status;
}

static int callEntries(JSContext *ctx) {
    static const char *const WORDS[] = {"dragon", "village", "knight", "potion", "ドラゴン", "騎士", "дракон", "\\C[2]gold\\C[0]", "\\V[12]"};
    unsigned seed = 7;
    size_t total = 0;
    int status = 0;

    const JSValue global = JS_GetGlobalObject(ctx);
    const JSValue function = JS_GetPropertyStr(ctx, global, "translateEntry");
    const JSValue info = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, info, "file", JS_NewString(ctx, "Map001.json"));
    JS_SetPropertyStr(ctx, info, "upper", JS_FALSE);

    for (int id = 0; id < ENTRIES && status == 0; ++id) {
        char text[512] = "";
        size_t length = 0;
        seed = seed * 1103515245u + 12345u;
        for (unsigned words = 3 + (seed >> 16) % 10; words > 0; --words) {
            seed = seed * 1103515245u + 12345u;
            const char *word = WORDS[(seed >> 16) % (sizeof WORDS / sizeof *WORDS)];
            length += (size_t)snprintf(text + length, sizeof text - length, "%s%s", length ? " " : "", word);
        }
        JSValue args[3] = {JS_NewString(ctx, text), JS_NewInt32(ctx, id), info};
        const JSValue result = JS_Call(ctx, function, JS_UNDEFINED, 3, args);
        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, args[1]);
        if (JS_IsException(result)) {
            const JSValue exception = JS_GetException(ctx);
            const char *message = JS_ToCString(ctx, exception);
            fprintf(stderr, "quickjs: translateEntry: %s\n", message ? message : "exception");
            JS_FreeCString(ctx, message);
            JS_FreeValue(ctx, exception);
            status = 1;
        } else {
            const JSValue value = JS_IsObject(result) ? JS_GetPropertyStr(ctx, result, "text") : JS_DupValue(ctx, result);
            const char *out = JS_ToCString(ctx, value);
            total += out ? strlen(out) : 0;
            JS_FreeCString(ctx, out);
            JS_FreeValue(ctx, value);
        }
        JS_FreeValue(ctx, result);
    }

    printf("quickjs: %d calls, %zu bytes back\n", ENTRIES, total);
    JS_FreeValue(ctx, info);
    JS_FreeValue(ctx, function);
    JS_FreeValue(ctx, global);
    return status;
}

int main(void) {
    static int stop;
    JSRuntime *rt = JS_NewRuntime();
    JS_SetMemoryLimit(rt, 1024u << 20);
    JS_SetMaxStackSize(rt, 1u << 20);
    JS_SetInterruptHandler(rt, interrupt, &stop);
    JSContext *ctx = JS_NewContext(rt);
    if (!rt || !ctx) {
        fprintf(stderr, "quickjs: can't create the context\n");
        return 1;
    }

    const JSValue result = JS_Eval(ctx, SCRIPT, strlen(SCRIPT), "<pgo>", JS_EVAL_TYPE_GLOBAL);
    int status = 0;
    if (JS_IsException(result)) {
        const JSValue exception = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, exception);
        fprintf(stderr, "quickjs: %s\n", message ? message : "exception");
        JS_FreeCString(ctx, message);
        JS_FreeValue(ctx, exception);
        status = 1;
    } else {
        const char *summary = JS_ToCString(ctx, result);
        printf("quickjs: %s\n", summary ? summary : "?");
        JS_FreeCString(ctx, summary);
    }

    JS_FreeValue(ctx, result);

    if (status == 0) {
        const JSValue callbacks = JS_Eval(ctx, CALLBACKS, strlen(CALLBACKS), "<pgo-callbacks>", JS_EVAL_TYPE_GLOBAL);
        status = JS_IsException(callbacks) ? 1 : callEntries(ctx);
        JS_FreeValue(ctx, callbacks);
    }
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return status == 0 ? callCells() : status;
}
