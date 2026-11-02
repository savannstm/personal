// Where the C/C++ toolchain pieces live. Shared by install-tools (windows.ts) and dev/set-env.ts so both agree.
// None of these directories is on the user PATH: set-env.ts adds them per toolchain.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type Toolchain = "clang" | "msvc";

export const ROOT = "C:\\PATH",
    BIN = join(ROOT, "bin"),
    LLVM_ROOT = join(ROOT, "llvm"),
    // MSYS2, Steam and the MSVC/.NET pieces keep their default locations; the rest installs under ROOT.
    MSYS2 = "C:\\msys64",
    NODE_DIR = join(ROOT, "node"),
    // Windows PowerShell 5.1 ships with every Windows install: the only PowerShell these scripts run themselves.
    POWERSHELL = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    ),
    CLANG64_BIN = join(MSYS2, "clang64", "bin");

export const MSYS2_BASE_PACKAGES = ["bison", "flex", "file", "autoconf", "automake", "make", "pkgconf", "python"],
    // Everything the clang toolchain installs from CLANG64 instead of GitHub (see CPP_TOOLS).
    MSYS2_MINGW_PACKAGES = [
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
        "make",
        "pkgconf",
        "glslang",
        "upx",
    ];

export type Bin = ((root: string) => string) | string;

export function findDir(root: string, file: string): string {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase() === file) {
            return entry.parentPath;
        }
    }
    throw new Error(`${file} not found under ${root}`);
}

/** Directory with an archive's exes (`bin` defaults to "bin"), or undefined when `bin` can't be resolved (not installed). */
export function toolBin(name: string, bin: Bin = "bin"): string | undefined {
    const root = join(ROOT, name);
    try {
        return typeof bin === "function" ? bin(root) : join(root, bin);
    } catch {
        return undefined; // findDir throws when the exe isn't under root
    }
}

/** Like `toolBin`, but only when the directory exists. */
export function binDir(name: string, bin?: Bin): string | undefined {
    const dir = toolBin(name, bin);
    return dir && existsSync(dir) ? dir : undefined;
}

interface CppTool {
    bin?: Bin;
    /** CLANG64 packages it too: the clang toolchain installs it from there and skips the GitHub archive. */
    clang64: boolean;
}

// GitHub-installed C/C++ tools. The msvc toolchain uses all of them, clang only those CLANG64 lacks.
export const CPP_TOOLS = {
    cmake: { clang64: true },
    meson: { bin: (root) => findDir(root, "meson.exe"), clang64: true },
    glslang: { clang64: true },
    ninja: { bin: ".", clang64: true },
    nasm: { bin: ".", clang64: true },
    pkgconf: { bin: (root) => findDir(root, "pkgconf.exe"), clang64: true },
    upx: { bin: ".", clang64: true },
    winflexbison: { bin: ".", clang64: true },
    zig: { bin: ".", clang64: false },
} as const satisfies Record<string, CppTool>;

export type CppToolName = keyof typeof CPP_TOOLS;

/** Archive fields for one of `CPP_TOOLS`. */
export const cppTool = (name: CppToolName) => ({ name, noPath: true, ...CPP_TOOLS[name] });

/** Directories of the GitHub-installed C/C++ tools that `toolchain` uses. */
export function toolDirs(toolchain: Toolchain): string[] {
    return Object.entries(CPP_TOOLS as Record<string, CppTool>)
        .filter(([, tool]) => toolchain === "msvc" || !tool.clang64)
        .flatMap(([name, tool]) => toolBin(name, tool.bin) ?? []);
}

// MSVC and Windows SDK tool dirs, wherever Visual Studio put them.
const VS_DIR = /\\vc\\tools\\msvc\\|\\windows kits\\10\\bin\\/i;

/**
 * `dirs` followed by `currentPath` minus every directory a toolchain adds (so switching toolchains in one shell
 * leaves nothing of the previous one behind) and minus duplicates.
 */
export function composePath(dirs: string[], currentPath: string): string {
    const key = (dir: string) => dir.replace(/\\+$/, "").toLowerCase(),
        managed = new Set([CLANG64_BIN, ...toolDirs("msvc")].map(key)),
        llvmPrefix = `${key(LLVM_ROOT)}\\`,
        seen = new Set<string>();

    return [...dirs, ...currentPath.split(";")]
        .filter((dir, index) => {
            const id = key(dir);
            // `dirs` are exempt from the managed filter; everything after them is the inherited PATH.
            const inherited = index >= dirs.length;
            if (
                !id ||
                seen.has(id) ||
                (inherited && (managed.has(id) || id.startsWith(llvmPrefix) || VS_DIR.test(`${id}\\`)))
            ) {
                return false;
            }
            seen.add(id);
            return true;
        })
        .join(";");
}
