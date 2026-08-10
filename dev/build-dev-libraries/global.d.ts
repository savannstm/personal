interface CliOptions {
    checkLibraryUpdates: boolean;
    exclude: Set<string>;
    force: boolean;
    only: null | Set<string>;
    onlyDebug: boolean;
    onlyRelease: boolean;
    genToolchains: boolean;
    toolchain: Toolchain;
    useCodeview: boolean;
    prefix: null | string;
}

interface ToolchainProfile {
    asan: boolean;
    rtti: boolean;
    debugOpt: boolean;
    fastmath: boolean;
}

interface BuildEntry {
    tag: string;
}

interface BuildState {
    prefixes: Record<string, { entries: Record<string, BuildEntry>; toolchain: string }>;
}

type Toolchain = "clang-ucrt" | "clang" | "msvc";

interface Tools {
    addr2line: string;
    ar: string;
    asm: string;
    cc: string;
    cxx: string;
    dlltool: null | string;
    nm: string;
    objcopy: string;
    objdump: string;
    ranlib: string;
    rc: null | string;
    readelf: string;
    strip: string;
}

type BuildType = "debug" | "release";

interface Shared {
    cflags: string[];
    ldflags: string[];
}

interface BuildConfig {
    buildType: BuildType;
    cflags: string;
    cmakeBuildType: "Debug" | "Release";
    defaultLibrary: "shared" | "static";
    ldflags: string;
    prefix: string;
    toolchain: Toolchain;
    useCodeview: boolean;
}

interface Conf {
    debug: string;
    ldDebug: string;
    ldRelease: string;
    release: string;
    toolchain: Toolchain;
    useCodeview: boolean;
    tools: Tools;
}

interface Header {
    dest: string;
    src: string;
}

interface PlainArgs {
    defines?: string[];
    headers: Header[];
    includeDirs: string[];
    libName: string;
    sources: string[];
    defFile?: string; // e.g. "libbz2.def" - consumed by the linker to control exports/import-lib
    exportAllSymbols?: boolean;
}
interface Library {
    archiveSubdir?: string;
    build?: "CMake" | "Custom" | "Meson";
    name?: string;
    sourceSubdir?: string;
    tag: string;
    url: string;
    // Arch Linux package name to check upstream versions against (see check-updates.ts).
    // Defaults to resolveLibraryName(library) when omitted; set explicitly when that guess
    // doesn't match the real package name (e.g. "freetype" -> "freetype2").
    archPkg?: string;
    // Override when `tag` isn't itself a clean version string (e.g. archiveSubdir entries
    // with no tag, or tags like "pcre2-10.47" where the name is baked into the tag).
    version?: string;
}
