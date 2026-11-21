// Run: node --test dev/build-libs/build-libs.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { replaceInFile } from "./builders.ts";
import { compareVersions } from "./check-updates.ts";
import { alreadyBuilt } from "./runner.ts";
import { toMsysPath } from "./shell.ts";
import type { BuildState, CliOptions } from "./types.ts";

const options = (extra: Partial<CliOptions> = {}) => ({ force: false, toolchain: "clang", ...extra }) as CliOptions;

test("compareVersions orders numerically, not as text", () => {
    assert.ok(compareVersions("10.0.9", "10.0.26100") < 0);
    assert.ok(compareVersions("2.15.4", "2.15") > 0);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("toMsysPath converts drive letters and backslashes", () => {
    assert.equal(toMsysPath(String.raw`C:\dev\x`), "/c/dev/x");
    assert.equal(toMsysPath("/already/posix"), "/already/posix");
});

test("alreadyBuilt compares pin, toolchain and --force", () => {
    const state: BuildState = { prefixes: { "C:/dev/release": { entries: { "zlib:release": { tag: "v1" } }, toolchain: "clang" } } };
    assert.equal(alreadyBuilt(state, "zlib:release", "C:/dev/release", "v1", options()), true);
    assert.equal(alreadyBuilt(state, "zlib:release", "C:/dev/release", "v2", options()), false);
    assert.equal(alreadyBuilt(state, "zlib:release", "C:/dev/release", "v1", options({ toolchain: "msvc" })), false);
    assert.equal(alreadyBuilt(state, "zlib:release", "C:/dev/release", "v1", options({ force: true })), false);
    assert.equal(alreadyBuilt(state, "zlib:release", "C:/other", "v1", options()), false);
});

test("replaceInFile replaces literally, keeps CRLF, and throws when nothing matched", async () => {
    const dir = await mkdtemp(`${tmpdir()}/build-libs-`),
        file = `${dir}/f.txt`;
    try {
        await writeFile(file, "a $& b\r\nc\r\n");
        await replaceInFile(file, "$&", "$1");
        assert.equal(await readFile(file, "utf8"), "a $1 b\r\nc\r\n");

        await replaceInFile(file, "b\nc", "x\ny");
        assert.equal(await readFile(file, "utf8"), "a $1 x\r\ny\r\n");

        await assert.rejects(replaceInFile(file, "missing", ""), /nothing matched/);
        await replaceInFile(file, "missing", "", { optional: true });
    } finally {
        await rm(dir, { force: true, recursive: true });
    }
});
