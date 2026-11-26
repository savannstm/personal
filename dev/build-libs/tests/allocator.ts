// patches/llvm-rpmalloc-mingw.patch without building LLVM: builds rpmalloc as CI does (CLANG64's clang, static, with and
// without LTO) into a stress program that frees CRT-allocated strings. Unpatched it must crash, patched it must not.
// Usage: node allocator.ts [llvm-project source directory]
import { execFileSync, spawnSync } from "node:child_process";
import console from "node:console";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";

import { fromHere, setup } from "./common.ts";

const WORK = setup("allocator"),
    RPMALLOC = "llvm/lib/Support/rpmalloc",
    PATCH = fromHere("../patches/llvm-rpmalloc-mingw.patch"),
    CLANG = "C:/msys64/clang64/bin/clang",
    source = [process.argv[2], "C:/Repos-clang/llvm-project", "C:/Repos-dev/llvm-project"].find(
        (dir) => dir && existsSync(`${dir}/${RPMALLOC}/malloc.c`),
    );
if (!source) {
    throw new Error("No llvm-project sources found: pass their directory as the first argument.");
}

for (const tree of ["patched", "stock"]) {
    cpSync(`${source}/${RPMALLOC}`, `${WORK}/${tree}/${RPMALLOC}`, { recursive: true });
}
const applies = (tree: string, ...flags: string[]) =>
    spawnSync("git", ["apply", ...flags, PATCH], { cwd: `${WORK}/${tree}` }).status === 0;
// The sources may already carry the patch (a local build applied it): then the stock tree is the one to change.
if (applies("stock", "--check", "-R")) {
    applies("stock", "-R");
} else if (!applies("patched")) {
    throw new Error(`${PATCH} does not apply to ${source}.`);
}

const SOURCES: Record<string, string> = {
    "main.cpp": `#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <malloc.h>
#include <thread>
#include <vector>
extern "C" int native_calls(void);
extern "C" int plain_calls(void);
struct alignas(64) Big { char c[64]; };
int main() {
    for (int i = 0; i < 20000; ++i) {
        char *a = strdup("hello"), *b = _strdup("world");
        if (std::strcmp(a, "hello") || std::strcmp(b, "world")) return 1;
        free(a); free(b);
        char *(*volatile fp)(const char *) = strdup; free(fp("x"));
        Big *volatile p = new Big; delete p;
        _aligned_free(_aligned_malloc(100, 64));
        free(malloc(100));
    }
    std::vector<std::thread> t;
    for (int i = 0; i < 8; ++i) t.emplace_back([] { for (int k = 0; k < 20000; ++k) free(strdup("thread")); });
    for (auto &x : t) x.join();
    if (native_calls() || plain_calls()) return 3;
    std::puts("ok");
}
`,
    "native.c": `#include <stdlib.h>
#include <string.h>
int native_calls(void) { for (int i = 0; i < 20000; ++i) { free(strdup("n")); free(_strdup("m")); } return 0; }
`,
    // No headers: references without dllimport, like some third-party objects.
    "plain.c": `char *strdup(const char *); char *_strdup(const char *); void free(void *);
int plain_calls(void) { for (int i = 0; i < 20000; ++i) { free(strdup("n")); free(_strdup("m")); } return 0; }
`,
};
for (const [name, text] of Object.entries(SOURCES)) {
    writeFileSync(`${WORK}/${name}`, text);
}

const FLAGS =
        "-O3 -march=x86-64-v3 -fmerge-all-constants -ffunction-sections -fdata-sections -fno-math-errno -fno-trapping-math -fvisibility=hidden -DNDEBUG -w".split(
            " ",
        ),
    LINK = ["-fuse-ld=lld", "-static", "-Wl,--gc-sections,--icf=all,--as-needed,--strip-all"],
    RUNS = 20;

let passed = 0,
    total = 0;
for (const lto of [[], ["-flto=full"]]) {
    for (const tree of ["patched", "stock"]) {
        const dir = `${WORK}/${tree}-${lto.length}`,
            cc = (exe: string, args: string[]) => execFileSync(exe, args, { cwd: dir, stdio: "pipe" });
        mkdirSync(dir);
        const name = `${tree} ${lto.join("")}`;
        total++;
        try {
            const rpmalloc = `${WORK}/${tree}/${RPMALLOC}/rpmalloc.c`;
            cc(CLANG, [
                ...FLAGS,
                ...lto,
                "-std=gnu17",
                "-DENABLE_OVERRIDE",
                "-DENABLE_PRELOAD",
                "-c",
                rpmalloc,
                "-o",
                "rpmalloc.o",
            ]);
            cc("llvm-ar", ["rcs", "libsupport.a", "rpmalloc.o"]);
            cc(CLANG, [...FLAGS, "-c", "../native.c", "../plain.c"]);
            cc(`${CLANG}++`, [...FLAGS, ...lto, "-std=c++20", "-c", "../main.cpp", "-o", "main.o"]);
            const objects = ["main.o", "native.o", "plain.o", "libsupport.a"];
            cc(`${CLANG}++`, [...FLAGS, ...lto, ...LINK, ...objects, "-o", "t.exe"]);
            // As liblldb.dll links it.
            cc(`${CLANG}++`, [...FLAGS, ...lto, ...LINK, "-shared", "native.o", "libsupport.a", "-o", "n.dll"]);
        } catch (error) {
            console.log(`FAIL ${name}: build\n${String((error as { stderr?: Buffer }).stderr).slice(0, 1500)}`);
            continue;
        }
        let crashes = 0;
        for (let run = 0; run < RUNS; run++) {
            crashes += spawnSync(`${dir}/t.exe`, { timeout: 60_000 }).status === 0 ? 0 : 1;
        }
        const good = tree === "patched" ? crashes === 0 : crashes > 0;
        passed += good ? 1 : 0;
        console.log(`${good ? "  ok" : "FAIL"} ${name}: ${crashes}/${RUNS} runs crashed`);
    }
}
console.log(`\nallocator (${source}): ${passed}/${total} passed`);
process.exitCode = passed === total ? 0 : 1;
