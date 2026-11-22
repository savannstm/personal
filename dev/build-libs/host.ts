import { $ } from "dax";
import { existsSync } from "node:fs";

import {
    composePath,
    MSYS2_BASE_PACKAGES,
    MSYS2_MINGW_PACKAGES,
    toolDirs,
} from "../../personal/install-tools/toolchain.ts";
import { LIBRARIES, MSYS2_EXTRA, shouldBuildLibrary } from "./libraries.ts";
import { latestVersionDir, msvcToolsRoot } from "./msvc.ts";
import { LLVM_MINGW_I686 } from "./ruby.ts";
import { CLANG64, libsTrainingOnly, MSYS2_ROOT, VSWHERE } from "./settings.ts";
import { bash } from "./shell.ts";
import type { Toolchain } from "./types.ts";

const MSVC_LLVM_ROOT = "C:/PATH/llvm";

const HOST_ARCH = "Hostx64",
    TARGET_ARCH = "x64";

const REQUIRED_UTILITIES = ["clang", "cmake", "git", "meson", "ninja", "rg", "sccache", "sd"] as const;

// llvm-mingw is only needed by the ruby builds. cargo-c and cargo-binstall are installed by the rust builder when it needs them.
const needsRuby = () =>
    !libsTrainingOnly() &&
    LIBRARIES.some((library) => library.name.startsWith("ruby-") && shouldBuildLibrary(library.name));

async function checkUtilities(names: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const name of names) {
        if (!(await $.which(name))) {
            missing.push(name);
        }
    }
    return missing;
}

function purgeMsysFromPath(path: string): string {
    return path
        .split(";")
        .filter((p) => p && !p.toLowerCase().includes("msys64"))
        .join(";");
}

export async function setupToolchainEnv(toolchain: Toolchain) {
    switch (toolchain) {
        case "clang": {
            process.env.PATH = `${CLANG64}/bin;${purgeMsysFromPath(process.env.PATH ?? "")}`;
            process.env.MSYSTEM = "CLANG64";
            break;
        }
        case "msvc": {
            process.env.MSYSTEM = "";

            const sdkBase = "C:/Program Files (x86)/Windows Kits/10",
                [msvcRoot, sdkVersion, clangVersion] = await Promise.all([
                    msvcToolsRoot(),
                    latestVersionDir(`${sdkBase}/Include`),
                    latestVersionDir(`${MSVC_LLVM_ROOT}/lib/clang`),
                ]),
                msvcBin = `${msvcRoot}/bin/${HOST_ARCH}/${TARGET_ARCH}`,
                sdkBin = `${sdkBase}/bin/${sdkVersion}/${TARGET_ARCH}`;

            process.env.PATH = composePath(
                [
                    `${MSVC_LLVM_ROOT}/bin`,
                    `${MSVC_LLVM_ROOT}/lib/clang/${clangVersion}/lib/windows`,
                    msvcBin,
                    sdkBin,
                    ...toolDirs("msvc"),
                ],
                process.env.PATH ?? "",
            );

            process.env.INCLUDE = [
                `${msvcRoot}/include`,
                `${sdkBase}/Include/${sdkVersion}/ucrt`,
                `${sdkBase}/Include/${sdkVersion}/shared`,
                `${sdkBase}/Include/${sdkVersion}/um`,
                `${sdkBase}/Include/${sdkVersion}/winrt`,
            ].join(";");

            process.env.LIB = [
                `${msvcRoot}/lib/${TARGET_ARCH}`,
                `${sdkBase}/Lib/${sdkVersion}/ucrt/${TARGET_ARCH}`,
                `${sdkBase}/Lib/${sdkVersion}/um/${TARGET_ARCH}`,
            ].join(";");
            break;
        }
    }
}

export async function verifyPrerequisites(toolchain: Toolchain): Promise<void> {
    const missing = await checkUtilities(REQUIRED_UTILITIES);

    if (needsRuby() && !existsSync(`${LLVM_MINGW_I686}/bin/i686-w64-mingw32-clang.exe`)) {
        missing.push(`llvm-mingw (${LLVM_MINGW_I686})`);
    }

    if (toolchain === "msvc") {
        try {
            await $`${VSWHERE} -latest -products '*' -property installationPath`.quiet();
        } catch {
            missing.push("vswhere (Visual Studio Installer)");
        }
    }

    if (missing.length > 0) {
        const list = missing.map((m) => `  • ${m}`).join("\n");
        const hint =
            toolchain === "msvc"
                ? "On Windows, the msvc toolchain needs the personal/install-tools archives (LLVM in C:\\PATH\\llvm, cmake, ninja, ...)."
                : "On Windows, ensure MSYS2 is installed and the appropriate toolchain packages are installed via pacman.";
        throw new Error(`The following required utilities were not found on PATH:\n${list}\n\n${hint}`);
    }
}

function msys2LibraryPackages(): string[] {
    const packages: string[] = [];
    for (const library of LIBRARIES) {
        if (library.msys2) {
            packages.push(library.msys2);
        }
    }
    packages.push(...MSYS2_EXTRA);
    return packages;
}

export async function installToolchainPackages(toolchain: Toolchain) {
    if (toolchain === "msvc") {
        await bash`pacman -Syuq --needed --noconfirm ${MSYS2_BASE_PACKAGES.join(" ")} >/dev/null 2>&1`;
    } else {
        const mingwPackages = [...MSYS2_MINGW_PACKAGES, "ripgrep", ...msys2LibraryPackages()].map(
            (name) => `mingw-w64-clang-x86_64-${name}`,
        );
        await bash`pacman -Syuq --needed --noconfirm ${[...MSYS2_BASE_PACKAGES, ...mingwPackages].join(" ")}`;
    }

    // MSYS2's coreutils link.exe collides with the linker's name.
    await $`mv ${MSYS2_ROOT}/usr/bin/link.exe ${MSYS2_ROOT}/usr/bin/!link.exe`.noThrow();

    if (process.env.CI) {
        await bash`rm -rf /var/cache/pacman/pkg/*`;
    }
}
