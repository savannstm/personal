import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { CLANG64_BIN, composePath, LLVM_ROOT, toolDirs, type Toolchain } from "../personal/install-tools/toolchain.ts";

// Every C/C++ tool is off the user PATH and the machine environment: this script sets up the whole toolchain.
const CMAKE_ENV = { CMAKE_C_COMPILER: "clang", CMAKE_CXX_COMPILER: "clang++", CMAKE_GENERATOR: "Ninja" };

function parseCliArgs(): Toolchain {
    const { values } = parseArgs({
        options: { toolchain: { short: "t", type: "string" } },
    });

    const t = values.toolchain;
    if (t !== "msvc" && t !== "clang") {
        console.error("Usage: set-env.ts --toolchain <msvc|clang>");
        process.exit(1);
    }
    return t;
}

function latestByVersion(dirs: string[]): string | undefined {
    return dirs
        .filter((d) => /^\d+(\.\d+)*$/.test(d))
        .sort((a, b) => {
            const pa = a.split(".").map(Number);
            const pb = b.split(".").map(Number);

            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
                if (diff !== 0) {
                    return diff;
                }
            }

            return 0;
        })
        .at(-1);
}

function subdirs(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
}

function getRegistryValue(key: string, name: string): string | undefined {
    let output: string;
    try {
        output = execFileSync("reg", ["query", key, "/v", name], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        });
    } catch {
        return undefined; // key or value missing
    }

    return new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`).exec(output)?.[1]?.trim();
}

// Single quotes: PowerShell expands `$` and backticks inside double quotes.
const quote = (v: string) => `'${v.replaceAll("'", "''")}'`,
    setVar = (name: string, value: string) => `$env:${name}=${quote(value)};`,
    cmakeVars = () => Object.entries(CMAKE_ENV).map(([name, value]) => setVar(name, value));

function buildMsvcCommand(): string {
    const vswhere = `${process.env["ProgramFiles(x86)"]}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;

    if (!existsSync(vswhere)) {
        throw new Error(`vswhere.exe not found at '${vswhere}'.`);
    }

    // No - prerelease: install - tools maintains the stable Build Tools, and the newest preview may lack the components.
    const vsInstallPath = execFileSync(
        vswhere,
        [
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ],
        { encoding: "utf8", windowsHide: true },
    ).trim();

    if (!vsInstallPath) {
        throw new Error("No Visual Studio installation with the VC++ toolset was found.");
    }

    const msvcRoot = join(vsInstallPath, "VC", "Tools", "MSVC"),
        msvcVersion = latestByVersion(subdirs(msvcRoot));

    if (!msvcVersion) {
        throw new Error(`No MSVC toolset versions found under '${msvcRoot}'.`);
    }

    const msvcPath = join(msvcRoot, msvcVersion);

    const sdkRoot =
        getRegistryValue("HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows Kits\\Installed Roots", "KitsRoot10") ??
        getRegistryValue("HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots", "KitsRoot10");

    if (!sdkRoot) {
        throw new Error("Could not locate Windows SDK.");
    }

    const sdkVer = latestByVersion(subdirs(join(sdkRoot, "Include")).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)));

    if (!sdkVer) {
        throw new Error("No Windows SDK version found.");
    }

    // The ATL / MFC component is installed by install - tools too.
    const present = (dir: string) => existsSync(dir),
        includeDirs = [
            join(msvcPath, "include"),
            join(msvcPath, "atlmfc", "include"),
            join(sdkRoot, "Include", sdkVer, "ucrt"),
            join(sdkRoot, "Include", sdkVer, "shared"),
            join(sdkRoot, "Include", sdkVer, "um"),
            join(sdkRoot, "Include", sdkVer, "winrt"),
            join(sdkRoot, "Include", sdkVer, "cppwinrt"),
        ].filter(present),
        libDirs = [
            join(msvcPath, "lib", "x64"),
            join(msvcPath, "atlmfc", "lib", "x64"),
            join(sdkRoot, "Lib", sdkVer, "ucrt", "x64"),
            join(sdkRoot, "Lib", sdkVer, "um", "x64"),
        ].filter(present);

    // LLVM comes from install - tools: C: \PATH\llvm.Its real bin dir goes on PATH, because clang finds its resource dir
    // relative to the path it was launched from.
    const clangRoot = join(LLVM_ROOT, "lib", "clang");

    if (!existsSync(clangRoot)) {
        throw new Error(`LLVM not found under '${LLVM_ROOT}': run install-tools with --toolchain=msvc.`);
    }

    const clangVersion = latestByVersion(subdirs(clangRoot));

    if (!clangVersion) {
        throw new Error(`No clang resource directory found under '${LLVM_ROOT}'.`);
    }

    const binDirs = [
        join(LLVM_ROOT, "bin"),
        join(clangRoot, clangVersion, "lib", "windows"),
        join(msvcPath, "bin", "Hostx64", "x64"),
        join(sdkRoot, "bin", sdkVer, "x64"),
        ...toolDirs("msvc"),
    ];

    return [
        setVar("INCLUDE", includeDirs.join(";")),
        setVar("LIB", libDirs.join(";")),
        setVar("PATH", composePath(binDirs, process.env.PATH ?? "")),
        ...cmakeVars(),
        "rustup default nightly",
    ].join("\n");
}

function buildClangCommand(): string {
    return [
        setVar("PATH", composePath([CLANG64_BIN, ...toolDirs("clang")], process.env.PATH ?? "")),
        ...cmakeVars(),
        "rustup default nightly-gnullvm",
    ].join("\n");
}

try {
    const toolchain = parseCliArgs();
    console.log(toolchain === "clang" ? buildClangCommand() : buildMsvcCommand());
} catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
}
