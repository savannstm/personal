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
} from "./settings.ts";
import { bash } from "./shell.ts";
import type { BuildConfig, CliOptions, Conf, Library, Shared, Toolchain, ToolchainProfile, Tools } from "./types.ts";

const C_STD = "17",
    CLANG_WIN_TARGET = "x86_64-w64-windows-gnu",
    CXX_STD = "23",
    MSVC_TARGET = "x86_64-pc-windows-msvc";

export const TOOLCHAINS: readonly Toolchain[] = ["clang", "msvc"];

export function rustPlatform(toolchain: Toolchain): string {
    return toolchain === "msvc" ? "win-msvc" : "win-clang";
}

export function isToolchain(value: string): value is Toolchain {
    return (TOOLCHAINS as readonly string[]).includes(value);
}

let current: Conf | null = null;

export const DEFAULT_PROFILE: ToolchainProfile = { asan: false, debugOpt: true, rtti: false };

export const CONSUMER_PROFILE: ToolchainProfile = { asan: false, debugOpt: false, linkLibsProfile: true, rtti: true };

export function profileOf(library: Library): ToolchainProfile {
    return { ...DEFAULT_PROFILE, ...library.profile };
}

export async function configureToolchain(
    options: CliOptions,
    profile: ToolchainProfile = DEFAULT_PROFILE,
): Promise<Conf> {
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

    const ownBin = toolchainState().ownClang ? `${buildRoot(false)}/bin${SEP}` : "";
    process.env.PATH = ownBin + replaceEntry(process.env.PATH, path.active, path.inactive);

    Object.assign(process.env, {
        ADDR2LINE: tools.addr2line,
        AR: tools.ar,
        AS: tools.asm,
        C_INCLUDE_PATH: dedupPath(
            `${root}/include${SEP}${dropInactiveRoot(process.env.C_INCLUDE_PATH, inactiveRoot)}`,
            SEP,
        ),
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
        RC: tools.rc,
        STRIP: tools.strip,
        WINDRES: tools.rc,
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
        ownRuntimes = profile.ownRuntimes === true && existsSync(`${buildRoot(false)}/lib/libc++.a`),
        shared = buildShared(options.toolchain, profile, ownClang, ownRuntimes),
        debug = buildDebug(options, shared, profile),
        release = buildRelease(options, shared, profile),
        tools = getTools(options.toolchain),
        fileTools = profile === CONSUMER_PROFILE ? getTools(options.toolchain, LLVM_ROOT) : tools;

    await mkdir(TOOLCHAINS_DIR, { recursive: true });

    if (options.toolchain === "msvc") {
        await createTargets("bz2.lib", "lzma.lib", "deflatestatic.lib", "zstd_static.lib");
    } else {
        await createTargets("libbz2.a", "liblzma.a", "libdeflate.a", "libzstd.a");
    }

    await Promise.all([
        writeFile(DEBUG_NATIVE, toIni(debug, fileTools)),
        writeFile(RELEASE_NATIVE, toIni(release, fileTools)),
        writeFile(DEBUG_TOOLCHAIN, toCmakeToolchain(debug, fileTools)),
        writeFile(RELEASE_TOOLCHAIN, toCmakeToolchain(release, fileTools)),
    ]);
    await Promise.all([
        writeFile(DEBUG_FFMPEG_ROOT, toFfmpegRoot(debug)),
        writeFile(RELEASE_FFMPEG_ROOT, toFfmpegRoot(release)),
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

function buildDebug(options: CliOptions, shared: Shared, profile: ToolchainProfile): BuildConfig {
    const cflags = [...shared.cflags],
        ldflags = [...shared.ldflags];

    if (profile.debugOpt) {
        cflags.push(...RELEASE_NON_LTO_CFLAGS);
        if (options.toolchain === "msvc") {
            ldflags.push(...RELEASE_NON_LTO_MSVC_LINKER_FLAGS);
        } else {
            ldflags.push(...RELEASE_NON_LTO_LINKER_FLAGS);
        }
    } else {
        cflags.push("-O0", "-g2", "-gdwarf-5", "-glldb", "-gcolumn-info", "-fstandalone-debug");
        if (options.toolchain === "msvc") {
            cflags.push("-gcodeview");
        } else {
            cflags.push("-gz=zstd");
        }
        cflags.push("-fstack-protector-strong", "-ftrivial-auto-var-init=pattern");
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

function buildRelease(options: CliOptions, shared: Shared, profile: ToolchainProfile): BuildConfig {
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
    if (options.toolchain === "msvc") {
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
        cflags.push(`-fprofile-use=${settings.libsProfdata}`);
    }

    if (
        profile.linkLibsProfile &&
        options.toolchain !== "msvc" &&
        !settings.pgoTraining &&
        existsSync(settings.libsProfdata)
    ) {
        ldflags.push(`-fprofile-use=${settings.libsProfdata}`);
    }

    if (options.toolchain === "msvc") {
        cflags.push("-fms-runtime-lib=static");
        ldflags.push("-fms-runtime-lib=static");
    } else {
        cflags.push("-static", "-static-libgcc", "-static-libstdc++", "-static-openmp");
        ldflags.push("-static", "-static-libgcc", "-static-libstdc++", "-static-openmp");
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
    const march = marchFlags(profile),
        userClang = profile === CONSUMER_PROFILE && toolchain === "clang",
        builtins = ownClang || userClang ? [] : ["-lclang_rt.builtins-x86_64"],
        cflags = ["-pipe", ...march, "-w", "-fopenmp", ...builtins],
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

function toCmakeToolchain(b: BuildConfig, tools: Tools): string {
    const lines: string[] = ["include(CMakeFindDependencyMacro)"];

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
    const prefix = cq(b.prefix).slice(1, -1),
        pcDirs = [`${prefix}/lib/pkgconfig`, `${prefix}/share/pkgconfig`];
    lines.push("if (DEFINED ENV{LLVM_DEPS_PREFIX})");
    lines.push('    set(CMAKE_PREFIX_PATH "$ENV{LLVM_DEPS_PREFIX}" CACHE STRING "" FORCE)');
    lines.push(
        '    set(ENV{PKG_CONFIG_PATH} "$ENV{LLVM_DEPS_PREFIX}/lib/pkgconfig;$ENV{LLVM_DEPS_PREFIX}/share/pkgconfig")',
    );
    lines.push("else()");
    lines.push(`    set(ENV{PKG_CONFIG_PATH} "${pcDirs.join(";")}")`);
    lines.push("endif()");

    if (b.toolchain === "msvc") {
        lines.push('if (NOT CMAKE_BINARY_DIR MATCHES "/CMakeFiles/CMakeScratch/")');
        lines.push(`    set(CMAKE_PDB_OUTPUT_DIRECTORY "${prefix}/bin" CACHE STRING "" FORCE)`);
        lines.push("endif()");
    }

    lines.push(`set(CMAKE_INSTALL_PREFIX ${cq(b.prefix)} CACHE PATH "" FORCE)`);
    lines.push(`set(ICU_ROOT ${cq(b.prefix)} CACHE STRING "" FORCE)`);
    lines.push(`set(RUST_PROFILE "${rustPlatform(b.toolchain)}-${b.buildType}" CACHE STRING "")`);
    if (b.toolchain === "msvc") {
        const icuLibDir = `${prefix}/lib`;
        lines.push(`set(ICU_UC_LIBRARY "${icuLibDir}/cicuuc.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_UC_LIBRARY_DEBUG "${icuLibDir}/cicuuc.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_UC_LIBRARY_RELEASE "${icuLibDir}/cicuuc.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_DATA_LIBRARY "${icuLibDir}/cicudt.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_DATA_LIBRARY_DEBUG "${icuLibDir}/cicudt.lib" CACHE STRING "" FORCE)`);
        lines.push(`set(ICU_DATA_LIBRARY_RELEASE "${icuLibDir}/cicudt.lib" CACHE STRING "" FORCE)`);
    }

    const topLevelIncludes = [`\${CMAKE_CURRENT_LIST_DIR}/ffmpeg-root-${b.buildType}.cmake`];
    if (b.buildType === "release") {
        topLevelIncludes.unshift("${CMAKE_CURRENT_LIST_DIR}/inject-targets.cmake");
    }
    lines.push(`set(CMAKE_PROJECT_TOP_LEVEL_INCLUDES "${topLevelIncludes.join(";")}" CACHE FILEPATH "" FORCE)`);

    return `${lines.join("\n")}\n`;
}

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
    if (b.toolchain !== "msvc") {
        const winArgs = `-fuse-ld=lld --target=${resolveWinTarget(b.toolchain)}`;
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
