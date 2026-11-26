// ruby.ts's builtin jumps against CLANG64's clang, which builds Ruby in CI. The stock builtins must still crash (if they stop,
// the RBP store can go); the patched ones must pass at every optimization level.
import { spawnSync } from "node:child_process";
import console from "node:console";
import { writeFileSync } from "node:fs";
import process from "node:process";

import { CLANG_BUILTIN_JUMPS } from "../ruby.ts";
import { fromHere, setup } from "./common.ts";

const WORK = setup("jumps");
writeFileSync(`${WORK}/patched.h`, CLANG_BUILTIN_JUMPS);
writeFileSync(
    `${WORK}/stock.h`,
    "#define ruby_setjmp(env) __builtin_setjmp((void **)(env))\n#define ruby_longjmp(env,val) __builtin_longjmp((void **)(env), (val))\n",
);

const compile = (header: string, flags: string) =>
    spawnSync(
        "C:/msys64/clang64/bin/clang.exe",
        `-w -std=gnu17 ${flags} -static -fuse-ld=lld -include ${header}.h ${fromHere("jumps.c")} -o t.exe`.split(" "),
        { cwd: WORK, encoding: "utf8" },
    );
const run = () => spawnSync(`${WORK}/t.exe`, { encoding: "utf8", timeout: 120_000 });

let passed = 0,
    total = 0;
function check(good: boolean, name: string, detail: string) {
    total++;
    passed += good ? 1 : 0;
    console.log(`${good ? "  ok" : "FAIL"} ${name}: ${detail.trim().slice(0, 300)}`);
}

const LEVELS = ["-O0", "-O1", "-O2", "-Os", "-O3 -march=x86-64-v3", "-O3 -march=x86-64-v3 -flto=full"];
for (const framePointer of ["-fno-omit-frame-pointer", "-fomit-frame-pointer"]) {
    for (const level of [...LEVELS, `${LEVELS.at(-1)} -fstack-protector-strong`]) {
        const flags = `${level} ${framePointer}`;
        for (const header of ["patched", "stock"]) {
            const built = compile(header, flags);
            if (built.status !== 0) {
                check(false, `${header} ${flags}`, built.stderr);
                continue;
            }
            const result = run(),
                good = header === "patched" ? result.status === 0 : result.status !== 0;
            check(good, `${header} ${flags}`, result.stdout || `exit ${result.status}`);
        }
    }
}
// Known clang limit: a 32-byte-aligned local next to alloca fails to compile with __builtin_setjmp.
const limit = compile("patched", "-O2 -march=x86-64-v3 -DOVERALIGNED");
check(
    limit.stderr.includes("offset is not a multiple of 16"),
    "over-aligned local + alloca (expected: clang error)",
    limit.stderr.split("\n")[0] ?? "",
);

console.log(`\njumps: ${passed}/${total} passed`);
process.exitCode = passed === total ? 0 : 1;
