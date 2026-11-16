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

int main(void) {
    JSRuntime *rt = JS_NewRuntime();
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
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return status;
}
