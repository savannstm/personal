// The build machine: toolchain environment, MSYS2 packages and required utilities.

import { $ } from "dax";

import {
    composePath,
    MSYS2_BASE_PACKAGES,
    MSYS2_MINGW_PACKAGES,
    toolDirs,
} from "../../personal/install-tools/toolchain.ts";
import { LIBRARIES, MSYS2_EXTRA } from "./libraries.ts";
import { latestVersionDir, msvcToolsRoot } from "./msvc.ts";
import { CLANG64, LLVM_ROOT, VSWHERE, WIN } from "./settings.ts";
import { bash } from "./shell.ts";
import type { Toolchain } from "./types.ts";

const HOST_ARCH = "Hostx64",
    TARGET_ARCH = "x64";

const REQUIRED_UTILITIES = ["clang", "cmake", "git", "meson", "ninja", "sd", "sccache"] as const;
const UNIX_UTILITIES = ["autoconf", "automake", "bison", "file", "flex", "unzip", "make", "pkg-config"] as const;

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
    if (!WIN) {
        return;
    }

    switch (toolchain) {
        case "clang": {
            process.env.PATH = `${LLVM_ROOT}/bin;${CLANG64}/bin;${purgeMsysFromPath(process.env.PATH ?? "")}`;
            process.env.MSYSTEM = "CLANG64";
            break;
        }
        case "msvc": {
            process.env.MSYSTEM = "";

            const sdkBase = "C:/Program Files (x86)/Windows Kits/10",
                [msvcRoot, sdkVersion, clangVersion] = await Promise.all([
                    msvcToolsRoot(),
                    latestVersionDir(`${sdkBase}/Include`),
                    latestVersionDir(`${LLVM_ROOT}/lib/clang`),
                ]),
                msvcBin = `${msvcRoot}/bin/${HOST_ARCH}/${TARGET_ARCH}`,
                sdkBin = `${sdkBase}/bin/${sdkVersion}/${TARGET_ARCH}`;

            process.env.PATH = composePath(
                [
                    `${LLVM_ROOT}/bin`,
                    `${LLVM_ROOT}/lib/clang/${clangVersion}/lib/windows`,
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
    const missing: string[] = [];

    missing.push(...(await checkUtilities(REQUIRED_UTILITIES)));

    if (WIN) {
        if (toolchain === "msvc") {
            try {
                await $`${VSWHERE} -latest -products '*' -property installationPath`.quiet();
            } catch {
                missing.push("vswhere (Visual Studio Installer)");
            }
        }
    } else {
        missing.push(...(await checkUtilities(UNIX_UTILITIES)));
    }

    if (missing.length > 0) {
        const list = missing.map((m) => `  • ${m}`).join("\n");
        throw new Error(
            `The following required utilities were not found on PATH:\n${list}\n\n` +
                (WIN
                    ? toolchain === "msvc"
                        ? "On Windows, the msvc toolchain needs the personal/install-tools archives (LLVM in C:\\PATH\\llvm, cmake, ninja, ...)."
                        : "On Windows, ensure MSYS2 is installed and the appropriate toolchain packages are installed via pacman."
                    : "Install the missing utilities using your system package manager."),
        );
    }
}

/** The CLANG64 packages that stand in for the libraries clang doesn't build (each library's `msys2`, see skipReason). */
function msys2LibraryPackages(): string[] {
    return [...LIBRARIES.flatMap((library) => (library.msys2 ? [library.msys2] : [])), ...MSYS2_EXTRA];
}

export async function installToolchainPackages(toolchain: Toolchain) {
    if (!WIN) {
        return;
    }

    if (toolchain === "msvc") {
        await bash`pacman -Syuq --needed --noconfirm ${MSYS2_BASE_PACKAGES.join(" ")} >/dev/null 2>&1`;
    } else {
        const packages = [
            ...MSYS2_BASE_PACKAGES,
            ...[...MSYS2_MINGW_PACKAGES, ...msys2LibraryPackages()].map((p) => `mingw-w64-clang-x86_64-${p}`),
        ].join(" ");
        await bash`pacman -Syuq --needed --noconfirm ${packages}`;
    }

    // The downloaded packages are ~2 GB the CI runner's disk needs for the builds. Not `pacman -Scc --noconfirm`: with
    // --noconfirm it answers "remove ALL files from cache?" with its default, no.
    if (process.env.CI) {
        await bash`rm -rf /var/cache/pacman/pkg/*`;
    }
}
