import consola from "consola";
import $ from "dax";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

type Toolchain = "clang-ucrt" | "clang" | "msvc";

function parseCliArgs(): Toolchain {
    const { values } = parseArgs({
        options: { toolchain: { short: "t", type: "string" } },
    });

    const t = values.toolchain;
    if (t !== "msvc" && t !== "clang" && t !== "clang-ucrt") {
        consola.error("Usage: set-env.ts --toolchain <msvc|clang|clang-ucrt>");
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

async function getRegistryValue(key: string, name: string): Promise<string | undefined> {
    const result = await $`reg query ${key} /v ${name}`.quiet().noThrow();
    if (result.code !== 0) {
        return undefined;
    }

    const match = new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`).exec(result.stdout);
    return match?.[1]?.trim();
}

function quote(v: string): string {
    return `"${v.replace(/"/g, '\\"')}"`;
}

async function buildMsvcCommand(): Promise<string> {
    const vswhere = `${process.env["ProgramFiles(x86)"]}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;

    if (!existsSync(vswhere)) {
        throw new Error(`vswhere.exe not found at '${vswhere}'.`);
    }

    const vsInstallPath = (
        await $`${vswhere} -latest -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`.text()
    ).trim();

    if (!vsInstallPath) {
        throw new Error("No Visual Studio installation with the VC++ toolset was found.");
    }

    const msvcRoot = join(vsInstallPath, "VC", "Tools", "MSVC");
    const msvcVersion = latestByVersion(
        readdirSync(msvcRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name),
    );

    if (!msvcVersion) {
        throw new Error(`No MSVC toolset versions found under '${msvcRoot}'.`);
    }

    const msvcPath = join(msvcRoot, msvcVersion);

    let sdkRoot = await getRegistryValue(
        "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows Kits\\Installed Roots",
        "KitsRoot10",
    );

    sdkRoot ??= await getRegistryValue("HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots", "KitsRoot10");

    if (!sdkRoot) {
        throw new Error("Could not locate Windows SDK.");
    }

    const sdkIncludeRoot = join(sdkRoot, "Include");

    const sdkVer = latestByVersion(
        readdirSync(sdkIncludeRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(d.name))
            .map((d) => d.name),
    );

    if (!sdkVer) {
        throw new Error("No Windows SDK version found.");
    }

    const includeDirs = [
        join(msvcPath, "include"),
        join(sdkRoot, "Include", sdkVer, "ucrt"),
        join(sdkRoot, "Include", sdkVer, "shared"),
        join(sdkRoot, "Include", sdkVer, "um"),
        join(sdkRoot, "Include", sdkVer, "winrt"),
        join(sdkRoot, "Include", sdkVer, "cppwinrt"),
    ];

    const libDirs = [
        join(msvcPath, "lib", "x64"),
        join(sdkRoot, "Lib", sdkVer, "ucrt", "x64"),
        join(sdkRoot, "Lib", sdkVer, "um", "x64"),
    ];

    const binDirs = [
        "C:\\Program Files\\LLVM\\bin",
        "C:\\Program Files\\LLVM\\lib\\clang\\22\\lib\\windows",
        join(msvcPath, "bin", "Hostx64", "x64"),
        join(sdkRoot, "bin", sdkVer, "x64"),
    ];

    const newPath = [...binDirs, process.env.PATH ?? ""].join(";");

    return [
        "rustup default nightly-msvc",
        `$env:INCLUDE=${quote(includeDirs.join(";"))}`,
        `$env:LIB=${quote(libDirs.join(";"))}`,
        `$env:PATH=${quote(newPath)}`,
    ].join("\n");
}

function buildClangCommand(): string {
    return [
        "rustup default nightly-gnullvm",
        `$env:PATH=${quote(`C:\\msys64\\clang64\\bin;${process.env.PATH ?? ""}`)}`,
    ].join("\n");
}

function buildClangUcrtCommand(): string {
    return [
        "rustup default nightly-gnullvm",
        `$env:PATH=${quote(`C:\\msys64\\ucrt64\\bin;${process.env.PATH ?? ""}`)}`,
    ].join("\n");
}

async function main() {
    const toolchain = parseCliArgs();

    let command: string;

    switch (toolchain) {
        case "clang":
            command = buildClangCommand();
            break;
        case "clang-ucrt":
            command = buildClangUcrtCommand();
            break;
        case "msvc":
            command = await buildMsvcCommand();
            break;
    }

    console.log(command);
}

await main().catch((err: unknown) => {
    consola.error(err);
    process.exit(1);
});
