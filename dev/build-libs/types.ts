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
}

export interface ToolchainProfile {
    asan: boolean;
    cxxStd?: string;
    rtti: boolean;
    debugOpt: boolean;
    march?: string;
    mtune?: string;
    pgo?: boolean;
    linkLibsProfile?: boolean; // release links apply the library profile's context-sensitive part (consumer toolchain files)
    fatLto?: boolean;
    lto?: boolean;
    ownLibcxx?: boolean; // true: builds libc++ itself, so no libc++ include directory is added
    ownClang?: boolean; // false: built with MSYS2's clang even once our clang exists (llvm-project bootstraps from it)
    ownRuntimes?: boolean; // true: libc++, libc++abi, libunwind and libomp come from llvm-runtimes' install, once it exists
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
    env?: Record<string, string>;
    prepare?: (ctx: Omit<Ctx, "isDebug" | "root" | "step">) => Promise<void>;
    finish?: (ctx: Ctx) => Promise<void>;
    cmakeTarget?: string;
    msvcTools?: boolean;
    mesonCommand?: string[];
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

export type BuildType = "debug" | "release";

export interface Shared {
    cflags: string[];
    ldflags: string[];
}

export interface BuildConfig {
    buildType: BuildType;
    cflags: string;
    cmakeBuildType: "Debug" | "Release";
    cxxStd: string;
    defaultLibrary: "shared" | "static";
    ldflags: string;
    prefix: string;
    toolchain: Toolchain;
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
    defFile?: string;
}
