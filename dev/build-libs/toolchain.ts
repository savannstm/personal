import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { FFMPEG_VARIANTS } from "./libraries.ts";
import {
    buildRoot,
    CLANG64,
    DEBUG_FFMPEG_ROOT,
    DEBUG_NATIVE,
    DEBUG_TOOLCHAIN,
    INJECT_TARGETS,
    LLVM_ROOT,
    RELEASE_FFMPEG_ROOT,
    RELEASE_NATIVE,
    RELEASE_TOOLCHAIN,
    SEP,
    settings,
    TOOLCHAINS_DIR,
    WIN,
} from "./settings.ts";
import { bash } from "./shell.ts";
import type { BuildConfig, CliOptions, Conf, Library, Shared, Toolchain, ToolchainProfile, Tools } from "./types.ts";

const C_STD = "17",
    CLANG_WIN_TARGET = "x86_64-w64-windows-gnu",
    CXX_STD = "23",
    MSVC_TARGET = "x86_64-pc-windows-msvc";

const TOOL_VARS: [string, keyof Tools][] = [
    ["CMAKE_C_COMPILER", "cc"],
    ["CMAKE_CXX_COMPILER", "cxx"],
    ["CMAKE_ASM_COMPILER", "asm"],
    ["CMAKE_AR", "ar"],
    ["CMAKE_C_COMPILER_AR", "ar"],
    ["CMAKE_CXX_COMPILER_AR", "ar"],
    ["CMAKE_RANLIB", "ranlib"],
    ["CMAKE_C_COMPILER_RANLIB", "ranlib"],
    ["CMAKE_CXX_COMPILER_RANLIB", "ranlib"],
    ["CMAKE_STRIP", "strip"],
    ["CMAKE_OBJCOPY", "objcopy"],
    ["CMAKE_OBJDUMP", "objdump"],
    ["CMAKE_ADDR2LINE", "addr2line"],
];

const INI_BINARIES: [string, keyof Tools][] = [
    ["c", "cc"],
    ["cpp", "cxx"],
    ["ar", "ar"],
    ["ranlib", "ranlib"],
    ["strip", "strip"],
    ["objcopy", "objcopy"],
];

export const TOOLCHAINS: readonly Toolchain[] = ["clang", "msvc"];

export const WINDOWS_ONLY_TOOLCHAINS: ReadonlySet<Toolchain> = new Set(["msvc"]);

export function isToolchain(value: string): value is Toolchain {
    return (TOOLCHAINS as readonly string[]).includes(value);
}

let current: Conf | null = null;

export const DEFAULT_PROFILE: ToolchainProfile = { asan: false, debugOpt: true, rtti: false };

// The toolchain files left in ./toolchains after a run, for the projects that consume the libraries.
export const CONSUMER_PROFILE: ToolchainProfile = { asan: false, debugOpt: false, linkLibsProfile: true, rtti: true };

export function profileOf(library: Library): ToolchainProfile {
    return { ...DEFAULT_PROFILE, ...library.profile };
}

export async function configureToolchain(options: CliOptions, profile: ToolchainProfile = DEFAULT_PROFILE): Promise<Conf> {
    current = await genToolchains(options, profile);
    return current;
}

export function toolchainState(): Conf {
    if (!current) {
        throw new Error("Toolchain not configured yet: call configureToolchain() first.");
    }
    return current;
}

export async function computeFlags(isDebug: boolean) {
    const flags = toolchainState(),
        ldFlags = isDebug ? flags.ldDebug : flags.ldRelease,
        opt = isDebug ? flags.debug : flags.release,
        root = buildRoot(isDebug);

    // Only this prefix's .pc files: the inherited PKG_CONFIG_PATH would resolve libraries we don't build to MSYS2's copies, with CLANG64 include dirs.
    // Native Windows pkgconf splits on ';'; with ':' the "D:/..." paths are cut apart and it falls back to MSYS2's .pc files.
    const pkgconfPaths = `${root}/lib/pkgconfig${SEP}${root}/share/pkgconfig`;

    // ownLibcxx: libc++ is being built, and a second copy of its headers would make the wrappers (string.h) include_next into an empty one.
    // Pkg-config's include dirs are -isystem and would otherwise land ahead of the libc++ headers, so the libc++ dir goes first.
    const libcxx = flags.toolchain === "msvc" || flags.ownLibcxx ? "" : `-isystem ${flags.ownClang || flags.ownRuntimes ? buildRoot(false) : CLANG64}/include/c++/v1`,
        cFlags = `-std=gnu17 ${opt}`,
        cxxFlags = `-std=gnu++${flags.cxxStd} ${libcxx} ${opt}`,
        includeFlags = (
            await bash`shopt -s nullglob; PKG_CONFIG_PATH="${pkgconfPaths}" pkg-config --cflags $(basename -s .pc ${`${root}/lib/pkgconfig/*.pc`}) 2>/dev/null | sd -s -- "-I" "-isystem "`
                .noThrow()
                .text()
        ).trim();

    return { cFlags, cxxFlags, includeFlags, ldFlags, root };
}

function dedupPath(path: string, sep: string): string {
    const seen = new Set<string>();
    return (
        path
            .split(sep)
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            .filter((p) => p !== "" && !seen.has(p) && seen.add(p))
            .join(sep)
    );
}

function dualRoot(sub: string, isDebug: boolean) {
    const debug = `${buildRoot(true)}/${sub}`,
        release = `${buildRoot(false)}/${sub}`;
    return isDebug ? { active: debug, inactive: release } : { active: release, inactive: debug };
}

function replaceEntry(existing: string | undefined, active: string, inactive: string): string {
    const rest = (existing ?? "").split(SEP).filter((entry) => entry && entry !== active && entry !== inactive);
    return [...rest, active].join(SEP);
}

/** Drops entries under the other build's prefix, which earlier updateEnv calls left in the inherited env. */
function dropInactiveRoot(existing: string | undefined, inactiveRoot: string): string {
    return (existing ?? "")
        .split(SEP)
        .filter((entry) => !entry.startsWith(`${inactiveRoot}/`))
        .join(SEP);
}

export async function updateEnv(isDebug: boolean) {
    const { cFlags, cxxFlags, includeFlags, ldFlags, root } = await computeFlags(isDebug),
        { tools } = toolchainState(),
        inactiveRoot = buildRoot(!isDebug);

    const pkgConfPath = dedupPath(
        `${root}/lib/pkgconfig${SEP}${root}/share/pkgconfig${SEP}${dropInactiveRoot(process.env.PKG_CONFIG_PATH, inactiveRoot)}`,
        SEP,
    );

    const path = dualRoot("bin", isDebug);

    if (toolchainState().toolchain === "msvc") {
        const include = dualRoot("include", isDebug),
            lib = dualRoot("lib", isDebug);

        process.env.INCLUDE = replaceEntry(process.env.INCLUDE, include.active, include.inactive);
        process.env.LIB = replaceEntry(process.env.LIB, lib.active, lib.inactive);
    }

    // Libraries compile with our clang once it's installed; placed first so it wins over MSYS2's.
    const ownBin = toolchainState().ownClang ? `${buildRoot(false)}/bin${SEP}` : "";
    process.env.PATH = ownBin + replaceEntry(process.env.PATH, path.active, path.inactive);

    Object.assign(process.env, {
        ADDR2LINE: tools.addr2line,
        AR: tools.ar,
        AS: tools.asm,
        C_INCLUDE_PATH: dedupPath(`${root}/include${SEP}${dropInactiveRoot(process.env.C_INCLUDE_PATH, inactiveRoot)}`, SEP),
        CC: tools.cc,
        CFLAGS: `${cFlags} ${includeFlags}`,
        CPATH: dedupPath(`${root}/include${SEP}${dropInactiveRoot(process.env.CPATH, inactiveRoot)}`, SEP),
        CXX: tools.cxx,
        CXXFLAGS: `${cxxFlags} ${includeFlags}`,
        LD: tools.cc,
        LDFLAGS: `${ldFlags} -L${root}/lib ${includeFlags}`,
        LIBRARY_PATH: dedupPath(`${root}/lib${SEP}${dropInactiveRoot(process.env.LIBRARY_PATH, inactiveRoot)}`, SEP),
        OBJCOPY: tools.objcopy,
        OBJDUMP: tools.objdump,
        PKG_CONFIG_PATH: pkgConfPath,
        RANLIB: tools.ranlib,
        RC: tools.rc ?? "",
        STRIP: tools.strip,
        WINDRES: tools.rc ?? "",
    });
}

async function createTargets(...libs: string[]) {
    const targets = [
        { lib: libs[0], name: "BZip2::BZip2" },
        { lib: libs[1], name: "liblzma::liblzma" },
        { lib: libs[2], name: "Deflate::Deflate" },
        { lib: libs[3], name: "ZSTD::ZSTD" },
    ];
    const content = targets
        .map(
            (t) => `if(NOT TARGET ${t.name})
    add_library(${t.name} STATIC IMPORTED GLOBAL)
    set_target_properties(${t.name} PROPERTIES
        IMPORTED_LOCATION "${buildRoot(false)}/lib/${t.lib}"
        INTERFACE_INCLUDE_DIRECTORIES "${buildRoot(false)}/include"
    )
endif()`,
        )
        .join("\n\n");

    await writeFile(INJECT_TARGETS, content);
}

async function genToolchains(options: CliOptions, profile: ToolchainProfile): Promise<Conf> {
    const ownClang = profile.ownClang !== false && existsSync(`${buildRoot(false)}/bin/clang.exe`),
        // Absent until llvm-runtimes is installed (the llvm job downloads it), so the PGO job and local runs keep CLANG64's.
        ownRuntimes = profile.ownRuntimes === true && existsSync(`${buildRoot(false)}/lib/libc++.a`),
        shared = buildShared(options.toolchain, profile, ownClang, ownRuntimes),
        debug = buildDebug(options, shared, profile),
        release = buildRelease(options, shared, profile),
        tools = getTools(options.toolchain);

    await mkdir(TOOLCHAINS_DIR, { recursive: true });

    await (options.toolchain === "msvc"
        ? createTargets("bz2.lib", "lzma.lib", "deflatestatic.lib", "zstd_static.lib")
        : createTargets("libbz2.a", "liblzma.a", "libdeflate.a", "libzstd.a"));

    await Promise.all([
        writeFile(DEBUG_NATIVE, toIni(debug, tools)),
        writeFile(RELEASE_NATIVE, toIni(release, tools)),
        writeFile(DEBUG_TOOLCHAIN, toCmakeToolchain(debug, tools)),
        writeFile(RELEASE_TOOLCHAIN, toCmakeToolchain(release, tools)),
        ...(WIN
            ? [writeFile(DEBUG_FFMPEG_ROOT, toFfmpegRoot(debug)), writeFile(RELEASE_FFMPEG_ROOT, toFfmpegRoot(release))]
            : []),
    ]);

    return {
        cxxStd: debug.cxxStd,
        debug: debug.cflags,
        ldDebug: debug.ldflags,
        ldRelease: release.ldflags,
        ownClang,
        ownLibcxx: profile.ownLibcxx === true,
        ownRuntimes,
        release: release.cflags,
        toolchain: options.toolchain,
        tools,
    };
}

// Release flags without LTO, shared by release and debugOpt builds. Visibility flags stay release-only.
const RELEASE_NON_LTO_CFLAGS = [
    "-O3",
    "-fmerge-all-constants",
    "-ffunction-sections",
    "-fdata-sections",
    "-fno-math-errno",
    "-fno-trapping-math",
    "-Qn",
    "-Brepro",
];
const RELEASE_NON_LTO_MSVC_LINKER_FLAGS = [
    "-Wl,-DEBUG:NONE",
    "-Wl,-OPT:REF",
    "-Wl,-OPT:ICF=10",
    "-Wl,-OPT:LBR",
    "-Wl,-INCREMENTAL:NO",
    "-Wl,-SAFESEH:NO",
    "-Wl,-EMITTOOLVERSIONINFO:NO",
    "-Wl,-NOCOFFGRPINFO",
    "-Wl,-EMITPOGOPHASEINFO",
];
const RELEASE_NON_LTO_LINKER_FLAGS = [
    "-Wl,-O3",
    "-Wl,--gc-sections",
    "-Wl,--as-needed",
    "-Wl,--strip-all",
    "-Wl,--build-id=none",
    "-Wl,--icf=all",
    "-Wl,--no-insert-timestamp",
];
const RELEASE_ELF_LINKER_FLAGS = ["-Wl,-z,now", "-Wl,-z,norelro", "-Wl,-z,nosectionheader"];

function buildDebug(options: CliOptions, shared: Shared, profile: ToolchainProfile): BuildConfig {
    const cflags = [...shared.cflags, ...(profile.debugOpt ? RELEASE_NON_LTO_CFLAGS : ["-O0"])],
        ldflags = [...shared.ldflags];

    // Debug info and debug-only hardening are meaningless with -O3 and bloat/slow the library build; only -O0 builds keep them.
    if (!profile.debugOpt) {
        cflags.push("-g2", "-gdwarf-5", "-glldb", "-gcolumn-info", "-fstandalone-debug");
        cflags.push(options.toolchain === "msvc" ? "-gcodeview" : "-gz=zstd");
        cflags.push("-fstack-protector-strong", "-ftrivial-auto-var-init=pattern");
    }

    if (profile.debugOpt) {
        ldflags.push(...(options.toolchain === "msvc" ? RELEASE_NON_LTO_MSVC_LINKER_FLAGS : RELEASE_NON_LTO_LINKER_FLAGS));
    }

    if (options.toolchain === "msvc") {
        cflags.push("-fms-runtime-lib=dll", "-D_DLL", "-D_MSVC_STL_HARDENING=1", "-D_MSVC_STL_DESTRUCTOR_TOMBSTONES=1");
        //! -D_DLL has to be defined in ldflags in order for the linker to link the right runtime library.
        ldflags.push("-fms-runtime-lib=dll", "-D_DLL");
        if (!profile.debugOpt) {
            ldflags.push("-Wl,-DEBUG:FULL", "-Wl,-OPT:NOREF", "-Wl,-OPT:NOICF", "-Wl,-OPT:NOLBR");
        }
    } else {
        cflags.push(
            "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE",
            "-D_GLIBCXX_ASSERTIONS",
            "-D_GLIBCXX_DEBUG",
        );
    }

    if (profile.asan && !profile.debugOpt) {
        cflags.push(
            "-fsanitize=address",
            "-fsanitize-address-use-after-scope",
            "-fsanitize-address-use-after-return=runtime",
            "-fsanitize-annotate-debug-info=address",
        );
        ldflags.push("-fsanitize=address");
    }

    if (options.genToolchains) {
        cflags.push(
            "-Wall",
            "-Wpedantic",
            "-fsanitize=address,undefined",
            "-fsanitize-address-use-after-scope",
            "-fsanitize-address-use-after-return=runtime",
            "-fsanitize-annotate-debug-info=address",
        );
        ldflags.push("-fsanitize=address,undefined");
    }

    if (!WIN) {
        cflags.push("-D_FORTIFY_SOURCE=2");
        if (profile.debugOpt) {
            cflags.push("-fno-unwind-tables", "-fno-semantic-interposition", "-fno-plt");
            ldflags.push(...RELEASE_ELF_LINKER_FLAGS);
        } else {
            cflags.push("-fstack-clash-protection", "-fdebug-types-section");
        }
    }

    return {
        buildType: "debug",
        cflags: cflags.join(" "),
        cmakeBuildType: "Debug",
        cxxStd: profile.cxxStd ?? CXX_STD,
        defaultLibrary: "shared",
        ldflags: ldflags.join(" "),
        prefix: buildRoot(true),
        toolchain: options.toolchain,
    };
}

function buildRelease(options: CliOptions, shared: Shared, profile: ToolchainProfile): BuildConfig {
    // Profiling builds skip LTO, so the training runs measure what they were instrumented for.
    const lto = !settings.pgoTraining && profile.lto !== false;
    const commonOptFlags = [
        ...RELEASE_NON_LTO_CFLAGS,
        ...(lto ? ["-flto=full", ...(profile.fatLto === false ? [] : ["-ffat-lto-objects"])] : []),
        "-fvisibility=hidden",
        "-fvisibility-inlines-hidden",
    ];

    const cflags = [...shared.cflags, ...commonOptFlags],
        linkerFlags =
            options.toolchain === "msvc"
                ? [
                      ...RELEASE_NON_LTO_MSVC_LINKER_FLAGS,
                      // The MSVC driver doesn't forward -ffat-lto-objects to lld-link (the MinGW/ELF ones pass --fat-lto-objects),
                      // and without it lld-link links the objects' machine code instead of LTOing their bitcode.
                      ...(lto ? ["-Wl,-LTCG", "-Wl,-OPT:LLDLTO=3", ...(profile.fatLto === false ? [] : ["-Wl,-fat-lto-objects"])] : []),
                  ]
                : [...RELEASE_NON_LTO_LINKER_FLAGS, ...(lto ? ["-Wl,--lto-O3"] : [])];

    if (!profile.rtti) {
        cflags.push("-fno-rtti");
    }

    if (!WIN) {
        cflags.push("-fno-unwind-tables", "-fno-semantic-interposition", "-fno-plt");
        linkerFlags.push(...RELEASE_ELF_LINKER_FLAGS);
    }

    const ldflags = [...shared.ldflags, ...commonOptFlags, ...linkerFlags];

    const libsPgo = profile.pgo === false ? null : settings.libsPgo;
    if (libsPgo === "gen") {
        // Atomic counter updates: ImageMagick (OpenMP) and libjxl run the instrumented code from several threads.
        // The link flag pulls in the profile runtime, which configure-time link checks also need.
        cflags.push("-fprofile-generate", "-fprofile-update=atomic");
        ldflags.push("-fprofile-generate");
    } else if (libsPgo === "use") {
        cflags.push(`-fprofile-use=${settings.libsProfdata}`);
    }

    // The context-sensitive part of the library profile is applied in the LTO link, which for the static libraries
    // happens in the consumer. Functions without profile records (everything outside the trained libraries) are left alone.
    // The MSVC driver doesn't pass the profile on to lld-link.
    if (profile.linkLibsProfile && options.toolchain !== "msvc" && !settings.pgoTraining && existsSync(settings.libsProfdata)) {
        ldflags.push(`-fprofile-use=${settings.libsProfdata}`);
    }

    if (WIN) {
        if (options.toolchain === "msvc") {
            cflags.push("-fms-runtime-lib=static");
            ldflags.push("-fms-runtime-lib=static");
        } else {
            cflags.push("-static", "-static-libgcc", "-static-libstdc++", "-static-openmp");
            ldflags.push("-static", "-static-libgcc", "-static-libstdc++", "-static-openmp");
        }
    }

    return {
        buildType: "release",
        cflags: cflags.join(" "),
        cmakeBuildType: "Release",
        cxxStd: profile.cxxStd ?? CXX_STD,
        defaultLibrary: "static",
        ldflags: ldflags.join(" "),
        prefix: buildRoot(false),
        toolchain: options.toolchain,
    };
}

function buildShared(toolchain: Toolchain, profile: ToolchainProfile, ownClang: boolean, ownRuntimes: boolean): Shared {
    const march = profile.march ?? "x86-64-v3",
        mtune = profile.mtune ?? "generic",
        cflags = ["-pipe", `-march=${march}`, `-mtune=${mtune}`, "-w", "-fopenmp", "-lclang_rt.builtins-x86_64"],
        ldflags = [`-march=${march}`, `-mtune=${mtune}`, "-fopenmp", "-lclang_rt.builtins-x86_64"];

    cflags.push("-fuse-ld=lld");
    ldflags.push("-fuse-ld=lld");

    if (ownClang) {
        // Our clang ships its own libc++ and libunwind, but not the MinGW sysroot, which comes from CLANG64 (as in the training build).
        cflags.push(`--sysroot=${CLANG64}`, `-isystem ${CLANG64}/include`);
        ldflags.push(`--sysroot=${CLANG64}`, `-L${buildRoot(false)}/lib`);
    }

    if (ownRuntimes) {
        // Ahead of CLANG64's lib directories in the link search path, so -lc++, -lunwind and -lomp resolve here.
        ldflags.push(`-L${buildRoot(false)}/lib`);
    }

    if (profile.compilerRt) {
        cflags.push("-rtlib=compiler-rt", "--unwindlib=libunwind");
        ldflags.push("-rtlib=compiler-rt", "--unwindlib=libunwind");
    }

    if (WIN) {
        const target = resolveWinTarget(toolchain);
        cflags.push(`--target=${target}`);
        ldflags.push(`--target=${target}`);

        if (toolchain === "msvc") {
            cflags.push("-DWIN32", "-D_MT", "-DNOMINMAX");
            ldflags.push("-Wl,-IGNORE:LONGSECTIONS");
        }

        cflags.push("-D_WIN32_WINNT=0x0A00", "-DWINVER=0x0A00");
    } else {
        cflags.push("-fPIC");
        ldflags.push("-fPIC", "-Wl,--pie");
    }

    return { cflags, ldflags };
}

function cq(s: string): string {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function getTools(toolchain: Toolchain): Tools {
    const bin = (tool: string) => (WIN ? `${LLVM_ROOT}/bin/${tool}.exe` : tool);
    return {
        addr2line: bin("llvm-addr2line"),
        ar: bin("llvm-ar"),
        asm: bin("clang"),
        cc: bin("clang"),
        cxx: bin("clang++"),
        dlltool: WIN ? bin("llvm-dlltool") : null,
        objcopy: bin("llvm-objcopy"),
        objdump: bin("llvm-objdump"),
        ranlib: bin("llvm-ranlib"),
        rc: WIN ? bin(toolchain === "msvc" ? "llvm-rc" : "llvm-windres") : null,
        strip: bin("llvm-strip"),
    };
}

function quoteArr(spaceDelimited: string): string {
    const parts = spaceDelimited.split(/\s+/).filter(Boolean);
    return `[${parts.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(", ")}]`;
}

function resolveWinTarget(toolchain: Toolchain): string {
    return toolchain === "msvc" ? MSVC_TARGET : CLANG_WIN_TARGET;
}

function toCmakeToolchain(b: BuildConfig, tools: Tools): string {
    // CLANG64's package configs (e.g. SPNGConfig.cmake, found through PATH's prefix) call find_dependency without including its macro.
    const lines: string[] = ["include(CMakeFindDependencyMacro)"];

    for (const [varName, prop] of TOOL_VARS) {
        lines.push(`set(${varName} ${tools[prop]})`);
    }
    if (tools.dlltool) {
        lines.push(`set(CMAKE_DLLTOOL ${tools.dlltool})`);
    }
    if (tools.rc) {
        lines.push(`set(CMAKE_RC_COMPILER ${tools.rc})`);
    }
    lines.push(`set(CMAKE_GENERATOR Ninja CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_C_COMPILER_LAUNCHER sccache CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_CXX_COMPILER_LAUNCHER sccache CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_C_STANDARD "${C_STD}" CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_CXX_STANDARD "${b.cxxStd}" CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_C_EXTENSIONS ON CACHE BOOL "" FORCE)`);
    lines.push(`set(CMAKE_CXX_EXTENSIONS ON CACHE BOOL "" FORCE)`);
    lines.push(`set(CMAKE_BUILD_TYPE ${b.cmakeBuildType} CACHE STRING "" FORCE)`);
    if (b.buildType === "debug") {
        lines.push(`set(ENABLE_DEBUG_POSTFIX OFF CACHE BOOL "" FORCE)`);
        lines.push(`set(CMAKE_DEBUG_POSTFIX "" CACHE STRING "" FORCE)`);
    } else {
        lines.push(`set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)`);
        lines.push(`set(CMAKE_RELEASE_POSTFIX "" CACHE STRING "" FORCE)`);
    }
    if (b.toolchain === "msvc") {
        const runtime = b.buildType === "debug" ? "MultiThreadedDLL" : "MultiThreaded";
        lines.push(`set(CMAKE_MSVC_RUNTIME_LIBRARY "${runtime}" CACHE STRING "" FORCE)`);
    }

    const suffix = b.cmakeBuildType.toUpperCase();
    lines.push(`set(CMAKE_C_FLAGS_${suffix} ${cq(b.cflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_CXX_FLAGS_${suffix} ${cq(b.cflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_EXE_LINKER_FLAGS_${suffix} ${cq(b.ldflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_SHARED_LINKER_FLAGS_${suffix} ${cq(b.ldflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_MODULE_LINKER_FLAGS_${suffix} ${cq(b.ldflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_PREFIX_PATH ${cq(b.prefix)} CACHE STRING "" FORCE)`);
    // pkg-config must only see this prefix's .pc files, else it resolves libs from another build type
    const prefix = cq(b.prefix).slice(1, -1),
        pcDirs = [`${prefix}/lib/pkgconfig`, `${prefix}/share/pkgconfig`];
    // llvm-project sets the LLVM_DEPS_PREFIX env var (Library.env) to resolve its libxml2 deps from CLANG64. An env var, not a -D cache
    // entry: LLVM's try_compile checks run this file without the -D entries, and would otherwise reset PKG_CONFIG_PATH here.
    lines.push("if (DEFINED ENV{LLVM_DEPS_PREFIX})");
    lines.push('    set(CMAKE_PREFIX_PATH "$ENV{LLVM_DEPS_PREFIX}" CACHE STRING "" FORCE)');
    lines.push('    set(ENV{PKG_CONFIG_PATH} "$ENV{LLVM_DEPS_PREFIX}/lib/pkgconfig;$ENV{LLVM_DEPS_PREFIX}/share/pkgconfig")');
    lines.push("else()");
    lines.push(`    set(ENV{PKG_CONFIG_PATH} "${pcDirs.join(WIN ? ";" : ":")}")`);
    lines.push("endif()");

    if (b.toolchain === "msvc") {
        lines.push('if (NOT CMAKE_BINARY_DIR MATCHES "/CMakeFiles/CMakeScratch/")');
        lines.push(`    set(CMAKE_PDB_OUTPUT_DIRECTORY "${prefix}/bin" CACHE STRING "" FORCE)`);
        lines.push("endif()");
    }

    lines.push(`set(CMAKE_INSTALL_PREFIX ${cq(b.prefix)} CACHE PATH "" FORCE)`);
    lines.push(`set(ICU_ROOT ${cq(b.prefix)} CACHE STRING "" FORCE)`);
    lines.push(
        `set(RUST_PROFILE "${WIN ? (b.toolchain === "msvc" ? "win-msvc" : "win-clang") : "linux"}-${b.buildType}" CACHE STRING "")`,
    );
    // Only MSVC needs explicit ICU libs (its renamed c*.lib names are not found by FindICU). Clang finds ICU via ICU_ROOT;
    // pinning it to this prefix broke CI, where ICU is a CLANG64 package and the prefix has no ICU libs.
    if (b.toolchain === "msvc") {
        const icuLibDir = `${prefix}/lib`;
        lines.push(`set(ICU_UC_LIBRARY "${icuLibDir}/cicuuc.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_UC_LIBRARY_DEBUG "${icuLibDir}/cicuuc.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_UC_LIBRARY_RELEASE "${icuLibDir}/cicuuc.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_DATA_LIBRARY "${icuLibDir}/cicudt.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_DATA_LIBRARY_DEBUG "${icuLibDir}/cicudt.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_DATA_LIBRARY_RELEASE "${icuLibDir}/cicudt.lib" CACHE STRING "" FORCE)`);
    }

    // Runs after project() in each top-level project, so it can see PROJECT_NAME (the toolchain file cannot).
    if (WIN) {
        const topLevelIncludes = [`\${CMAKE_CURRENT_LIST_DIR}/ffmpeg-root-${b.buildType}.cmake`];
        if (b.buildType === "release") {
            topLevelIncludes.unshift("${CMAKE_CURRENT_LIST_DIR}/inject-targets.cmake");
        }
        lines.push(`set(CMAKE_PROJECT_TOP_LEVEL_INCLUDES "${topLevelIncludes.join(";")}" CACHE FILEPATH "" FORCE)`);
    }

    return `${lines.join("\n")}\n`;
}

// Points each consumer project's cache variables at the FFmpeg variants built for it (only the selected variants).
// Not FORCE: a -D<var>=... given on the command line (already cached) wins.
function toFfmpegRoot(b: BuildConfig): string {
    const projects = new Map<string, string[]>();
    for (const [variant, { consumers }] of Object.entries(FFMPEG_VARIANTS)) {
        if (!settings.ffmpegVariants.includes(variant)) {
            continue;
        }
        for (const [project, cacheVar] of consumers) {
            const sets = projects.get(project) ?? [];
            sets.push(`    set(${cacheVar} "${b.prefix}/ffmpeg-${variant}" CACHE PATH "FFmpeg install prefix")`);
            projects.set(project, sets);
        }
    }
    if (projects.size === 0) {
        return "";
    }
    const branches = [...projects].map(
        ([project, sets], i) => `${i === 0 ? "if" : "elseif"} (PROJECT_NAME STREQUAL "${project}")\n${sets.join("\n")}`,
    );
    return `${branches.join("\n")}\nendif()\n`;
}

function toIni(b: BuildConfig, tools: Tools): string {
    const lines: string[] = [];

    lines.push("[binaries]");
    const needCompilerArgs = WIN && b.toolchain !== "msvc";
    for (const [key, prop] of INI_BINARIES) {
        if (needCompilerArgs && (key === "c" || key === "cpp")) {
            lines.push(`${key} = ${quoteArr(`sccache ${tools[prop]} -fuse-ld=lld --target=${resolveWinTarget(b.toolchain)}`)}`);
        } else if (key === "c" || key === "cpp") {
            lines.push(`${key} = ['sccache', '${tools[prop]}']`);
        } else {
            lines.push(`${key} = '${tools[prop]}'`);
        }
    }
    if (tools.rc) {
        lines.push(`windres = '${tools.rc}'`);
    }
    lines.push("[built-in options]");
    lines.push(`c_std = 'gnu${C_STD}'`);
    lines.push(`cpp_std = 'gnu++${b.cxxStd}'`);
    lines.push(`default_library = '${b.defaultLibrary}'`);
    lines.push(`buildtype = '${b.buildType}'`);
    lines.push(`prefix = '${b.prefix}'`);
    if (b.toolchain === "msvc") {
        lines.push(`b_vscrt = '${b.buildType === "debug" ? "md" : "mt"}'`);
    }
    lines.push(`c_args = ${quoteArr(b.cflags)}`);
    lines.push(`c_link_args = ${quoteArr(b.ldflags)}`);
    lines.push(`cpp_args = c_args`);
    lines.push(`cpp_link_args = c_link_args`);
    lines.push("[properties]");
    lines.push(`cmake_prefix_path = ${quoteArr(b.prefix)}`);

    return lines.join("\n");
}
