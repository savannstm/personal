import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Where the CI artifacts are unpacked (see README.md).
export const LLVM = "C:/LLVM",
    PREFIX = "C:/dev-clang";

export const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url)).replaceAll("\\", "/");

// Applies dev/set-env.ts's clang environment to this process (so the tests check it too) and returns an empty work directory.
export function setup(suite: string): string {
    const commands = execFileSync(process.execPath, [fromHere("../../set-env.ts"), "--toolchain=clang"], {
        encoding: "utf8",
    });
    for (const [, name, value] of commands.matchAll(/\$env:(\w+)='((?:[^']|'')*)';/g)) {
        process.env[name!] = value!.replaceAll("''", "'");
    }
    // A failing Qt program otherwise opens a message box and hangs the run.
    process.env.QT_FORCE_STDERR_LOGGING = "1";

    const work = `${tmpdir().replaceAll("\\", "/")}/build-libs-tests/${suite}`;
    rmSync(work, { force: true, recursive: true });
    mkdirSync(work, { recursive: true });
    return work;
}

// The consumer toolchain files the libs and cmake suites build with.
export function generateToolchains(): void {
    execFileSync(process.execPath, [fromHere("../index.ts"), "--gen-toolchains"], { stdio: "ignore" });
}
