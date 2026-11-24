export type Toolchain = "clang" | "msvc";

export interface ToolchainProfile {
    asan: boolean;
    cxxStd?: string;
    rtti: boolean;
    debugOpt: boolean;
    march?: string;
    mtune?: string;
    pgo?: boolean;
    consumer?: boolean; // the profile of the toolchain files other projects use (CONSUMER_PROFILE), not of a library build
    linkLibsProfile?: boolean; // release links apply the library profile's context-sensitive part (consumer toolchain files)
    fatLto?: boolean;
    lto?: boolean;
    ownLibcxx?: boolean; // true: builds libc++ itself, so no libc++ include directory is added
    ownClang?: boolean; // false: built with MSYS2's clang even once our clang exists (llvm-project bootstraps from it)
    ownRuntimes?: boolean; // false: not built with llvm-runtimes' install (libc++, libunwind, libomp, compiler-rt) even once it exists
}

export interface Ctx {
    isDebug: boolean;
    msvc: boolean;
    path: string;
    root: string;
    step: (sub: string, build: () => Promise<void>) => Promise<void>;
}

export type LibrarySource = { archive: string; subdir: string; version: string } | { git: string; tag: string };

export interface Library {
    name: string;
    source: LibrarySource;
    build?: "cmake" | "meson" | "rust" | ((ctx: Ctx) => Promise<void>);
    sourceSubdir?: string;
    releaseOnly?: boolean;
    toolchains?: Toolchain[];
    profile?: Partial<ToolchainProfile>;
    msys2?: string;
    args?: (ctx: Ctx) => string;
    prepare?: (ctx: Omit<Ctx, "isDebug" | "root" | "step">) => Promise<void>;
    finish?: (ctx: Ctx) => Promise<void>;
    archPkg?: string;
    version?: string;
    variants?: () => string; // a library with per-variant steps: which variants this run builds, so a changed list rebuilds
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
    dlltool: string;
    objcopy: string;
    objdump: string;
    ranlib: string;
    rc: string;
    strip: string;
}

export interface Shared {
    cflags: string[];
    ldflags: string[];
}

export interface BuildConfig {
    cflags: string;
    cxxStd: string;
    ldflags: string;
}

export interface Conf {
    cxxStd: string;
    debug: string;
    ldDebug: string;
    ldRelease: string;
    ownClang: boolean;
    ownLibcxx: boolean;
    ownRuntimes: boolean;
    release: string;
    toolchain: Toolchain;
    tools: Tools;
}
