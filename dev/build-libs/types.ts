export type Toolchain = "clang" | "msvc";

export interface CliOptions {
    checkLibraryUpdates: boolean;
    exclude: Set<string>;
    force: boolean;
    only: null | Set<string>;
    onlyDebug: boolean;
    onlyRelease: boolean;
    genToolchains: boolean;
    printPgoKeys: boolean;
    toolchain: Toolchain;
    prefix: null | string;
    reposRoot: string;
}

export interface ToolchainProfile {
    asan: boolean;
    cxxStd?: string;
    rtti: boolean;
    // Dependency library: its debug variant is built optimized, without debug info. On clang, the full build takes
    // these from MSYS2's CLANG64 packages instead (see skipReason in runner.ts).
    debugOpt: boolean;
    march?: string;
    mtune?: string;
    pgo?: boolean; // false: built plain during the library PGO passes (default true)
    linkLibsProfile?: boolean; // release links apply the library profile's context-sensitive part (consumer toolchain files)
    fatLto?: boolean; // false: -flto=full objects without -ffat-lto-objects, for what is only ever linked into executables (default true)
    ownLibcxx?: boolean; // true: builds libc++ itself, so no libc++ include directory is added
    ownClang?: boolean; // false: built with MSYS2's clang even once our clang exists (llvm-project bootstraps from it)
    compilerRt?: boolean; // true: link with compiler-rt and libunwind, not libgcc (CLANG64 ships no libgcc)
}

/** What a library's hooks get: one variant (debug or release) of one checkout. */
export interface Ctx {
    isDebug: boolean;
    msvc: boolean;
    path: string;
    /** Install prefix of this variant. */
    root: string;
    /** Runs a named sub-build once, recording it in the build state so a resumed run skips it. */
    step: (sub: string, build: () => Promise<void>) => Promise<void>;
}

export type LibrarySource = { archive: string; subdir: string; version: string } | { git: string; tag: string };

export interface Library {
    name: string;
    source: LibrarySource;
    // A function is a custom build; the default is CMake.
    build?: "cmake" | "meson" | "rust" | ((ctx: Ctx) => Promise<void>);
    sourceSubdir?: string;
    // Only the release variant is built; the debug variant is skipped.
    releaseOnly?: boolean;
    // Only built with these toolchains.
    toolchains?: Toolchain[];
    // Merged over DEFAULT_PROFILE.
    profile?: Partial<ToolchainProfile>;
    // CLANG64 package installed in place of this library on clang (with debugOpt, see skipReason in runner.ts).
    msys2?: string;
    // Extra configure arguments for CMake, Meson or cargo.
    args?: (ctx: Ctx) => string;
    // Extra environment for the CMake configure and build.
    env?: Record<string, string>;
    // Once per checkout, after `git reset --hard` and before the variants (source patches, submodules).
    prepare?: (ctx: Omit<Ctx, "isDebug" | "root" | "step">) => Promise<void>;
    // Per variant, right after it was installed and before the next variant's `git clean -fdx` (import lib renames, PDBs).
    finish?: (ctx: Ctx) => Promise<void>;
    // What the build state records instead of the pin, when the output changes without the pin changing.
    statePin?: (pin: string) => string;
    // CMake: build this target instead of `cmake --build` + `cmake --install`.
    cmakeTarget?: string;
    // Meson: the command to run instead of `meson`.
    mesonCommand?: string[];
    // Arch Linux package name to check upstream versions against (see check-updates.ts). Defaults to `name`.
    archPkg?: string;
    // Override when the git tag isn't itself a clean version string (e.g. "pcre2-10.47").
    version?: string;
}

export interface BuildState {
    prefixes: Record<string, { entries: Record<string, { tag: string }>; toolchain: string }>;
}

export interface Tools {
    addr2line: string;
    ar: string;
    asm: string;
    cc: string;
    cxx: string;
    dlltool: null | string;
    objcopy: string;
    objdump: string;
    ranlib: string;
    rc: null | string;
    strip: string;
}

export type BuildType = "debug" | "release";

export interface Shared {
    cflags: string[];
    ldflags: string[];
}

export interface BuildConfig {
    buildType: BuildType;
    cflags: string;
    cmakeBuildType: "Debug" | "Release";
    defaultLibrary: "shared" | "static";
    ldflags: string;
    prefix: string;
    toolchain: Toolchain;
}

export interface Conf {
    debug: string;
    ldDebug: string;
    ldRelease: string;
    ownClang: boolean;
    release: string;
    toolchain: Toolchain;
    tools: Tools;
}

export interface Header {
    dest: string;
    src: string;
}

export interface PlainArgs {
    defines?: string[];
    headers: Header[];
    includeDirs: string[];
    libName: string;
    sources: string[];
    defFile?: string; // e.g. "libbz2.def" - consumed by the linker to control exports/import-lib
    exportAllSymbols?: boolean;
}
