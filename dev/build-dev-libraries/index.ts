import { Command } from "commander";
import consola from "consola";
import { $ } from "dax";
import { readdir } from "node:fs/promises";
import { exit } from "node:process";
import pc from "picocolors";

import { buildRepos } from "./build-runner.ts";
import { checkLibraryUpdates } from "./check-updates.ts";
import { LLVM_ROOT, setPrefix, WIN } from "./config.ts";
import { LIBRARIES } from "./libraries.ts";
import { bash } from "./shell.ts";
import { configureToolchain, isToolchain, TOOLCHAINS } from "./toolchain.ts";

const HOST_ARCH = "Hostx64",
    TARGET_ARCH = "x64";

export const WINDOWS_ONLY_TOOLCHAINS: ReadonlySet<Toolchain> = new Set(["clang-ucrt", "msvc"]);

const REQUIRED_UTILITIES = ["cmake", "git", "meson", "ninja", "sd"] as const;
const UNIX_UTILITIES = ["autoconf", "automake", "bison", "file", "flex", "unzip", "make", "pkg-config"] as const;

// python: ICU's configure generates data/rules.mk with it; without it rules.mk is empty and the data build fails.
const BASE_PACKAGES = ["bison", "flex", "file", "autoconf", "automake", "make", "pkgconf", "python"];
// Kept identical to MSYS2_MINGW_PACKAGES in install-dev-tools/windows.ts.
const MINGW_PACKAGES = [
    "toolchain",
    "clang",
    "lld",
    "llvm",
    "lldb",
    "llvm-openmp",
    "clang-tools-extra",
    "libunwind",
    "cmake",
    "ninja",
    "meson",
    "nasm",
];

async function checkUtilities(names: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const name of names) {
        if (!(await $.which(name))) {
            missing.push(name);
        }
    }
    return missing;
}

async function latestVersionDir(dir: string): Promise<string> {
    const compareVersions = (a: string, b: string): number => {
        const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0),
            pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] ?? 0) - (pb[i] ?? 0);
            if (d !== 0) {
                return d;
            }
        }
        return 0;
    };
    const versions = await readdir(dir);
    versions.sort(compareVersions);
    const latest = versions.at(-1);
    if (!latest) {
        throw new Error(`Nothing found under ${dir}`);
    }
    return latest;
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
            const msysDir = "clang64",
                msystem = "CLANG64";
            process.env.PATH = `C:/msys64/${msysDir}/bin;${purgeMsysFromPath(process.env.PATH ?? "")}`;
            process.env.MSYSTEM = msystem;
            break;
        }
        case "clang-ucrt": {
            const msysDir = "ucrt64",
                msystem = "UCRT64";
            process.env.PATH = `C:/msys64/${msysDir}/bin;${purgeMsysFromPath(process.env.PATH ?? "")}`;
            process.env.MSYSTEM = msystem;
            break;
        }
        case "msvc": {
            process.env.MSYSTEM = "";

            const vswhere = "C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe",
                vsRoot = (
                    await $`${vswhere} -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`.text()
                ).trim();
            if (!vsRoot) {
                throw new Error("vswhere: no VS installation with VC.Tools found");
            }

            const sdkBase = "C:/Program Files (x86)/Windows Kits/10",
                msvcToolsDir = `${vsRoot}/VC/Tools/MSVC`,
                [msvcVersion, sdkVersion, clangVersion] = await Promise.all([
                    latestVersionDir(msvcToolsDir),
                    latestVersionDir(`${sdkBase}/Include`),
                    latestVersionDir(`${LLVM_ROOT}/lib/clang`),
                ]),
                msvcRoot = `${msvcToolsDir}/${msvcVersion}`,
                msvcBin = `${msvcRoot}/bin/${HOST_ARCH}/${TARGET_ARCH}`,
                sdkBin = `${sdkBase}/bin/${sdkVersion}/${TARGET_ARCH}`;

            process.env.PATH = `${LLVM_ROOT}/bin;${LLVM_ROOT}/lib/clang/${clangVersion}/lib/windows;${msvcBin};${sdkBin};${process.env.PATH}`;

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
            const vswhere = "C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe";
            try {
                await $`${vswhere} -latest -products '*' -property installationPath`.quiet();
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
                    ? "On Windows, ensure MSYS2 is installed and the appropriate toolchain packages are installed via pacman."
                    : "Install the missing utilities using your system package manager."),
        );
    }
}

export async function installToolchainPackages(toolchain: Toolchain) {
    if (!WIN) {
        return;
    }

    if (toolchain === "msvc") {
        await bash`pacman -Syuq --needed --noconfirm ${BASE_PACKAGES.join(" ")} >/dev/null 2>&1`;
        return;
    }

    const prefix = toolchain === "clang-ucrt" ? "mingw-w64-ucrt-x86_64-" : "mingw-w64-clang-x86_64-",
        packages = [...BASE_PACKAGES, ...MINGW_PACKAGES.map((p) => `${prefix}${p}`)].join(" ");
    await bash`pacman -Syuq --needed --noconfirm ${packages} >/dev/null 2>&1`;
}

function splitList(value: string | undefined): string[] {
    return (value ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function validateToolchain(toolchain: string): void {
    if (!isToolchain(toolchain)) {
        throw new Error(`Invalid toolchain "${toolchain}". Valid toolchains are: ${TOOLCHAINS.join(", ")}.`);
    }
    if (!WIN && WINDOWS_ONLY_TOOLCHAINS.has(toolchain)) {
        throw new Error(
            `Toolchain "${toolchain}" is only available on Windows, but the current platform is ${process.platform}.`,
        );
    }
}

export function parseCliArgs(): CliOptions {
    const program = new Command();

    program
        .option("--only <names>", "Only build these libraries (comma-separated)")
        .option("--exclude, --skip <names>", "Exclude these libraries (comma-separated)")
        .option("--force", "Rebuild even if the repository is already built at the pinned tag", false)
        .option("--toolchain <clang|clang-ucrt|msvc>", "Select toolchain for building", "clang")
        .option("--prefix <path>", "Install prefix for builds (overrides the default)")
        .option("--only-debug", "Only build the debug (shared) variant of each library")
        .option("--only-release", "Only build the release (static) variant of each library")
        .option("--gen-toolchains", "Generate toolchain files in ./toolchains with default settings and exit")
        .option("--use-codeview", "Also generate CodeView PDB debug files on MSVC.")
        .option("--check-library-updates", "Compare pinned versions against Arch Linux packages and exit", false);

    program.parse();

    const opts = program.opts();
    const toolchain = opts.toolchain as string,
        onlyDebug = Boolean(opts.onlyDebug),
        onlyRelease = Boolean(opts.onlyRelease),
        useCodeview =
            typeof opts.useCodeview !== "undefined" ? Boolean(opts.useCodeview) : toolchain === "msvc" ? true : false,
        prefix = opts.prefix as null | string,
        options: CliOptions = {
            checkLibraryUpdates: Boolean(opts.checkLibraryUpdates),
            exclude: new Set(splitList(opts.skip)),
            force: Boolean(opts.force),
            genToolchains: Boolean(opts.genToolchains),
            only: opts.only ? new Set(splitList(opts.only)) : null,
            onlyDebug,
            onlyRelease,
            prefix: prefix,
            toolchain: toolchain as Toolchain,
            useCodeview,
        };

    validateToolchain(toolchain);

    if (onlyDebug && onlyRelease) {
        throw new Error("Options --only-debug and --only-release are mutually exclusive; use at most one.");
    }

    if (useCodeview && toolchain !== "msvc") {
        throw new Error("--use-codeview is not allowed with non-MSVC toolchains.");
    }

    if (prefix) {
        setPrefix(prefix);
    }

    return options;
}

$.setPrintCommand(true);
const options = parseCliArgs();

if (options.checkLibraryUpdates) {
    await checkLibraryUpdates(LIBRARIES);
    exit(0);
}

if (options.genToolchains) {
    consola.info(pc.cyan("Generating toolchain files..."));
    await configureToolchain(options, { asan: false, debugOpt: false, fastmath: false, rtti: true });
    consola.success(pc.green(`Toolchain files generated in ./toolchains for ${options.toolchain}.`));
    exit(0);
}

await setupToolchainEnv(options.toolchain);
await installToolchainPackages(options.toolchain);
await verifyPrerequisites(options.toolchain);
consola.info(pc.cyan(`Toolchain: ${options.toolchain}`));
await buildRepos(options);
