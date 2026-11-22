import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";

import { FFMPEG_VARIANTS } from "./ffmpeg.ts";
import { buildDir, buildRoot, CLANG64, settings, TOOLCHAINS_DIR } from "./settings.ts";
import { bash } from "./shell.ts";
import type { BuildConfig, Conf, Library, Shared, Toolchain, ToolchainProfile, Tools } from "./types.ts";

const INJECT_TARGETS = `${TOOLCHAINS_DIR}/inject-targets.cmake`,
    LLVM_ROOT = "C:/LLVM",
    SEP = delimiter;

export const CLANG_WIN_TARGET = "x86_64-w64-windows-gnu";

const C_STD = "17",
    CXX_STD = "23",
    MSVC_TARGET = "x86_64-pc-windows-msvc";

export const TOOLCHAINS: readonly Toolchain[] = ["clang", "msvc"];

export function rustPlatform(toolchain: Toolchain): string {
    return toolchain === "msvc" ? "win-msvc" : "win-clang";
}

let current: Conf | null = null;

export const DEFAULT_PROFILE: ToolchainProfile = { asan: false, debugOpt: true, rtti: false };

export const CONSUMER_PROFILE: ToolchainProfile = {
    asan: false,
    consumer: true,
    debugOpt: false,
    linkLibsProfile: true,
    rtti: true,
};

export function profileOf(library: Library): ToolchainProfile {
    return { ...DEFAULT_PROFILE, ...library.profile };
}

export function configureToolchain(profile: ToolchainProfile = DEFAULT_PROFILE): Conf {
    current = genToolchains(profile);
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

    const pkgconfPaths = `${root}/lib/pkgconfig${SEP}${root}/share/pkgconfig`;

    let libcxx = "";
    if (flags.toolchain !== "msvc" && !flags.ownLibcxx) {
        libcxx =
            flags.ownClang || flags.ownRuntimes
                ? `-nostdinc++ -isystem ${buildRoot(false)}/include/c++/v1`
                : `-isystem ${CLANG64}/include/c++/v1`;
    }

    const cFlags = `-std=gnu17 ${opt}`,
        cxxFlags = `-std=gnu++${flags.cxxStd} ${libcxx} ${opt}`,
        includeFlags = (
            await bash`shopt -s nullglob; PKG_CONFIG_PATH="${pkgconfPaths}" pkg-config --cflags $(basename -s .pc ${`${root}/lib/pkgconfig/*.pc`}) 2>/dev/null`
                .noThrow()
                .text()
        )
            .trim()
            .replaceAll("-I", "-isystem ");

    return { cFlags, cxxFlags, includeFlags, ldFlags, root };
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

function prepend(entries: string[], existing: string | undefined): string {
    return [...entries, ...(existing ?? "").split(SEP)].filter(Boolean).join(SEP);
}

const BASE_ENV_LISTS = [
    "PATH",
    "INCLUDE",
    "LIB",
    "PKG_CONFIG_PATH",
    "C_INCLUDE_PATH",
    "CPATH",
    "LIBRARY_PATH",
] as const;

let baseEnv: Record<string, string | undefined> | undefined;

export async function updateEnv(isDebug: boolean) {
    const { cFlags, cxxFlags, includeFlags, ldFlags, root } = await computeFlags(isDebug),
        { ownClang, toolchain, tools } = toolchainState(),
        base = (baseEnv ??= Object.fromEntries(BASE_ENV_LISTS.map((name) => [name, process.env[name]]))),
        path = dualRoot("bin", isDebug);

    if (toolchain === "msvc") {
        const include = dualRoot("include", isDebug),
            lib = dualRoot("lib", isDebug);

        process.env.INCLUDE = replaceEntry(base.INCLUDE, include.active, include.inactive);
        process.env.LIB = replaceEntry(base.LIB, lib.active, lib.inactive);
    }

    const ownBin = ownClang ? `${buildRoot(false)}/bin${SEP}` : "";
    process.env.PATH = ownBin + replaceEntry(base.PATH, path.active, path.inactive);

    Object.assign(process.env, {
        ADDR2LINE: tools.addr2line,
        AR: tools.ar,
        AS: tools.asm,
        C_INCLUDE_PATH: prepend([`${root}/include`], base.C_INCLUDE_PATH),
        CC: tools.cc,
        CFLAGS: `${cFlags} ${includeFlags}`,
        CPATH: prepend([`${root}/include`], base.CPATH),
        CXX: tools.cxx,
        CXXFLAGS: `${cxxFlags} ${includeFlags}`,
        LD: tools.cc,
        LDFLAGS: `${ldFlags} -L${root}/lib ${includeFlags}`,
        LIBRARY_PATH: prepend([`${root}/lib`], base.LIBRARY_PATH),
        OBJCOPY: tools.objcopy,
        OBJDUMP: tools.objdump,
        PKG_CONFIG_PATH: prepend([`${root}/lib/pkgconfig`, `${root}/share/pkgconfig`], base.PKG_CONFIG_PATH),
        RANLIB: tools.ranlib,
        RC: tools.rc,
        STRIP: tools.strip,
        WINDRES: tools.rc,
    });
}

function createTargets(libs: Record<string, string>) {
    const content = Object.entries(libs)
        .map(
            ([name, lib]) => `if(NOT TARGET ${name})
    add_library(${name} STATIC IMPORTED GLOBAL)
    set_target_properties(${name} PROPERTIES
        IMPORTED_LOCATION "${buildRoot(false)}/lib/${lib}"
        INTERFACE_INCLUDE_DIRECTORIES "${buildRoot(false)}/include"
    )
endif()`,
        )
        .join("\n\n");

    writeFileSync(INJECT_TARGETS, content);
}

function genToolchains(profile: ToolchainProfile): Conf {
    const { toolchain } = settings,
        // The PGO library chain always uses CLANG64's clang: the profile is trained with it.
        ownClang = profile.ownClang !== false && settings.libsPgo === null && existsSync(`${buildRoot(false)}/bin/clang.exe`),
        ownRuntimes = profile.ownRuntimes === true && existsSync(`${buildRoot(false)}/lib/libc++.a`),
        shared = buildShared(toolchain, profile, ownClang, ownRuntimes),
        debug = buildDebug(shared, profile),
        release = buildRelease(shared, profile),
        tools = getTools(toolchain),
        fileTools = profile.consumer ? getTools(toolchain, LLVM_ROOT) : tools;

    mkdirSync(TOOLCHAINS_DIR, { recursive: true });

    if (toolchain === "msvc") {
        createTargets({
            "BZip2::BZip2": "bz2.lib",
            "liblzma::liblzma": "lzma.lib",
            "Deflate::Deflate": "deflatestatic.lib",
            "ZSTD::ZSTD": "zstd_static.lib",
        });
    } else {
        createTargets({
            "BZip2::BZip2": "libbz2.a",
            "liblzma::liblzma": "liblzma.a",
            "Deflate::Deflate": "libdeflate.a",
            "ZSTD::ZSTD": "libzstd.a",
        });
    }

    for (const isDebug of [true, false] as const) {
        const config = isDebug ? debug : release,
            name = buildDir(isDebug);
        writeFileSync(`${TOOLCHAINS_DIR}/native-${name}.ini`, toIni(isDebug, config, fileTools));
        writeFileSync(`${TOOLCHAINS_DIR}/${name}.cmake`, toCmakeToolchain(isDebug, config, fileTools));
        writeFileSync(`${TOOLCHAINS_DIR}/ffmpeg-root-${name}.cmake`, toFfmpegRoot(isDebug));
    }

    return {
        cxxStd: debug.cxxStd,
        debug: debug.cflags,
        ldDebug: debug.ldflags,
        ldRelease: release.ldflags,
        ownClang,
        ownLibcxx: profile.ownLibcxx === true,
        ownRuntimes,
        release: release.cflags,
        toolchain,
        tools,
    };
}

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
export const RELEASE_NON_LTO_LINKER_FLAGS = [
    "-Wl,-O3",
    "-Wl,--gc-sections",
    "-Wl,--as-needed",
    "-Wl,--strip-all",
    "-Wl,--build-id=none",
    "-Wl,--icf=all",
    "-Wl,--no-insert-timestamp",
];
export const DEBUG_TRAIN_CFLAGS = [
    "-O0",
    "-g2",
    "-gdwarf-5",
    "-glldb",
    "-gcolumn-info",
    "-fstandalone-debug",
    "-gz=zstd",
    "-fstack-protector-strong",
    "-ftrivial-auto-var-init=pattern",
    "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE",
    "-fsanitize=address",
    "-fsanitize-address-use-after-scope",
    "-fsanitize-address-use-after-return=runtime",
    "-fsanitize-annotate-debug-info=address",
];

function buildDebug(shared: Shared, profile: ToolchainProfile): BuildConfig {
    const cflags = [...shared.cflags],
        ldflags = [...shared.ldflags];

    if (profile.debugOpt) {
        cflags.push(...RELEASE_NON_LTO_CFLAGS);
        if (settings.toolchain === "msvc") {
            ldflags.push(...RELEASE_NON_LTO_MSVC_LINKER_FLAGS);
        } else {
            ldflags.push(...RELEASE_NON_LTO_LINKER_FLAGS);
        }
    } else {
        cflags.push("-O0", "-g2", "-gdwarf-5", "-glldb", "-gcolumn-info", "-fstandalone-debug");
        if (settings.toolchain === "msvc") {
            cflags.push("-gcodeview");
        } else {
            cflags.push("-gz=zstd");
        }
        cflags.push("-fstack-protector-strong", "-ftrivial-auto-var-init=pattern");
    }

    if (settings.toolchain === "msvc") {
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

    if (settings.genToolchains) {
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

    return {
        cflags: cflags.join(" "),
        cxxStd: profile.cxxStd ?? CXX_STD,
        ldflags: ldflags.join(" "),
    };
}

export function marchFlags(profile: ToolchainProfile): string[] {
    return [`-march=${profile.march ?? "x86-64-v3"}`, `-mtune=${profile.mtune ?? "generic"}`];
}

export function releaseOptFlags(lto: boolean, fatLto: boolean): string[] {
    const flags = [...RELEASE_NON_LTO_CFLAGS];
    if (lto) {
        flags.push("-flto=full");
        if (fatLto) {
            flags.push("-ffat-lto-objects");
        }
    }
    flags.push("-fvisibility=hidden", "-fvisibility-inlines-hidden", "-DNDEBUG");
    return flags;
}

function buildRelease(shared: Shared, profile: ToolchainProfile): BuildConfig {
    const lto = !settings.pgoTraining && profile.lto !== false,
        fatLto = profile.fatLto !== false,
        libsPgo = profile.pgo === false ? null : settings.libsPgo;

    const commonOptFlags = releaseOptFlags(lto, fatLto);

    const cflags = shared.cflags.map((flag) => (libsPgo === "use" && flag === "-w" ? "-Wno-everything" : flag));
    cflags.push(...commonOptFlags);
    if (libsPgo === "use") {
        cflags.push("-Wprofile-instr-out-of-date");
    }

    const linkerFlags: string[] = [];
    if (settings.toolchain === "msvc") {
        linkerFlags.push(...RELEASE_NON_LTO_MSVC_LINKER_FLAGS);
        if (lto) {
            linkerFlags.push("-Wl,-LTCG", "-Wl,-OPT:LLDLTO=3");
            if (fatLto) {
                linkerFlags.push("-Wl,-fat-lto-objects");
            }
        }
    } else {
        linkerFlags.push(...RELEASE_NON_LTO_LINKER_FLAGS);
        if (lto) {
            linkerFlags.push("-Wl,--lto-O3");
        }
    }

    if (!profile.rtti) {
        cflags.push("-fno-rtti");
    }

    const ldflags = [...shared.ldflags, ...commonOptFlags, ...linkerFlags];

    if (libsPgo === "gen") {
        cflags.push("-fprofile-generate", "-fprofile-update=atomic");
        ldflags.push("-fprofile-generate");
    } else if (libsPgo === "use") {
        cflags.push(`-fprofile-use=${settings.libsIrProfdata || settings.libsProfdata}`);
    }

    if (
        profile.linkLibsProfile &&
        settings.toolchain !== "msvc" &&
        !settings.pgoTraining &&
        existsSync(settings.libsProfdata)
    ) {
        ldflags.push(`-fprofile-use=${settings.libsProfdata}`);
    }

    if (settings.toolchain === "msvc") {
        cflags.push("-fms-runtime-lib=static");
        ldflags.push("-fms-runtime-lib=static");
    } else {
        cflags.push("-static", "-static-libgcc", "-static-libstdc++", "-static-openmp");
        ldflags.push("-static", "-static-libgcc", "-static-libstdc++", "-static-openmp");
    }

    return {
        cflags: cflags.join(" "),
        cxxStd: profile.cxxStd ?? CXX_STD,
        ldflags: ldflags.join(" "),
    };
}

function buildShared(toolchain: Toolchain, profile: ToolchainProfile, ownClang: boolean, ownRuntimes: boolean): Shared {
    const march = marchFlags(profile),
        userClang = profile.consumer === true && toolchain === "clang",
        builtins = ownClang || userClang ? [] : ["-lclang_rt.builtins-x86_64"],
        // Link-only: in cflags, meson's compile-only probes reject it under the PGO path's -Wno-everything.
        cflags = ["-pipe", ...march, "-w", "-fopenmp"],
        ldflags = [...march, "-fopenmp", ...builtins];

    cflags.push("-fuse-ld=lld");
    ldflags.push("-fuse-ld=lld");

    if (ownClang) {
        cflags.push(`--sysroot=${CLANG64}`, `-isystem ${CLANG64}/include`);
        ldflags.push(`--sysroot=${CLANG64}`, `-L${buildRoot(false)}/lib`);
    }

    if (userClang) {
        cflags.push(`--sysroot=${CLANG64}`);
        ldflags.push(`--sysroot=${CLANG64}`);
    }

    if (ownRuntimes) {
        ldflags.push(`-L${buildRoot(false)}/lib`);
        ldflags.push("-lc++abi", "-lunwind");
    }

    cflags.push("-rtlib=compiler-rt", "--unwindlib=libunwind");
    ldflags.push("-rtlib=compiler-rt", "--unwindlib=libunwind");

    const target = resolveWinTarget(toolchain);
    cflags.push(`--target=${target}`);
    ldflags.push(`--target=${target}`);

    if (toolchain === "msvc") {
        cflags.push("-DWIN32", "-D_MT", "-DNOMINMAX");
        ldflags.push("-Wl,-IGNORE:LONGSECTIONS");
    }

    cflags.push("-D_WIN32_WINNT=0x0A00", "-DWINVER=0x0A00");

    return { cflags, ldflags };
}

function cq(s: string): string {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function getTools(toolchain: Toolchain, root?: string): Tools {
    const bin = (tool: string) => (root ? `${root}/bin/${tool}.exe` : tool);
    const rcTool = toolchain === "msvc" ? "llvm-rc" : "llvm-windres";
    return {
        addr2line: bin("llvm-addr2line"),
        ar: bin("llvm-ar"),
        asm: bin("clang"),
        cc: bin("clang"),
        cxx: bin("clang++"),
        dlltool: bin("llvm-dlltool"),
        objcopy: bin("llvm-objcopy"),
        objdump: bin("llvm-objdump"),
        ranlib: bin("llvm-ranlib"),
        rc: bin(rcTool),
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

function toCmakeToolchain(isDebug: boolean, b: BuildConfig, tools: Tools): string {
    const { toolchain } = settings,
        type = buildDir(isDebug),
        cmakeType = isDebug ? "Debug" : "Release",
        root = buildRoot(isDebug),
        lines: string[] = ["include(CMakeFindDependencyMacro)"];

    lines.push(
        `set(CMAKE_C_COMPILER ${tools.cc})`,
        `set(CMAKE_CXX_COMPILER ${tools.cxx})`,
        `set(CMAKE_ASM_COMPILER ${tools.asm})`,
        `set(CMAKE_AR ${tools.ar})`,
        `set(CMAKE_C_COMPILER_AR ${tools.ar})`,
        `set(CMAKE_CXX_COMPILER_AR ${tools.ar})`,
        `set(CMAKE_RANLIB ${tools.ranlib})`,
        `set(CMAKE_C_COMPILER_RANLIB ${tools.ranlib})`,
        `set(CMAKE_CXX_COMPILER_RANLIB ${tools.ranlib})`,
        `set(CMAKE_STRIP ${tools.strip})`,
        `set(CMAKE_OBJCOPY ${tools.objcopy})`,
        `set(CMAKE_OBJDUMP ${tools.objdump})`,
        `set(CMAKE_ADDR2LINE ${tools.addr2line})`,
        `set(CMAKE_DLLTOOL ${tools.dlltool})`,
        `set(CMAKE_RC_COMPILER ${tools.rc})`,
    );
    lines.push(`set(CMAKE_GENERATOR Ninja CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_C_COMPILER_LAUNCHER sccache CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_CXX_COMPILER_LAUNCHER sccache CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_C_STANDARD "${C_STD}" CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_CXX_STANDARD "${b.cxxStd}" CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_C_EXTENSIONS ON CACHE BOOL "" FORCE)`);
    lines.push(`set(CMAKE_CXX_EXTENSIONS ON CACHE BOOL "" FORCE)`);
    lines.push(`set(CMAKE_BUILD_TYPE ${cmakeType} CACHE STRING "" FORCE)`);
    if (isDebug) {
        lines.push(`set(ENABLE_DEBUG_POSTFIX OFF CACHE BOOL "" FORCE)`);
        lines.push(`set(CMAKE_DEBUG_POSTFIX "" CACHE STRING "" FORCE)`);
    } else {
        lines.push(`set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)`);
        lines.push(`set(CMAKE_RELEASE_POSTFIX "" CACHE STRING "" FORCE)`);
    }
    if (toolchain === "msvc") {
        const runtime = isDebug ? "MultiThreadedDLL" : "MultiThreaded";
        lines.push(`set(CMAKE_MSVC_RUNTIME_LIBRARY "${runtime}" CACHE STRING "" FORCE)`);
    }

    const suffix = cmakeType.toUpperCase();
    lines.push(`set(CMAKE_C_FLAGS_${suffix} ${cq(b.cflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_CXX_FLAGS_${suffix} ${cq(b.cflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_EXE_LINKER_FLAGS_${suffix} ${cq(b.ldflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_SHARED_LINKER_FLAGS_${suffix} ${cq(b.ldflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_MODULE_LINKER_FLAGS_${suffix} ${cq(b.ldflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_PREFIX_PATH ${cq(root)} CACHE STRING "" FORCE)`);
    const prefix = cq(root).slice(1, -1),
        pcDirs = [`${prefix}/lib/pkgconfig`, `${prefix}/share/pkgconfig`];
    lines.push("if (DEFINED ENV{LLVM_DEPS_PREFIX})");
    lines.push('    set(CMAKE_PREFIX_PATH "$ENV{LLVM_DEPS_PREFIX}" CACHE STRING "" FORCE)');
    lines.push(
        '    set(ENV{PKG_CONFIG_PATH} "$ENV{LLVM_DEPS_PREFIX}/lib/pkgconfig;$ENV{LLVM_DEPS_PREFIX}/share/pkgconfig")',
    );
    lines.push("else()");
    lines.push(`    set(ENV{PKG_CONFIG_PATH} "${pcDirs.join(";")}")`);
    lines.push("endif()");

    if (toolchain === "msvc") {
        lines.push('if (NOT CMAKE_BINARY_DIR MATCHES "/CMakeFiles/CMakeScratch/")');
        lines.push(`    set(CMAKE_PDB_OUTPUT_DIRECTORY "${prefix}/bin" CACHE STRING "" FORCE)`);
        lines.push("endif()");
    }

    lines.push(`set(CMAKE_INSTALL_PREFIX ${cq(root)} CACHE PATH "" FORCE)`);
    lines.push(`set(ICU_ROOT ${cq(root)} CACHE STRING "" FORCE)`);
    lines.push(`set(RUST_PROFILE "${rustPlatform(toolchain)}-${type}" CACHE STRING "")`);
    if (toolchain === "msvc") {
        const icuLibDir = `${prefix}/lib`;
        lines.push(`set(ICU_UC_LIBRARY "${icuLibDir}/cicuuc.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_UC_LIBRARY_DEBUG "${icuLibDir}/cicuuc.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_UC_LIBRARY_RELEASE "${icuLibDir}/cicuuc.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_DATA_LIBRARY "${icuLibDir}/cicudt.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_DATA_LIBRARY_DEBUG "${icuLibDir}/cicudt.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_DATA_LIBRARY_RELEASE "${icuLibDir}/cicudt.lib" CACHE STRING "" FORCE)`);
    }

    const topLevelIncludes = [`\${CMAKE_CURRENT_LIST_DIR}/ffmpeg-root-${type}.cmake`];
    if (!isDebug) {
        topLevelIncludes.unshift("${CMAKE_CURRENT_LIST_DIR}/inject-targets.cmake");
    }
    lines.push(`set(CMAKE_PROJECT_TOP_LEVEL_INCLUDES "${topLevelIncludes.join(";")}" CACHE FILEPATH "" FORCE)`);

    return `${lines.join("\n")}\n`;
}

function toFfmpegRoot(isDebug: boolean): string {
    const projects = new Map<string, string[]>();
    for (const [variant, { consumers }] of Object.entries(FFMPEG_VARIANTS)) {
        if (!settings.ffmpegVariants.includes(variant)) {
            continue;
        }
        for (const [project, cacheVar] of consumers) {
            const sets = projects.get(project) ?? [];
            sets.push(
                `    set(${cacheVar} "${buildRoot(isDebug)}/ffmpeg-${variant}" CACHE PATH "FFmpeg install prefix")`,
            );
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

function toIni(isDebug: boolean, b: BuildConfig, tools: Tools): string {
    const { toolchain } = settings,
        type = buildDir(isDebug),
        root = buildRoot(isDebug),
        lines: string[] = [];

    lines.push("[binaries]");
    if (toolchain !== "msvc") {
        const winArgs = `-fuse-ld=lld --target=${resolveWinTarget(toolchain)}`;
        lines.push(
            `c = ${quoteArr(`sccache ${tools.cc} ${winArgs}`)}`,
            `cpp = ${quoteArr(`sccache ${tools.cxx} ${winArgs}`)}`,
        );
    } else {
        lines.push(`c = ['sccache', '${tools.cc}']`, `cpp = ['sccache', '${tools.cxx}']`);
    }
    lines.push(
        `ar = '${tools.ar}'`,
        `ranlib = '${tools.ranlib}'`,
        `strip = '${tools.strip}'`,
        `objcopy = '${tools.objcopy}'`,
        `windres = '${tools.rc}'`,
    );
    lines.push("[built-in options]");
    lines.push(`c_std = 'gnu${C_STD}'`);
    lines.push(`cpp_std = 'gnu++${b.cxxStd}'`);
    lines.push(`default_library = '${isDebug ? "shared" : "static"}'`);
    lines.push(`buildtype = '${type}'`);
    lines.push(`prefix = '${root}'`);
    if (toolchain === "msvc") {
        lines.push(`b_vscrt = '${isDebug ? "md" : "mt"}'`);
    }
    lines.push(`c_args = ${quoteArr(b.cflags)}`);
    lines.push(`c_link_args = ${quoteArr(b.ldflags)}`);
    lines.push(`cpp_args = c_args`);
    lines.push(`cpp_link_args = c_link_args`);
    lines.push("[properties]");
    lines.push(`cmake_prefix_path = ${quoteArr(root)}`);

    return lines.join("\n");
}
