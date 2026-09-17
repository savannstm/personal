import { writeFile } from "node:fs/promises";

import {
    buildRoot,
    DBG_ROOT,
    DEBUG_NATIVE,
    DEBUG_TOOLCHAIN,
    INJECT_TARGETS,
    REL_ROOT,
    RELEASE_NATIVE,
    RELEASE_TOOLCHAIN,
    SEP,
    WIN,
} from "./config.ts";
import { bash } from "./shell.ts";

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
    ["CMAKE_NM", "nm"],
    ["CMAKE_STRIP", "strip"],
    ["CMAKE_OBJCOPY", "objcopy"],
    ["CMAKE_OBJDUMP", "objdump"],
    ["CMAKE_READELF", "readelf"],
    ["CMAKE_ADDR2LINE", "addr2line"],
];

const INI_BINARIES: [string, keyof Tools][] = [
    ["c", "cc"],
    ["cpp", "cxx"],
    ["ar", "ar"],
    ["ranlib", "ranlib"],
    ["strip", "strip"],
    ["objcopy", "objcopy"],
    ["nm", "nm"],
];

export const TOOLCHAINS: readonly Toolchain[] = ["clang", "clang-ucrt", "msvc"];

export function isToolchain(value: string): value is Toolchain {
    return (TOOLCHAINS as readonly string[]).includes(value);
}

let current: Conf | null = null;

export async function configureToolchain(
    options: CliOptions,
    profile: ToolchainProfile = { asan: false, debugOpt: true, fastmath: true, rtti: false },
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

    let pkgconfPaths = `${root}/lib/pkgconfig:${root}/share/pkgconfig`;
    if (flags.toolchain !== "msvc") {
        pkgconfPaths += ":$PKG_CONFIG_PATH";
    }

    const cFlags = ["-std=gnu17", opt].join(" "),
        cxxFlags = ["-std=gnu++23", opt].join(" "),
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
    const debug = `${DBG_ROOT}/${sub}`,
        release = `${REL_ROOT}/${sub}`;
    return isDebug ? { active: debug, inactive: release } : { active: release, inactive: debug };
}

function replaceEntry(existing: string | undefined, active: string, inactive: string): string {
    const rest = (existing ?? "").split(SEP).filter((entry) => entry && entry !== active && entry !== inactive);
    return [...rest, active].join(SEP);
}

export async function updateEnv(isDebug: boolean) {
    const { cFlags, cxxFlags, includeFlags, ldFlags, root } = await computeFlags(isDebug),
        { tools } = toolchainState();

    const pkgConfPath = dedupPath(
        `${root}/lib/pkgconfig${SEP}${root}/share/pkgconfig${SEP}${process.env.PKG_CONFIG_PATH ?? ""}`,
        SEP,
    );

    const path = dualRoot("bin", isDebug);

    if (toolchainState().toolchain === "msvc") {
        const include = dualRoot("include", isDebug),
            lib = dualRoot("lib", isDebug);

        process.env.INCLUDE = replaceEntry(process.env.INCLUDE, include.active, include.inactive);
        process.env.LIB = replaceEntry(process.env.LIB, lib.active, lib.inactive);
    }

    process.env.PATH = replaceEntry(process.env.PATH, path.active, path.inactive);

    Object.assign(process.env, {
        ADDR2LINE: tools.addr2line,
        AR: tools.ar,
        AS: tools.asm,
        C_INCLUDE_PATH: dedupPath(`${root}/include${SEP}${process.env.C_INCLUDE_PATH ?? ""}`, SEP),
        CC: tools.cc,
        CFLAGS: `${cFlags} ${includeFlags}`,
        CPATH: dedupPath(`${root}/include${SEP}${process.env.CPATH ?? ""}`, SEP),
        CXX: tools.cxx,
        CXXFLAGS: `${cxxFlags} ${includeFlags}`,
        LD: tools.cc,
        LDFLAGS: `${ldFlags} -L${root}/lib ${includeFlags}`,
        LIBRARY_PATH: dedupPath(`${root}/lib${SEP}${process.env.LIBRARY_PATH ?? ""}`, SEP),
        NM: tools.nm,
        OBJCOPY: tools.objcopy,
        OBJDUMP: tools.objdump,
        PKG_CONFIG_PATH: pkgConfPath,
        RANLIB: tools.ranlib,
        RC: tools.rc ?? "",
        STRIP: tools.strip,
        WINDRES: tools.rc ?? "",
    });
}

async function createTargets(toolchain: Toolchain, ...libs: string[]) {
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
        IMPORTED_LOCATION "${REL_ROOT}/lib/${t.lib}"
        INTERFACE_INCLUDE_DIRECTORIES "${REL_ROOT}/include"
    )
endif()`,
        )
        .join("\n\n");

    await writeFile(INJECT_TARGETS, content);
}

async function genToolchains(
    options: CliOptions,
    profile: ToolchainProfile = { asan: false, debugOpt: true, fastmath: true, rtti: false },
): Promise<Conf> {
    const shared = buildShared(options.toolchain, profile),
        debug = buildDebug(options, shared, profile),
        release = buildRelease(options, shared, profile),
        tools = getTools(options.toolchain);

    if (options.toolchain === "msvc") {
        await createTargets(options.toolchain, "bz2.lib", "lzma.lib", "deflatestatic.lib", "zstd_static.lib");
    } else {
        await createTargets(options.toolchain, "libbz2.a", "liblzma.a", "libdeflate.a", "libzstd.a");
    }

    await Promise.all([
        writeFile(DEBUG_NATIVE, toIni(debug, tools)),
        writeFile(RELEASE_NATIVE, toIni(release, tools)),
        writeFile(DEBUG_TOOLCHAIN, toCmakeToolchain(debug, tools)),
        writeFile(RELEASE_TOOLCHAIN, toCmakeToolchain(release, tools)),
    ]);

    return {
        debug: debug.cflags,
        ldDebug: debug.ldflags,
        ldRelease: release.ldflags,
        release: release.cflags,
        toolchain: options.toolchain,
        tools,
        useCodeview: options.useCodeview,
    };
}

function buildDebug(options: CliOptions, shared: Shared, profile: ToolchainProfile): BuildConfig {
    const cflags = [
            ...shared.cflags,
            profile.debugOpt ? "-O3" : "-O0",
            "-g2",
            "-gdwarf-5",
            "-glldb",
            "-gcolumn-info",
            "-fstack-protector-strong",
            "-ftrivial-auto-var-init=pattern",
            "-fstandalone-debug",
        ],
        ldflags = [...shared.ldflags];

    if (options.useCodeview) {
        cflags.push("-gcodeview");
    } else {
        cflags.push("-gz=zstd");
    }

    if (options.toolchain === "msvc") {
        cflags.push("-fms-runtime-lib=dll", "-D_DLL", "-D_MSVC_STL_HARDENING=1", "-D_MSVC_STL_DESTRUCTOR_TOMBSTONES=1");
        //! -D_DLL has to be defined in ldflags in order for the linker to link the right runtime library.
        ldflags.push(
            "-fms-runtime-lib=dll",
            "-D_DLL",
            "-Wl,-DEBUG:FULL",
            "-Wl,-OPT:NOREF",
            "-Wl,-OPT:NOICF",
            "-Wl,-OPT:NOLBR",
        );
    } else {
        cflags.push(
            "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE",
            "-D_GLIBCXX_ASSERTIONS",
            "-D_GLIBCXX_DEBUG",
        );
    }

    if (profile.asan) {
        cflags.push(
            "-fsanitize=address",
            "-fsanitize-address-use-after-scope",
            "-fsanitize-address-use-after-return=runtime",
            "-fsanitize-annotate-debug-info=address",
        );
        ldflags.push("-fsanitize=address");
    }

    if (!WIN) {
        cflags.push("-fstack-clash-protection", "-fdebug-types-section", "-D_FORTIFY_SOURCE=2");
    }

    return {
        buildType: "debug",
        cflags: cflags.join(" "),
        cmakeBuildType: "Debug",
        defaultLibrary: "shared",
        ldflags: ldflags.join(" "),
        prefix: DBG_ROOT,
        toolchain: options.toolchain,
        useCodeview: options.useCodeview,
    };
}

function buildRelease(options: CliOptions, shared: Shared, profile: ToolchainProfile): BuildConfig {
    const commonOptFlags = [
        "-O3",
        "-flto=full",
        "-fmerge-all-constants",
        "-ffunction-sections",
        "-fdata-sections",
        "-fno-math-errno",
        "-fno-trapping-math",
        "-fvisibility=hidden",
        "-fvisibility-inlines-hidden",
        "-Qn",
    ];

    const cflags = [...shared.cflags, ...commonOptFlags],
        linkerFlags =
            options.toolchain === "msvc"
                ? [
                      "-Wl,-DEBUG:NONE",
                      "-Wl,-LTCG",
                      "-Wl,-OPT:REF",
                      "-Wl,-OPT:ICF=10",
                      "-Wl,-OPT:LBR",
                      "-Wl,-INCREMENTAL:NO",
                      "-Wl,-SAFESEH:NO",
                      "-Wl,-EMITTOOLVERSIONINFO:NO",
                      "-Wl,-NOCOFFGRPINFO",
                      "-Wl,-EMITPOGOPHASEINFO",
                  ]
                : [
                      "-Wl,-O3",
                      "-Wl,--lto-O3",
                      "-Wl,--gc-sections",
                      "-Wl,--as-needed",
                      "-Wl,--strip-all",
                      "-Wl,--build-id=none",
                      "-Wl,--icf=all",
                  ];

    if (!profile.rtti) {
        cflags.push("-fno-rtti");
    }

    if (profile.fastmath) {
        cflags.push("-ffast-math");
    }

    if (!WIN) {
        cflags.push("-fno-unwind-tables", "-fno-semantic-interposition", "-fno-plt");
        linkerFlags.push("-Wl,-z,now", "-Wl,-z,norelro", "-Wl,-z,nosectionheader");
    }

    const ldflags = [...shared.ldflags, ...commonOptFlags, ...linkerFlags];

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
        defaultLibrary: "static",
        ldflags: ldflags.join(" "),
        prefix: REL_ROOT,
        toolchain: options.toolchain,
        useCodeview: options.useCodeview,
    };
}

function buildShared(toolchain: Toolchain, profile: ToolchainProfile): Shared {
    const march = profile.march ?? "x86-64-v3",
        mtune = profile.mtune ?? "generic",
        cflags = ["-pipe", `-march=${march}`, `-mtune=${mtune}`, "-w", "-fopenmp", "-lclang_rt.builtins-x86_64"],
        ldflags = [`-march=${march}`, `-mtune=${mtune}`, "-fopenmp", "-lclang_rt.builtins-x86_64"];

    cflags.push("-fuse-ld=lld");
    ldflags.push("-fuse-ld=lld");

    if (WIN) {
        const target = resolveWinTarget(toolchain);

        if (target) {
            cflags.push(`--target=${target}`);
            ldflags.push(`--target=${target}`);
        }

        if (toolchain === "msvc") {
            cflags.push("-DWIN32", "-D_MT", "-DNOMINMAX");
            ldflags.push("-Wl,-IGNORE:LONGSECTIONS");
        }

        if (toolchain === "clang-ucrt") {
            ldflags.push("-lstdc++exp");
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
    return {
        addr2line: "llvm-addr2line",
        ar: "llvm-ar",
        asm: "clang",
        cc: "clang",
        cxx: "clang++",
        dlltool: WIN ? "llvm-dlltool" : null,
        nm: "llvm-nm",
        objcopy: "llvm-objcopy",
        objdump: "llvm-objdump",
        ranlib: "llvm-ranlib",
        rc: WIN ? (toolchain === "msvc" ? "llvm-rc" : "llvm-windres") : null,
        readelf: "llvm-readelf",
        strip: "llvm-strip",
    };
}

function quoteArr(spaceDelimited: string): string {
    const parts = spaceDelimited.split(/\s+/).filter(Boolean);
    return `[${parts.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(", ")}]`;
}

function resolveWinTarget(toolchain: Toolchain): null | string {
    switch (toolchain) {
        case "clang":
        case "clang-ucrt":
            return CLANG_WIN_TARGET;
        case "msvc":
            return MSVC_TARGET;
    }
}

function toCmakeToolchain(b: BuildConfig, tools: Tools): string {
    const lines: string[] = [];

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
    lines.push(`set(CMAKE_C_STANDARD "${C_STD}" CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_CXX_STANDARD "${CXX_STD}" CACHE STRING "" FORCE)`);
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
        if (b.buildType === "debug") {
            lines.push(`set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL" CACHE STRING "" FORCE)`);
        } else {
            lines.push(`set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded" CACHE STRING "" FORCE)`);
        }
    }

    const suffix = b.cmakeBuildType.toUpperCase();
    lines.push(`set(CMAKE_C_FLAGS_${suffix} ${cq(b.cflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_CXX_FLAGS_${suffix} ${cq(b.cflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_EXE_LINKER_FLAGS_${suffix} ${cq(b.ldflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_SHARED_LINKER_FLAGS_${suffix} ${cq(b.ldflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_MODULE_LINKER_FLAGS_${suffix} ${cq(b.ldflags)} CACHE STRING "" FORCE)`);
    lines.push(`set(CMAKE_PREFIX_PATH ${cq(b.prefix)} CACHE STRING "" FORCE)`);

    if (b.useCodeview) {
        lines.push('if (NOT CMAKE_BINARY_DIR MATCHES "/CMakeFiles/CMakeScratch/")');
        lines.push(`    set(CMAKE_PDB_OUTPUT_DIRECTORY "${cq(b.prefix).slice(1, -1)}/bin" CACHE STRING "" FORCE)`);
        lines.push("endif()");
    }

    lines.push(`set(CMAKE_INSTALL_PREFIX ${cq(b.prefix)} CACHE PATH "" FORCE)`);
    lines.push(`set(ICU_ROOT ${cq(b.prefix)} CACHE STRING "" FORCE)`);
    lines.push(`set(ICU_UC_LIBRARY "${cq(b.prefix).slice(1, -1)}/lib/cicuuc.lib" CACHE STRING "" FORCE)`);
    lines.push(`set(ICU_UC_LIBRARY_DEBUG "${cq(b.prefix).slice(1, -1)}/lib/cicuuc.lib" CACHE STRING "" FORCE)`);
    lines.push(`set(ICU_UC_LIBRARY_RELEASE "${cq(b.prefix).slice(1, -1)}/lib/cicuuc.lib" CACHE STRING "" FORCE)`);
    lines.push(`set(ICU_DATA_LIBRARY "${cq(b.prefix).slice(1, -1)}/lib/cicudt.lib" CACHE STRING "" FORCE)`);
    lines.push(`set(ICU_DATA_LIBRARY_DEBUG "${cq(b.prefix).slice(1, -1)}/lib/cicudt.lib" CACHE STRING "" FORCE)`);
    lines.push(`set(ICU_DATA_LIBRARY_RELEASE "${cq(b.prefix).slice(1, -1)}/lib/cicudt.lib" CACHE STRING "" FORCE)`);

    if (WIN) {
        if (b.buildType === "release") {
            lines.push(
                `set(CMAKE_PROJECT_TOP_LEVEL_INCLUDES "\${CMAKE_CURRENT_LIST_DIR}/inject-targets.cmake" CACHE FILEPATH "" FORCE)`,
            );
        }
    }

    return `${lines.join("\n")}\n`;
}

function toIni(b: BuildConfig, tools: Tools): string {
    const lines: string[] = [];

    lines.push("[binaries]");
    const needCompilerArgs = WIN && b.toolchain !== "msvc";
    const target = needCompilerArgs ? resolveWinTarget(b.toolchain) : null;
    for (const [key, prop] of INI_BINARIES) {
        if (needCompilerArgs && (key === "c" || key === "cpp")) {
            const extraArgs = [`-fuse-ld=lld`];
            if (target) {
                extraArgs.push(`--target=${target}`);
            }
            const parts = [tools[prop]!, ...extraArgs].map((v) => `'${v.replace(/'/g, "\\'")}'`);
            lines.push(`${key} = [${parts.join(", ")}]`);
        } else {
            lines.push(`${key} = '${tools[prop]}'`);
        }
    }
    if (tools.rc) {
        lines.push(`windres = '${tools.rc}'`);
    }
    lines.push("[built-in options]");
    lines.push(`c_std = 'gnu${C_STD}'`);
    lines.push(`cpp_std = 'gnu++${CXX_STD}'`);
    lines.push(`default_library = '${b.defaultLibrary}'`);
    lines.push(`buildtype = '${b.buildType}'`);
    lines.push(`prefix = '${b.prefix}'`);
    if (b.toolchain === "msvc") {
        if (b.buildType === "debug") {
            lines.push(`b_vscrt = 'md'`);
        } else {
            lines.push(`b_vscrt = 'mt'`);
        }
    }
    lines.push(`c_args = ${quoteArr(b.cflags)}`);
    lines.push(`c_link_args = ${quoteArr(b.ldflags)}`);
    lines.push(`cpp_args = c_args`);
    lines.push(`cpp_link_args = c_link_args`);
    lines.push("[properties]");
    lines.push(`cmake_prefix_path = ${quoteArr(b.prefix)}`);

    return lines.join("\n");
}
