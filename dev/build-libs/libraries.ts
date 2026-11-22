import $ from "dax";
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";

import {
    applyPatch,
    buildAutoconf,
    buildPlain,
    cmakeVal,
    copyLib,
    movePdbs,
    replaceInFile,
    stripDllImport,
} from "./builders.ts";
import { FFMPEG_VARIANTS, ffmpegCodecArgs } from "./ffmpeg.ts";
import { llvmProject, llvmRuntimes } from "./llvm.ts";
import { ruby } from "./ruby.ts";
import {
    buildDir,
    MAGICK_PGO_VARIANT,
    magickSuffix,
    ROOT,
    settings,
    TOOLCHAINS_DIR,
} from "./settings.ts";
import { bash, raw, toMsysPath } from "./shell.ts";
import type { Library } from "./types.ts";

const ICU_DATA_FILTERS = readFileSync(`${ROOT}/patches/filters.json`, "utf8");

async function withoutLibsProfile<T>(build: () => Promise<T>): Promise<T> {
    const names = ["CFLAGS", "CXXFLAGS", "LDFLAGS"] as const,
        saved = names.map((name) => process.env[name]);
    for (const name of names) {
        process.env[name] = process.env[name]?.replace(/ ?-fprofile-use=\S+/g, "");
    }
    try {
        return await build();
    } finally {
        names.forEach((name, index) => (process.env[name] = saved[index]));
    }
}

export const MSYS2_EXTRA = ["mesa", "imagemagick", "ffmpeg"];

const LIBLTDL_COMMON = `#define HAVE_INTTYPES_H 1
#define HAVE_PRELOADED_SYMBOLS 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define LT_DLSEARCH_PATH "/lib:/usr/lib"
#define LT_LIBPREFIX "lib"
#define LT_OBJDIR ".libs/"
#define PACKAGE "libltdl"
#define PACKAGE_BUGREPORT "bug-libtool@gnu.org"
#define PACKAGE_NAME "libltdl"
#define PACKAGE_STRING "libltdl 2.4.3a"
#define PACKAGE_TARNAME "libltdl"
#define PACKAGE_URL ""
#define PACKAGE_VERSION "2.4.3a"
#define STDC_HEADERS 1
#define VERSION "2.4.3a"
#define error_t int`;
const LIBLTDL_WINDOWS = `
#define HAVE_DECL_CYGWIN_CONV_PATH 0
#define HAVE_LIBDLLOADER 1
#define LTDL_DLOPEN_DEPLIBS 1
#define LT_LIBEXT "lib"
#define LT_MODULE_EXT ".dll"
#define LT_MODULE_PATH_VAR "PATH"
#define __error_t_defined 1`;
const LIBLTDL_DIRENT = `
#define HAVE_CLOSEDIR 1
#define HAVE_DIRENT_H 1
#define HAVE_OPENDIR 1
#define HAVE_READDIR 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_UNISTD_H 1`;
const LIBLTDL_MSVC_CONFIG = LIBLTDL_COMMON + LIBLTDL_WINDOWS;
const LIBLTDL_MINGW_CONFIG = LIBLTDL_COMMON + LIBLTDL_WINDOWS + LIBLTDL_DIRENT;

export const LIBRARIES: Library[] = [
    // --- Tier 0: no dependencies on anything else in this list ---
    {
        name: "opencl-headers",
        source: { git: "https://github.com/KhronosGroup/OpenCL-Headers", tag: "v2026.05.29" },
        msys2: "opencl-headers",
        args: () => `-DOPENCL_HEADERS_BUILD_TESTING=OFF -DOPENCL_HEADERS_BUILD_CXX_TESTS=OFF`,
    },
    {
        name: "glaze",
        source: { git: "https://github.com/stephenberry/glaze", tag: "v9.1.0" },
        msys2: "glaze",
        args: () => "-Dglaze_ENABLE_FUZZING=OFF -Dglaze_DEVELOPER_MODE=OFF",
    },
    {
        name: "googletest",
        source: { git: "https://github.com/google/googletest", tag: "v1.18.0" },
        archPkg: "gtest",
        toolchains: ["msvc"],
        args: ({ isDebug }) => `-Dgtest_force_shared_crt=${cmakeVal(isDebug)}`,
    },

    {
        name: "mimalloc",
        source: { git: "https://github.com/microsoft/mimalloc", tag: "v3.7.0" },
        releaseOnly: true,
        msys2: "mimalloc",
        args: ({ isDebug }) =>
            `-DMI_OPT_ARCH=ON -DMI_OPT_SIMD=ON -DMI_SECURE=${cmakeVal(isDebug)} -DMI_SECURE_FULL=${cmakeVal(isDebug)} -DMI_OVERRIDE=ON -DMI_XMALLOC=OFF -DMI_SHOW_ERRORS=${cmakeVal(isDebug)} -DMI_GUARDED=${cmakeVal(isDebug)} -DMI_FREE_IS_CHECKED=${cmakeVal(isDebug)} -DMI_DEBUG=${cmakeVal(isDebug)} -DMI_DEBUG_INTERNAL=${cmakeVal(isDebug)} -DMI_BUILD_SHARED=${cmakeVal(isDebug)} -DMI_BUILD_STATIC=${cmakeVal(!isDebug)} -DMI_BUILD_OBJECT=OFF -DMI_BUILD_TESTS=OFF -DMI_INSTALL_TOPLEVEL=ON`,
        prepare: async ({ path }) => {
            replaceInFile(`${path}/src/alloc/alloc.c`, "!defined(MI_NO_CXX_NEW_HANDLER)", "fal");
        },
    },
    {
        name: "libtool",
        source: { git: "https://github.com/autotools-mirror/libtool", tag: "v2.6.2" },
        profile: { pgo: false },
        msys2: "libtool",
        prepare: async ({ path }) => {
            const ltdl = `${path}/libltdl/ltdl.c`;
            replaceInFile(
                ltdl,
                "extern LT_DLSYM_CONST lt_dlsymlist preloaded_symbols[]",
                "extern LT_DLSYM_CONST lt_dlsymlist* preloaded_symbols = NULL",
            );
            replaceInFile(
                ltdl,
                "LT_SCOPE const lt_dlvtable *\tget_vtable (lt_user_data data);",
                "LT_SCOPE const lt_dlvtable *\tget_vtable (lt_user_data data);\nLT_SCOPE const lt_dlvtable *\tloadlibrary_LTX_get_vtable (lt_user_data data);",
            );
            replaceInFile(
                ltdl,
                "errors += loader_init (get_vtable, 0);",
                "errors += loader_init (get_vtable, 0);\nerrors += loader_init (loadlibrary_LTX_get_vtable, 0);",
            );
            replaceInFile(
                ltdl,
                "errors += lt_dlpreload_open (LT_STR(LTDLOPEN), loader_init_callback);",
                "",
            );
        },
        build: async ({ isDebug, msvc, path }) => {
            const p = `${path}/libltdl`,
                config = msvc ? LIBLTDL_MSVC_CONFIG : LIBLTDL_MINGW_CONFIG;

            cpSync(`${p}/libltdl/lt__argz_.h`, `${p}/lt__argz.h`);
            writeFileSync(`${p}/config.h`, config);

            await buildPlain(p, isDebug, {
                defines: ["HAVE_CONFIG_H", "LTDL", isDebug ? "DLL_EXPORT" : "LTDL", "LT_DEBUG_LOADERS"],
                headers: ["ltdl.h", "libltdl/lt_dlloader.h", "libltdl/lt_error.h", "libltdl/lt_system.h"],
                includeDirs: ["./", "./libltdl", "./loaders"],
                libName: "libltdl.a",
                sources: [
                    "ltdl.c",
                    "lt_error.c",
                    "lt_dlloader.c",
                    "lt__alloc.c",
                    "lt__strl.c",
                    "lt__argz.c",
                    ...(msvc ? ["lt__dirent.c"] : []),
                    "slist.c",
                    "loaders/preopen.c",
                    "loaders/loadlibrary.c",
                ],
            });
        },
        finish: async ({ isDebug, root }) => {
            if (isDebug) {
                replaceInFile(`${root}/include/libltdl/lt_system.h`, "defined LIBLTDL_DLL_IMPORT", "1");
            }
        },
    },
    {
        name: "bzip2",
        source: { git: "https://sourceware.org/git/bzip2", tag: "bzip2-1.0.8" },
        version: "1.0.8",
        msys2: "bzip2",
        prepare: async ({ path }) => {
            replaceInFile(`${path}/libbz2.def`, /DESCRIPTION.+/g, "");
            replaceInFile(`${path}/libbz2.def`, /LIBRARY.+/g, "LIBRARY bz2");
        },
        build: async ({ isDebug, path }) => {
            await buildPlain(path, isDebug, {
                defFile: "libbz2.def",
                headers: ["bzlib.h"],
                includeDirs: ["./"],
                libName: "libbz2.a",
                sources: [
                    "blocksort.c",
                    "bzlib.c",
                    "compress.c",
                    "crctable.c",
                    "decompress.c",
                    "huffman.c",
                    "randtable.c",
                ],
            });
        },
    },

    {
        name: "double-conversion",
        source: { git: "https://github.com/google/double-conversion", tag: "v3.4.0" },
        msys2: "double-conversion",
        prepare: async ({ path }) => {
            replaceInFile(
                `${path}/CMakeLists.txt`,
                "if(BUILD_SHARED_LIBS AND MSVC)",
                'if(BUILD_SHARED_LIBS AND (MSVC OR (CMAKE_CXX_SIMULATE_ID STREQUAL "MSVC")))',
            );
        },
    },
    {
        name: "zlib-ng",
        source: { git: "https://github.com/zlib-ng/zlib-ng", tag: "2.3.3" },
        msys2: "zlib-ng",
        args: () =>
            `-DWITH_GTEST=OFF -DWITH_FUZZERS=OFF -DWITH_BENCHMARKS=OFF -DWITH_BENCHMARK_APPS=OFF -DWITH_GZFILEOP=OFF -DZLIB_COMPAT=ON -DZLIB_ALIASES=ON -DWITH_OPTIM=ON -DWITH_ALL_FALLBACKS=OFF -DWITH_REDUCED_MEM=OFF -DWITH_NEW_STRATEGIES=ON -DWITH_CRC32_CHORBA=ON -DWITH_NATIVE_INSTRUCTIONS=OFF -DWITH_AVX512=OFF -DWITH_AVX512VNNI=OFF -DWITH_VPCLMULQDQ=OFF -DWITH_MAINTAINER_WARNINGS=OFF -DWITH_CODE_COVERAGE=OFF -DWITH_INFLATE_STRICT=OFF -DWITH_INFLATE_ALLOW_INVALID_DIST=OFF -DINSTALL_UTILS=OFF`,
        prepare: async ({ path }) => {
            replaceInFile(`${path}/CMakeLists.txt`, "set(NOLTOFLAG ${ZNOLTOFLAG})", "");
        },
        finish: async ({ isDebug, msvc, root }) => {
            if (isDebug) {
                if (msvc) {
                    await copyLib(root, "zlib.lib", "z.lib");
                } else {
                    await copyLib(root, "libzlib.dll.a", "libz.dll.a");
                }
            }
        },
    },
    {
        name: "zstd",
        source: { git: "https://github.com/facebook/zstd", tag: "v1.5.7" },
        sourceSubdir: "build/cmake",
        msys2: "zstd",
        args: ({ isDebug }) =>
            `-DZSTD_LEGACY_SUPPORT=ON -DZSTD_MULTITHREAD_SUPPORT=ON -DZSTD_BUILD_PROGRAMS=OFF -DZSTD_BUILD_CONTRIB=OFF -DZSTD_BUILD_TESTS=OFF -DZSTD_BUILD_STATIC=${cmakeVal(!isDebug)} -DZSTD_BUILD_SHARED=${cmakeVal(isDebug)} -DZSTD_USE_STATIC_RUNTIME=${cmakeVal(!isDebug)}`,
        prepare: async ({ msvc, path }) => {
            await applyPatch(path, "zstd-install.patch");
            if (msvc) {
                await applyPatch(path, "zstd-lib-cmakelists.patch");
            }
        },
    },
    {
        name: "brotli",
        source: { git: "https://github.com/google/brotli", tag: "v1.2.1" },
        msys2: "brotli",
        args: () => `-DBROTLI_EMSCRIPTEN=OFF -DBROTLI_BUILD_TOOLS=OFF`,
        prepare: async ({ path }) => {
            await applyPatch(path, "brotli-install.patch");
        },
    },
    {
        name: "highway",
        source: { git: "https://github.com/google/highway", tag: "1.4.0" },
        msys2: "highway",
        args: ({ isDebug }) =>
            `-DHWY_ENABLE_CONTRIB=OFF -DHWY_ENABLE_EXAMPLES=OFF -DHWY_ENABLE_TESTS=OFF -DHWY_FORCE_STATIC_LIBS=${cmakeVal(!isDebug)} -DCMAKE_CXX_FLAGS=-DHWY_COMPILE_ONLY_STATIC`,
        prepare: async ({ path }) => {
            await applyPatch(path, "highway-cmakelists.patch");
        },
    },
    {
        name: "xz",
        source: { git: "https://github.com/tukaani-project/xz", tag: "v5.8.4" },
        msys2: "xz",
        args: () =>
            `-DXZ_NLS=OFF -DXZ_SMALL=OFF -DXZ_TOOL_XZDEC=OFF -DXZ_TOOL_LZMADEC=OFF -DXZ_TOOL_LZMAINFO=OFF -DXZ_TOOL_XZ=OFF -DXZ_DOC=OFF`,
        prepare: async ({ msvc, path }) => {
            if (msvc) {
                replaceInFile(
                    `${path}/CMakeLists.txt`,
                    "if(NOT MSVC AND NOT CYGWIN)",
                    'if (NOT (MSVC OR (CMAKE_C_SIMULATE_ID STREQUAL "MSVC")) AND NOT CYGWIN)',
                );
            }
        },
        finish: async ({ isDebug, root }) => {
            if (!isDebug) {
                stripDllImport(`${root}/include/lzma.h`);
            }
        },
    },
    {
        name: "libdeflate",
        source: { git: "https://github.com/ebiggers/libdeflate", tag: "v1.26" },
        msys2: "libdeflate",
        args: ({ isDebug }) =>
            `-DLIBDEFLATE_COMPRESSION_SUPPORT=ON -DLIBDEFLATE_DECOMPRESSION_SUPPORT=ON -DLIBDEFLATE_ZLIB_SUPPORT=ON -DLIBDEFLATE_GZIP_SUPPORT=OFF -DLIBDEFLATE_BUILD_GZIP=OFF -DLIBDEFLATE_BUILD_TESTS=OFF -DLIBDEFLATE_BUILD_STATIC_LIB=${cmakeVal(!isDebug)} -DLIBDEFLATE_BUILD_SHARED_LIB=${cmakeVal(isDebug)}`,
        finish: async ({ isDebug, root }) => {
            if (!isDebug) {
                stripDllImport(`${root}/include/libdeflate.h`);
            }
        },
    },

    {
        name: "md4c",
        source: { git: "https://github.com/mity/md4c", tag: "release-0.5.3" },
        profile: { debugOpt: false },
        args: () => "-DBUILD_MD2HTML_EXECUTABLE=OFF",
    },
    {
        name: "quickjs",
        source: { git: "https://github.com/quickjs-ng/quickjs", tag: "v0.18.0" },
        archPkg: "quickjs-ng",
        msys2: "quickjs-ng",
        args: () => `-DQJS_ENABLE_ASAN=OFF`,
        prepare: async ({ path }) => {
            await applyPatch(path, "quickjs-cmakelists.patch");
        },
    },
    {
        name: "pcre2",
        source: { git: "https://github.com/PCRE2Project/pcre2", tag: "pcre2-10.49" },
        version: "10.49",
        msys2: "pcre2",
        args: ({ isDebug }) =>
            `-DPCRE2_BUILD_PCRE2_8=ON -DPCRE2_BUILD_PCRE2_16=ON -DPCRE2_BUILD_PCRE2_32=OFF -DPCRE2_STATIC_PIC=OFF -DPCRE2_DEBUG=OFF -DPCRE2_DISABLE_PERCENT_ZT=ON -DPCRE2_EBCDIC=OFF -DPCRE2_EBCDIC_NL25=OFF -DPCRE2_EBCDIC_IGNORING_COMPILER=OFF -DPCRE2_REBUILD_CHARTABLES=OFF -DPCRE2_NEWLINE=LF -DPCRE2_SUPPORT_JIT=ON -DPCRE2_BUILD_PCRE2GREP=OFF -DPCRE2_BUILD_TESTS=OFF -DPCRE2_SUPPORT_BSR_ANYCRLF=ON -DPCRE2_SUPPORT_UNICODE=ON -DPCRE2GREP_SUPPORT_JIT=OFF -DPCRE2GREP_SUPPORT_CALLOUT=OFF -DPCRE2GREP_SUPPORT_CALLOUT_FORK=OFF -DBUILD_STATIC_LIBS=${cmakeVal(!isDebug)} -DLIB_POSTFIX=""`,
        prepare: async ({ path }) => {
            await applyPatch(path, "pcre2-config-shim.patch");
            await $`git submodule update --depth 1 --init sljit`.cwd(`${path}/deps`);
        },
        finish: async ({ isDebug, msvc, root }) => {
            if (!isDebug) {
                stripDllImport(`${root}/include/pcre2.h`);
                replaceInFile(
                    `${root}/lib/cmake/pcre2/pcre2-targets.cmake`,
                    "STATIC IMPORTED",
                    "STATIC IMPORTED GLOBAL",
                );
                return;
            }

            // for libgit2
            if (msvc) {
                await copyLib(root, "pcre2-8d.lib", "pcre2-8.lib");
                await copyLib(root, "pcre2-16d.lib", "pcre2-16.lib");
                await copyLib(root, "pcre2-posixd.lib", "pcre2-posix.lib");
            } else {
                await copyLib(root, "libpcre2-8d.dll.a", "libpcre2-8.dll.a");
                await copyLib(root, "libpcre2-16d.dll.a", "libpcre2-16.dll.a");
                await copyLib(root, "libpcre2-posixd.dll.a", "libpcre2-posix.dll.a");
            }
        },
    },
    {
        name: "openjpeg",
        source: { git: "https://github.com/uclouvain/openjpeg", tag: "v2.5.4" },
        archPkg: "openjpeg2",
        msys2: "openjpeg2",
        args: ({ isDebug }) =>
            `-DBUILD_LUTS_GENERATOR=OFF -DBUILD_UNIT_TESTS=OFF -DBUILD_CODEC=OFF -DBUILD_JPIP=OFF -DBUILD_VIEWER=OFF -DBUILD_JAVA=OFF -DBUILD_STATIC_LIBS=${cmakeVal(!isDebug)}`,
        finish: async ({ isDebug, msvc, root }) => {
            if (!isDebug && msvc) {
                stripDllImport(`${root}/include/openjpeg-2.5/openjpeg.h`);
            }
        },
    },
    {
        name: "openjph",
        source: { git: "https://github.com/aous72/OpenJPH", tag: "0.33.0" },
        msys2: "openjph",
        args: () => `-DOJPH_ENABLE_TIFF_SUPPORT=OFF -DOJPH_DISABLE_AVX512=ON -DOJPH_BUILD_EXECUTABLES=OFF`,
    },
    {
        name: "imath",
        source: { git: "https://github.com/AcademySoftwareFoundation/imath", tag: "v3.2.3" },
        msys2: "imath",
        args: () =>
            `-DPYTHON=OFF -DPYBIND11=OFF -DBUILD_WEBSITE=OFF -DIMATH_HALF_USE_LOOKUP_TABLE=ON -DIMATH_USE_DEFAULT_VISIBILITY=OFF -DIMATH_ENABLE_LARGE_STACK=OFF -DIMATH_USE_NOEXCEPT=OFF -DIMATH_INSTALL_PKG_CONFIG=ON`,
        finish: async ({ isDebug, msvc, root }) => {
            if (!msvc && isDebug) {
                replaceInFile(`${root}/include/Imath/ImathVec.h`, "/// @cond Doxygen_Suppress", "/*");
                replaceInFile(`${root}/include/Imath/ImathVec.h`, "/// @endcond Doxygen_Suppress", "*/");
            }
        },
    },
    {
        name: "lcms2",
        source: { git: "https://github.com/mm2/Little-CMS", tag: "lcms2.20" },
        msys2: "lcms2",
        args: ({ isDebug }) =>
            `-DLCMS2_BUILD_TOOLS=OFF -DLCMS2_BUILD_TESTS=OFF -DLCMS2_BUILD_JPGICC=OFF -DLCMS2_BUILD_TIFICC=OFF -DLCMS2_BUILD_TIFDIFF=OFF -DLCMS2_BUILD_SHARED=${cmakeVal(isDebug)} -DLCMS2_BUILD_STATIC=${cmakeVal(!isDebug)}`,
        prepare: async ({ path }) => {
            await applyPatch(path, "lcms2-install.patch");
        },
    },
    {
        name: "openh264",
        source: { git: "https://github.com/cisco/openh264", tag: "v2.7.0" },
        build: "meson",
        msys2: "openh264",
        args: () => "-Dtests=disabled",
        finish: async ({ isDebug, msvc, root }) => {
            if (!isDebug && msvc) {
                await copyLib(root, "libopenh264.a", "openh264.lib");
            }
        },
    },
    {
        name: "dav1d",
        source: { git: "https://code.videolan.org/videolan/dav1d", tag: "1.5.5" },
        build: "meson",
        msys2: "dav1d",
        args: () =>
            "-Denable_asm=true -Denable_tools=false -Denable_examples=false -Denable_tests=false -Denable_seek_stress=false -Denable_docs=false -Dlogging=false -Dtestdata_tests=false -Dfuzzing_engine=none -Dtrim_dsp=true",
        finish: async ({ isDebug, msvc, root }) => {
            if (!isDebug && msvc) {
                await copyLib(root, "libdav1d.a", "dav1d.lib");
            }
        },
    },
    {
        name: "kvazaar",
        source: { git: "https://github.com/ultravideo/kvazaar", tag: "v2.3.2" },
        msys2: "kvazaar",
        args: () => "-DBUILD_TESTS=OFF -DUSE_CRYPTO=OFF -DBUILD_KVAZAAR_BINARY=OFF",
        prepare: async ({ msvc, path }) => {
            await applyPatch(path, "kvazaar-install.patch");
            if (msvc) {
                await applyPatch(path, "kvazaar-cmakelists.patch");
            } else {
                replaceInFile(`${path}/CMakeLists.txt`, "-Wa,-muse-unaligned-vector-move", "");
            }
        },
        finish: async ({ isDebug, root }) => {
            if (!isDebug) {
                stripDllImport(`${root}/include/kvazaar.h`);
            }
        },
    },
    {
        name: "rav1e",
        source: { git: "https://github.com/xiph/rav1e", tag: "v0.8.1" },
        build: "rust",
        msys2: "rav1e",
        args: () => "--features capi,asm,threading",
        finish: async ({ isDebug, msvc, root }) => {
            if (isDebug && msvc) {
                await $`mv ${`${root}/lib/rav1e.dll.lib`} ${`${root}/lib/rav1e.lib`}`;
            }
        },
    },
    {
        name: "glfw",
        source: { git: "https://github.com/glfw/glfw", tag: "3.5.1" },
        msys2: "glfw",
        args: ({ isDebug }) =>
            `-DGLFW_BUILD_EXAMPLES=OFF -DGLFW_BUILD_TESTS=OFF -DGLFW_BUILD_DOCS=OFF -DGLFW_INSTALL=ON -DGLFW_LIBRARY_TYPE=${isDebug ? "SHARED" : "STATIC"}`,
    },
    {
        name: "icu",
        source: { git: "https://github.com/unicode-org/icu", tag: "release-79.1" },
        profile: { rtti: true },
        msys2: "icu",
        prepare: async ({ msvc, path }) => {
            const source = `${path}/icu4c/source`;
            replaceInFile(`${source}/icudefs.mk.in`, "STATIC_PREFIX_WHEN_USED = s", "STATIC_PREFIX_WHEN_USED =");
            replaceInFile(`${source}/icudefs.mk.in`, "STATIC_PREFIX = s", "STATIC_PREFIX =");

            replaceInFile(
                `${source}/data/pkgdataMakefile.in`,
                "OUTPUTFILE=icupkg.inc",
                "OUTPUTFILE=icupkg.inc\nCFLAGS += -fno-lto\nCXXFLAGS += -fno-lto\nLDFLAGSICUDT += -fno-lto",
            );

            // Builds may go to another device, avoid symlinks
            for (const dir of [".", "common", "i18n", "io", "stubdata", "tools/toolutil"]) {
                replaceInFile(`${source}/${dir}/Makefile.in`, "ln -s", "cp -rf");
            }
            replaceInFile(`${source}/tools/pkgdata/pkgdata.cpp`, '#define LN_CMD "ln -s"', '#define LN_CMD "cp -f"');

            if (msvc) {
                await applyPatch(path, "plurrule.patch");
                await $`cp ${`${ROOT}/patches/mh-cygwin-clang-msvc.txt`} icu4c/source/config/mh-cygwin-msvc`.cwd(path);
                replaceInFile(`${source}/tools/pkgdata/pkgdata.cpp`, "LIB.exe /nologo /out:", "llvm-ar qc ");
                replaceInFile(`${source}/tools/pkgdata/pkgdata.cpp`, "link.exe", "lld-link");
                replaceInFile(`${source}/data/makedata.mak`, "rc.exe", "llvm-rc");
                replaceInFile(`${source}/data/Makefile.in`, "rc.exe", "llvm-rc");
            }
        },
        build: async ({ isDebug, msvc, path, root }) => {
            const sourceDir = `${path}/icu4c/source`;
            writeFileSync(`${sourceDir}/filters.json`, ICU_DATA_FILTERS);
            const common = `--enable-option-checking --disable-tests --disable-samples --enable-tools --disable-icu-config --disable-extras --disable-icuio --disable-layout --disable-layoutex --disable-dyload --disable-fuzzer --disable-tracing --disable-plugins --disable-draft --with-library-suffix=""`;

            const icuPlatform = msvc ? "Cygwin" : "MinGW";

            await buildAutoconf(sourceDir, isDebug, root, {
                args: `${common} --with-data-packaging=${isDebug ? "library" : "static"}`,
                configure: `./runConfigureICU ${icuPlatform}`,
                env: `ICU_DATA_FILTER_FILE=filters.json CPPFLAGS="-DUCONFIG_NO_COLLATION=ON -DUCONFIG_NO_FORMATTING=ON -DUCONFIG_NO_TRANSLITERATION=ON -DUCONFIG_NO_REGULAR_EXPRESSIONS=ON -DUCONFIG_NO_SERVICE=ON -DUCONFIG_NO_IDNA=ON -DUCONFIG_NO_CONVERSION=OFF -DUCONFIG_NO_LEGACY_CONVERSION=OFF -DUCONFIG_NO_NORMALIZATION=OFF"`,
                libtool: false,
                makeEnv: msvc ? `MSYS2_ARG_CONV_EXCL="*"` : "",
            });
        },
        finish: async ({ isDebug, msvc, path, root }) => {
            if (msvc) {
                if (isDebug) {
                    movePdbs(`${path}/icu4c/source/bin`, `${root}/bin`);
                    movePdbs(`${path}/icu4c/source/lib`, `${root}/bin`);
                } else {
                    await $`mv ${`${root}/bin/icudt.lib`} ${`${root}/lib/icudt.lib`}`;
                }

                for (const lib of ["icudt", "icuuc", "icuin", "icutest", "icutu"]) {
                    await $`mv ${`${root}/lib/${lib}.lib`} ${`${root}/lib/c${lib}.lib`}`;
                }
            } else if (!isDebug) {
                await $`mv ${`${root}/bin/libicudt.a`} ${`${root}/lib/libicudt.a`}`;
            }

            if (!isDebug) {
                stripDllImport(`${root}/include/unicode/platform.h`);
            }
        },
    },
    {
        name: "libde265",
        source: { git: "https://github.com/strukturag/libde265", tag: "v1.1.3" },
        msys2: "libde265",
        args: () =>
            `-DUSE_IWYU=OFF -DENABLE_SDL=OFF -DENABLE_SIMD=ON -DENABLE_AVX2=ON -DENABLE_AVX512=OFF -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF -DENABLE_SHERLOCK265=OFF -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=OFF -DWITH_FUZZERS=OFF -DFORCE_FULL_VISIBILITY=OFF`,
        finish: async ({ isDebug, root }) => {
            if (!isDebug) {
                stripDllImport(`${root}/include/libde265/de265.h`);
            }
        },
    },
    {
        name: "libwebp",
        source: { git: "https://github.com/webmproject/libwebp", tag: "v1.6.0" },
        msys2: "libwebp",
        args: ({ isDebug }) =>
            `-DWEBP_ENABLE_SIMD=ON -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_LIBWEBPMUX=ON -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF -DWEBP_BUILD_FUZZTEST=OFF -DWEBP_USE_THREAD=ON -DWEBP_NEAR_LOSSLESS=ON -DWEBP_ENABLE_SWAP_16BIT_CSP=OFF -DWEBP_ENABLE_WUNUSED_RESULT=OFF -DWEBP_BUILD_WEBP_JS=OFF -DWEBP_UNICODE=OFF -DWEBP_LINK_STATIC=${cmakeVal(!isDebug)}`,
        prepare: async ({ path }) => {
            await applyPatch(path, "libwebp-install.patch");
        },
    },
    {
        name: "libspng",
        source: { git: "https://github.com/randy408/libspng", tag: "v0.7.4" },
        msys2: "libspng",
        args: ({ isDebug }) => `-DENABLE_OPT=ON -DSPNG_SHARED=${cmakeVal(isDebug)} -DSPNG_STATIC=${cmakeVal(!isDebug)}`,
        finish: async ({ root }) => {
            replaceInFile(
                `${root}/lib/cmake/spng/SPNGConfig.cmake`,
                "find_dependency(ZLIB REQUIRED)",
                "include(CMakeFindDependencyMacro)\nfind_dependency(ZLIB REQUIRED)",
            );
        },
    },
    {
        // TODO: Switch to v4.2.0 when it comes out
        name: "projectm",
        source: { git: "https://github.com/projectM-visualizer/projectm", tag: "master" },
        archPkg: "libprojectm",
        profile: { debugOpt: false },
        args: () => "-DENABLE_DEBUG_POSTFIX=OFF -DENABLE_PLAYLIST=OFF",
        prepare: async ({ path }) => {
            await $`git submodule update --depth 1 --init --recursive`.cwd(path);
        },
    },

    // --- Tier 1: depend only on Tier 0 libs ---
    {
        name: "opencl-icd",
        source: { git: "https://github.com/KhronosGroup/OpenCL-ICD-Loader", tag: "v2026.05.29" },
        archPkg: "ocl-icd",
        profile: { pgo: false },
        msys2: "opencl-icd",
        args: () => `-DOPENCL_ICD_LOADER_BUILD_TESTING=OFF -DENABLE_OPENCL_LAYERINFO=OFF`,
        finish: async ({ isDebug, msvc, root }) => {
            if (!isDebug && !msvc) {
                await copyLib(root, "OpenCL.a", "libOpenCL.a");
            }
        },
    },
    {
        name: "libjpeg-turbo",
        source: { git: "https://github.com/libjpeg-turbo/libjpeg-turbo", tag: "3.2.1" },
        msys2: "libjpeg-turbo",
        args: ({ isDebug }) =>
            `-DWITH_ARITH_DEC=ON -DWITH_ARITH_ENC=ON -DWITH_JAVA=OFF -DWITH_JPEG7=OFF -DWITH_JPEG8=OFF -DWITH_SIMD=ON -DWITH_TURBOJPEG=ON -DWITH_TOOLS=OFF -DWITH_TESTS=OFF -DWITH_FUZZ=OFF -DFORCE_INLINE=ON -DENABLE_SHARED=${cmakeVal(isDebug)} -DENABLE_STATIC=${cmakeVal(!isDebug)} -DWITH_SYSTEM_SPNG=ON -DWITH_SYSTEM_ZLIB=ON`,
        finish: async ({ isDebug, msvc, root }) => {
            if (msvc && !isDebug) {
                await copyLib(root, "jpeg-static.lib", "jpeg.lib");
            }
        },
        prepare: async ({ path }) => {
            await applyPatch(path, "libjpeg-turbo-install.patch");
            await applyPatch(path, "libjpeg-turbo-simdcoverage.patch");
        },
    },
    {
        name: "libpng",
        source: { git: "https://github.com/pnggroup/libpng", tag: "v1.6.59" },
        msys2: "libpng",
        args: ({ isDebug }) =>
            `-DPNG_TESTS=OFF -DPNG_TOOLS=OFF -DPNG_EXECUTABLES=OFF -DPNG_HARDWARE_OPTIMIZATIONS=ON -DPNG_BUILD_ZLIB=OFF -DPNG_SHARED=${cmakeVal(isDebug)} -DPNG_STATIC=${cmakeVal(!isDebug)} -DPNG_DEBUG_POSTFIX=""`,
        prepare: async ({ msvc, path }) => {
            await applyPatch(path, "libpng-install.patch");
            if (msvc) {
                replaceInFile(
                    `${path}/CMakeLists.txt`,
                    "if(NOT CMAKE_HOST_WIN32 OR CYGWIN OR MINGW)",
                    "if(CMAKE_HOST_WIN32 OR CYGWIN OR MINGW)",
                );
                replaceInFile(
                    `${path}/CMakeLists.txt`,
                    "if(NOT WIN32 OR CYGWIN OR MINGW)",
                    "if(WIN32 OR CYGWIN OR MINGW)",
                );
            }

            // Causes fail in CI for some reason
            replaceInFile(`${path}/pngpriv.h`, "#  error The include path of <zlib.h> is incorrect", "");
        },
        finish: async ({ isDebug, msvc, root }) => {
            if (isDebug && msvc) {
                await copyLib(root, "libpng16.lib", "png16.lib");
            } else if (isDebug) {
                await copyLib(root, "libpng16.dll.a", "libpng.dll.a");
            } else if (msvc) {
                await copyLib(root, "libpng.lib", "png16.lib");
            }
        },
    },
    {
        name: "nuspell",
        source: { git: "https://github.com/nuspell/nuspell", tag: "v5.1.9" },
        msys2: "nuspell",
        prepare: async ({ path }) => {
            await applyPatch(path, "nuspell-install.patch");
            appendFileSync(
                `${path}/src/nuspell/CMakeLists.txt`,
                "\nif(NOT BUILD_SHARED_LIBS)\ntarget_compile_definitions(nuspell PUBLIC U_STATIC_IMPLEMENTATION)\nendif()\n",
            );
        },
    },
    {
        name: "libraw",
        source: {
            archive: "https://www.libraw.org/data/LibRaw-0.22.3-Win64.zip",
            subdir: "LibRaw-0.22.3",
            version: "0.22.3",
        },
        msys2: "libraw",
        build: async ({ isDebug, path, root }) => {
            await buildAutoconf(path, isDebug, root, {
                args: `--enable-openmp --enable-jpeg --enable-zlib --enable-lcms --disable-examples`,
                env: `CPPFLAGS="${isDebug ? "-DLIBRAW_BUILDLIB" : "-DLIBRAW_NODLL"}"`,
            });
        },
        finish: async ({ isDebug, msvc, path, root }) => {
            if (isDebug && msvc) {
                movePdbs(`${path}/lib/.libs`, `${root}/bin`);
                await copyLib(root, "raw.dll.lib", "raw.lib");
                await copyLib(root, "raw_r.dll.lib", "raw_r.lib");
            }

            replaceInFile(`${root}/lib/pkgconfig/libraw.pc`, "-lstdc++", "");
            replaceInFile(`${root}/lib/pkgconfig/libraw_r.pc`, "-lstdc++", "");

            if (!isDebug) {
                stripDllImport(`${root}/include/libraw/libraw_types.h`);
            }
        },
    },
    {
        name: "libxml2",
        source: { git: "https://gitlab.gnome.org/GNOME/libxml2", tag: "v2.15.4" },
        msys2: "libxml2",
        args: () =>
            `-DLIBXML2_WITH_CATALOG=OFF -DLIBXML2_WITH_DEBUG=OFF -DLIBXML2_WITH_DOCS=OFF -DLIBXML2_WITH_HTML=OFF -DLIBXML2_WITH_HTTP=OFF -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_ICU=OFF -DLIBXML2_WITH_ISO8859X=ON -DLIBXML2_WITH_LEGACY=OFF -DLIBXML2_WITH_MODULES=OFF -DLIBXML2_WITH_OUTPUT=ON -DLIBXML2_WITH_PATTERN=OFF -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_PUSH=ON -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_READLINE=OFF -DLIBXML2_WITH_REGEXPS=OFF -DLIBXML2_WITH_SAX1=ON -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_TLS=OFF -DLIBXML2_WITH_VALID=OFF -DLIBXML2_WITH_XINCLUDE=OFF -DLIBXML2_WITH_XPATH=OFF -DLIBXML2_WITH_ZLIB=ON -DLIBXML2_WITH_C14N=OFF -DLIBXML2_WITH_HISTORY=OFF -DLIBXML2_WITH_READER=ON -DLIBXML2_WITH_SCHEMAS=OFF -DLIBXML2_WITH_SCHEMATRON=OFF -DLIBXML2_WITH_THREAD_ALLOC=ON -DLIBXML2_WITH_WRITER=ON -DLIBXML2_WITH_XPTR=OFF -DLIBXML2_WITH_RELAXNG=OFF -DLIBXML2_WITH_THREADS=ON`,
        finish: async ({ msvc, root }) => {
            if (msvc) {
                await copyLib(root, "libxml2.lib", "xml2.lib");
            }
        },
        prepare: async ({ path }) => {
            await applyPatch(path, "libxml2-config-shim.patch");
        },
    },
    {
        name: "libzip",
        source: { git: "https://github.com/nih-at/libzip/", tag: "v1.12.1" },
        msys2: "libzip",
        args: () =>
            `-DENABLE_COMMONCRYPTO=OFF -DENABLE_GNUTLS=OFF -DENABLE_MBEDTLS=OFF -DENABLE_OPENSSL=OFF -DENABLE_WINDOWS_CRYPTO=OFF -DENABLE_BZIP2=ON -DENABLE_LZMA=ON -DENABLE_ZSTD=ON -DENABLE_FDOPEN=ON -DBUILD_REGRESS=OFF -DBUILD_OSSFUZZ=OFF`,
        prepare: async ({ path }) => {
            await applyPatch(path, "libzip-install.patch");
        },
    },
    {
        name: "libtiff",
        source: { git: "https://gitlab.com/libtiff/libtiff", tag: "v4.7.2" },
        msys2: "libtiff",
        args: ({ isDebug }) =>
            `-Dtiff-tools=OFF -Dtiff-tests=OFF -Dtiff-contrib=OFF -Dtiff-docs=OFF -Dtiff-deprecated=OFF -Dtiff-static=${cmakeVal(!isDebug)} -Dlerc=OFF -Djbig=OFF -DTIFF_STATIC_LIBS_DEFAULT=${cmakeVal(!isDebug)}`,
    },
    {
        name: "openexr",
        source: { git: "https://github.com/AcademySoftwareFoundation/openexr", tag: "v3.5.4" },
        profile: { rtti: true },
        msys2: "openexr",
        args: () =>
            `-DOPENEXR_INSTALL_DOCS=OFF -DBUILD_WEBSITE=OFF -DOPENEXR_ENABLE_THREADING=ON -DOPENEXR_USE_TBB=OFF -DOPENEXR_USE_DEFAULT_VISIBILITY=OFF -DOPENEXR_ENABLE_LARGE_STACK=OFF -DOPENEXR_BUILD_TOOLS=OFF -DOPENEXR_INSTALL_TOOLS=OFF -DOPENEXR_INSTALL_DEVELOPER_TOOLS=OFF -DOPENEXR_BUILD_EXAMPLES=OFF -DOPENEXR_BUILD_PYTHON=OFF -DOPENEXR_BUILD_OSS_FUZZ=OFF -DOPENEXR_TEST_LIBRARIES=OFF -DOPENEXR_TEST_TOOLS=OFF -DOPENEXR_TEST_PYTHON=OFF -DOPENEXR_USE_CLANG_TIDY=OFF -DOPENEXR_FORCE_INTERNAL_DEFLATE=OFF -DOPENEXR_FORCE_INTERNAL_OPENJPH=OFF -DOPENEXR_FORCE_INTERNAL_IMATH=OFF -DOPENEXR_INSTALL_PKG_CONFIG=ON`,
        prepare: async ({ path }) => {
            replaceInFile(`${path}/CMakeLists.txt`, "add_subdirectory(website/src)", "");
            // shortcut: OpenEXR 3.5.4 vendors OpenJPH 0.33 but still requires 0.32 for discovery, so a PATH-found msys64 0.32 wins; drop once upstream bumps the minimum
            replaceInFile(
                `${path}/cmake/OpenEXRSetup.cmake`,
                "set(OPENEXR_MINIMUM_OPENJPH_VERSION 0.32.0)",
                "set(OPENEXR_MINIMUM_OPENJPH_VERSION 0.33.0)",
            );
        },
    },
    {
        name: "freetype",
        source: { git: "https://gitlab.freedesktop.org/freetype/freetype", tag: "VER-2-15-0" },
        archPkg: "freetype2",
        msys2: "freetype",
        args: () =>
            `-DFT_DISABLE_ZLIB=OFF -DFT_REQUIRE_ZLIB=ON -DFT_DISABLE_BZIP2=OFF -DFT_REQUIRE_BZIP2=ON -DFT_DISABLE_PNG=OFF -DFT_REQUIRE_PNG=ON -DFT_DISABLE_HARFBUZZ=ON -DFT_DYNAMIC_HARFBUZZ=OFF -DFT_REQUIRE_HARFBUZZ=OFF -DFT_DISABLE_BROTLI=ON -DFT_REQUIRE_BROTLI=OFF -DDISABLE_FORCE_DEBUG_POSTFIX=ON`,
    },
    {
        name: "libgit2",
        source: { git: "https://github.com/libgit2/libgit2", tag: "v1.9.7" },
        msys2: "libgit2",
        args: () =>
            `-DBUILD_CLI=OFF -DBUILD_FUZZERS=OFF -DUSE_THREADS=ON -DUSE_NSEC=ON -DUSE_SSH=OFF -DUSE_HTTPS=ON -DREGEX_BACKEND=pcre2 -DDEPRECATE_HARD=ON`,
        prepare: async ({ path }) => {
            replaceInFile(`${path}/CMakeLists.txt`, "include(DefaultCFlags)", "");
        },
    },

    // --- Tier 2: depend on Tier 1 libs ---
    {
        name: "fltk",
        source: { git: "https://github.com/fltk/fltk", tag: "release-1.4.5" },
        profile: { asan: true, debugOpt: false, rtti: true },
        args: ({ isDebug }) =>
            `-DFLTK_BUILD_SHARED_LIBS=OFF -DFLTK_USE_SYSTEM_ZLIB=ON -DFLTK_USE_SYSTEM_LIBPNG=ON -DFLTK_USE_SYSTEM_LIBJPEG=ON -DFLTK_OPTION_SVG=OFF -DFLTK_BUILD_FLUID=OFF -DFLTK_BUILD_FLTK_OPTIONS=OFF -DFLTK_BUILD_GL=ON -DFLTK_BUILD_FORMS=OFF -DFLTK_BUILD_TEST=OFF -DFLTK_BUILD_HTML_DOCS=OFF -DFLTK_OPTION_PEN_SUPPORT=OFF -DFLTK_OPTION_LARGE_FILE=OFF -DFLTK_OPTION_PRINT_SUPPORT=OFF -DFLTK_OPTION_FILESYSTEM_SUPPORT=ON -DFLTK_OPTION_STD=ON -DFLTK_GRAPHICS_GDIPLUS=ON -DFLTK_MSVC_RUNTIME_DLL=${cmakeVal(isDebug)}`,
        finish: async ({ isDebug, root }) => {
            if (!isDebug) {
                stripDllImport(`${root}/include/FL/Fl_Export.H`);
            }
        },
        prepare: async ({ path }) => {
            await applyPatch(path, "fltk-config-shim.patch");
        },
    },
    {
        name: "harfbuzz",
        source: { git: "https://github.com/harfbuzz/harfbuzz", tag: "15.1.0" },
        build: "meson",
        msys2: "harfbuzz",
        args: () =>
            `-Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled -Dicu=disabled -Dgraphite2=disabled -Dfreetype=enabled -Ddirectwrite=enabled -Dgdi=disabled -Draster=disabled -Dvector=disabled -Dgpu=disabled -Dgpu_demo=disabled -Dtests=disabled -Dutilities=disabled -Dintrospection=disabled -Ddocs=disabled`,
        finish: async ({ isDebug, msvc, root }) => {
            if (!isDebug && msvc) {
                await copyLib(root, "libharfbuzz.a", "harfbuzz.lib");
            }
        },
    },
    {
        name: "libjxl",
        source: { git: "https://github.com/libjxl/libjxl", tag: "v0.13.0" },
        msys2: "libjxl",
        args: ({ isDebug }) =>
            `-DJPEGXL_ENABLE_FUZZERS=OFF -DJPEGXL_ENABLE_DEVTOOLS=OFF -DJPEGXL_ENABLE_TESTS=OFF -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_MANPAGES=OFF -DJPEGXL_ENABLE_BENCHMARK=OFF -DJPEGXL_ENABLE_EXAMPLES=OFF -DJPEGXL_BUNDLE_LIBPNG=OFF -DJPEGXL_ENABLE_JNI=OFF -DJPEGXL_ENABLE_SJPEG=OFF -DJPEGXL_ENABLE_OPENEXR=ON -DJPEGXL_ENABLE_SKCMS=OFF -DJPEGXL_ENABLE_VIEWERS=OFF -DJPEGXL_ENABLE_TCMALLOC=OFF -DJPEGXL_ENABLE_PLUGINS=OFF -DJPEGXL_ENABLE_COVERAGE=OFF -DJPEGXL_ENABLE_TRANSCODE_JPEG=ON -DJPEGXL_ENABLE_BOXES=ON -DJPEGXL_WARNINGS_AS_ERRORS=OFF -DJPEGXL_TEST_TOOLS=OFF -DJPEGXL_ENABLE_WASM_THREADS=OFF -DJPEGXL_FORCE_SYSTEM_BROTLI=ON -DJPEGXL_FORCE_SYSTEM_GTEST=ON -DJPEGXL_FORCE_SYSTEM_LCMS2=ON -DJPEGXL_FORCE_SYSTEM_HWY=ON -DJPEGXL_STATIC=${cmakeVal(!isDebug)}`,
        prepare: async ({ path }) => {
            replaceInFile(`${path}/CMakeLists.txt`, "add_subdirectory(tools)", "");
            replaceInFile(`${path}/lib/jxl_extras.cmake`, "find_package(GIF 5.1)", "");
        },
        finish: async ({ isDebug, root }) => {
            if (!isDebug) {
                stripDllImport(`${root}/include/jxl/jxl_export.h`);
            }
        },
    },
    {
        name: "libarchive",
        source: { git: "https://github.com/libarchive/libarchive", tag: "v3.8.11" },
        msys2: "libarchive",
        args: () =>
            `-DENABLE_MBEDTLS=OFF -DENABLE_NETTLE=OFF -DENABLE_OPENSSL=OFF -DENABLE_LIBB2=OFF -DENABLE_LZ4=OFF -DENABLE_LZO=OFF -DENABLE_LZMA=ON -DENABLE_ZSTD=OFF -DENABLE_ZLIB=OFF -DENABLE_BZip2=OFF -DENABLE_LIBXML2=OFF -DENABLE_EXPAT=OFF -DENABLE_WIN32_XMLLITE=OFF -DENABLE_PCREPOSIX=OFF -DENABLE_PCRE2POSIX=OFF -DENABLE_LIBGCC=OFF -DENABLE_CNG=ON -DENABLE_TAR=OFF -DENABLE_CPIO=OFF -DENABLE_CAT=OFF -DENABLE_UNZIP=OFF -DENABLE_XATTR=OFF -DENABLE_ACL=OFF -DENABLE_ICONV=OFF -DENABLE_TEST=OFF -DENABLE_COVERAGE=OFF -DENABLE_WERROR=OFF -DPOSIX_REGEX_LIB=NONE`,
        finish: async ({ isDebug, root }) => {
            if (!isDebug) {
                stripDllImport(`${root}/include/archive.h`);
                stripDllImport(`${root}/include/archive_entry.h`);
            }
        },
        prepare: async ({ path }) => {
            await applyPatch(path, "libarchive-install.patch");
        },
    },

    // --- Tier 3: depends on Tier 2/1 ---
    {
        name: "libheif",
        source: { git: "https://github.com/strukturag/libheif", tag: "v1.23.7" },
        profile: { rtti: true },
        msys2: "libheif",
        args: () =>
            `-DWITH_EXAMPLES=OFF -DWITH_EXAMPLE_HEIF_THUMB=OFF -DWITH_EXAMPLE_HEIF_VIEW=OFF -DWITH_GDK_PIXBUF=OFF -DENABLE_PLUGIN_LOADING=OFF -DWITH_LIBDE265=ON -DWITH_X265=OFF -DWITH_KVAZAAR=ON -DWITH_UVG266=OFF -DWITH_VVDEC=OFF -DWITH_VVENC=OFF -DWITH_X264=OFF -DWITH_OpenH264_DECODER=ON -DWITH_DAV1D=ON -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF -DWITH_SvtEnc=OFF -DWITH_RAV1E=ON -DWITH_JPEG_DECODER=ON -DWITH_JPEG_ENCODER=OFF -DWITH_OpenJPEG_ENCODER=OFF -DWITH_OpenJPEG_DECODER=ON -DWITH_FFMPEG_DECODER=OFF -DWITH_OPENJPH_ENCODER=OFF -DWITH_UNCOMPRESSED_CODEC=OFF -DWITH_WEBCODECS=OFF -DWITH_LIBSHARPYUV=ON -DBUILD_DOCUMENTATION=OFF`,
        finish: async ({ isDebug, root }) => {
            if (!isDebug) {
                stripDllImport(`${root}/include/libheif/heif_export.h`);
            }
        },
    },
    /* Disabled; its CLANG64 package is still installed (MSYS2_EXTRA).
    {
        name: "mesa",
        source: { git: "https://gitlab.freedesktop.org/mesa/mesa", tag: "mesa-26.2.6" },
        build: "meson",
        mesonCommand: ["uv", "run", "--with", "mako,setuptools,pyyaml", "meson"],
        args: () =>
            `-Dplatforms=windows -Degl=enabled -Degl-native-platform=surfaceless -Dgles1=disabled -Dgles2=enabled -Dopengl=true -Dglx=disabled -Dgallium-drivers=d3d12 -Dgallium-d3d12-graphics=enabled -Dgallium-d3d12-video=disabled -Dvulkan-drivers= -Dllvm=disabled -Dshader-cache=disabled -Dxmlconfig=disabled -Dexpat=disabled -Dzlib=disabled -Dzstd=disabled -Dvalgrind=disabled -Dlibunwind=disabled -Dlmsensors=disabled -Ddisplay-info=disabled -Dmicrosoft-clc=disabled -Dspirv-to-dxil=false -Dbuild-tests=false -Dhtml-docs=disabled -Dmin-windows-version=10 -Dvideo-codecs=`,
        prepare: async ({ msvc, path }) => {
            if (msvc) {
                await $`sd -s -- "_interlockedexchange64" "_InterlockedExchange64" src/util/u_atomic.h`.cwd(path);
                await $`sd -s -- "_interlockedexchangeadd64" "_InterlockedExchangeAdd64" src/util/u_atomic.h`.cwd(path);
                await $`sd -s -- "_interlockeddecrement64" "_InterlockedDecrement64" src/util/u_atomic.h`.cwd(path);
                await $`sd -s -- "_interlockedincrement64" "_InterlockedIncrement64" src/util/u_atomic.h`.cwd(path);
                const shimOld =
                        "__forceinline char _interlockedadd8(char volatile * _Addend, char _Value)\n{\n   return _InterlockedExchangeAdd8(_Addend, _Value) + _Value;\n}\n\n__forceinline short _interlockedadd16(short volatile * _Addend, short _Value)\n{\n   return _InterlockedExchangeAdd16(_Addend, _Value) + _Value;\n}\n\n",
                    addLines: [string, string][] = [
                        [
                            "_interlockedadd8 ((char *)   (_v), (char) (_i)) : \\",
                            "_InterlockedExchangeAdd8 ((char *)   (_v), (char) (_i)) + (char) (_i) : \\",
                        ],
                        [
                            "_interlockedadd16((short *)  (_v), (short) (_i)) : \\",
                            "_InterlockedExchangeAdd16((short *)  (_v), (short) (_i)) + (short) (_i) : \\",
                        ],
                        [
                            "_interlockedadd  ((long *)   (_v), (long) (_i)) : \\",
                            "_InterlockedExchangeAdd  ((long *)   (_v), (long) (_i)) + (long) (_i) : \\",
                        ],
                        [
                            "_interlockedadd64((__int64 *)(_v), (__int64) (_i)) : \\",
                            "_InterlockedExchangeAdd64((__int64 *)(_v), (__int64) (_i)) + (__int64) (_i) : \\",
                        ],
                    ];

                await $`sd -s -- ${shimOld} ${""} src/util/u_atomic.h`.cwd(path);
                for (const [from, to] of addLines) {
                    await $`sd -s -- ${from} ${to} src/util/u_atomic.h`.cwd(path);
                }

                const preArgsOld = `'-DPACKAGE_BUGREPORT="https://gitlab.freedesktop.org/mesa/mesa/-/issues"',`,
                    preArgsNew = `${preArgsOld}\n  '-D_USE_MATH_DEFINES',`;

                await $`sd -s -- ${preArgsOld} ${preArgsNew} meson.build`.cwd(path);
            }

            await $`sd -s -- ${"if not with_glvnd and host_machine.system() != 'windows'"} ${"if not with_glvnd"} include/meson.build`.cwd(
                path,
            );
        },
    },
    */
    {
        name: "libultrahdr",
        source: { git: "https://github.com/google/libultrahdr", tag: "v2.0.2" },
        profile: { rtti: true },
        msys2: "libultrahdr",
        args: () =>
            `-DUHDR_BUILD_EXAMPLES=OFF -DUHDR_ENABLE_INTRINSICS=ON -DUHDR_ENABLE_GLES=OFF -DUHDR_ENABLE_HEIF=OFF`,
        prepare: async ({ path }) => {
            const lists = `${path}/CMakeLists.txt`;
            replaceInFile(lists, "if(MSVC AND NOT BUILD_SHARED_LIBS)", "if((MSVC OR WIN32) AND NOT BUILD_SHARED_LIBS)");
            replaceInFile(lists, "if(BUILD_SHARED_LIBS AND NOT MSVC)", "if(BUILD_SHARED_LIBS AND NOT (MSVC OR WIN32))");
            replaceInFile(
                lists,
                "combine_static_libs(${UHDR_CORE_LIB_NAME} ${UHDR_TARGET_NAME_STATIC})\n  if(NOT MSVC)",
                "combine_static_libs(${UHDR_CORE_LIB_NAME} ${UHDR_TARGET_NAME_STATIC})\n  if(NOT (MSVC OR WIN32))",
            );
            replaceInFile(lists, "$<$<CONFIG:Debug>:Debug>", "");
        },
    },

    {
        name: "ffmpeg",
        source: { git: "https://github.com/FFmpeg/FFmpeg", tag: "n9.1" },
        profile: { asan: true, debugOpt: false },
        variants: () => [...settings.ffmpegVariants].sort().join(","),
        prepare: async ({ msvc, path }) => {
            // Upstream 9.0 treats any lld-link "ignoring unknown argument" warning as a hard failure
            replaceInFile(
                `${path}/configure`,
                `test $ret -eq 0 && ! echo "$output" | grep -qE 'LNK4044|lld-link: warning: ignoring unknown argument'`,
                "test $ret -eq 0",
            );

            // With -flto=full the C reference becomes an undefined external in the bitcode
            appendFileSync(`${path}/libavcodec/x86/Makefile`, "\n$(SUBDIR)x86/mlpdsp_init.o: CFLAGS += -fno-lto\n");

            if (msvc) {
                replaceInFile(`${path}/compat/windows/makedef`, "$AR rcs", "llvm-ar rcs");
                await $`sd ${"SLIB_INSTALL_EXTRA_SHLIB='$(SLIBNAME:$(SLIBSUF)=.lib)'"} ${`SLIB_INSTALL_EXTRA_SHLIB='$(SLIBNAME:$(SLIBSUF)=.lib)$(SLIBNAME_WITH_MAJOR:$(SLIBSUF)=.pdb)'`} configure`.cwd(
                    path,
                );
                replaceInFile(
                    `${path}/configure`,
                    "SLIB_INSTALL_EXTRA_LIB='$(SLIBNAME_WITH_MAJOR:$(SLIBSUF)=.def)'",
                    "SLIB_INSTALL_EXTRA_LIB='$(SLIBNAME:$(SLIBSUF)=.lib)'",
                );
            }
        },
        build: async ({ isDebug, msvc, path, root, step }) => {
            const { AR, CC, CFLAGS, CXX, CXXFLAGS, LDFLAGS, RANLIB, STRIP, WINDRES } = process.env;

            const targetOs = msvc ? "win64" : "mingw32",
                msvcToolchain = msvc ? "--toolchain=msvc" : "",
                common = `--target-os=${targetOs} --arch=x86_64 --cpu=x86-64-v3 ${msvcToolchain} --stdc=gnu17 --stdcxx=gnu++23 --cc=${CC} --cxx=${CXX} --ar=${AR} --strip=${STRIP} --ld=${CC} --ranlib=${RANLIB} --windres=${WINDRES} --disable-autodetect --disable-all --enable-asm --enable-protocol=file --enable-avformat --enable-avcodec --enable-avfilter --enable-swscale --enable-swresample --extra-cflags="${CFLAGS}" --extra-ldflags="${LDFLAGS}" --extra-cxxflags="${CXXFLAGS}" --optflags="${CFLAGS}"`,
                buildType = isDebug
                    ? "--disable-optimizations --enable-debug --disable-stripping"
                    : "--enable-optimizations --disable-debug --enable-stripping";

            for (const [variant, config] of Object.entries(FFMPEG_VARIANTS)) {
                if (!settings.ffmpegVariants.includes(variant)) {
                    continue;
                }
                await step(`ffmpeg-${variant}`, async () => {
                    await bash`cd ${toMsysPath(path)} && make clean`.noThrow();
                    await buildAutoconf(path, isDebug, `${root}/ffmpeg-${variant}`, {
                        args: `${common} ${buildType} ${ffmpegCodecArgs(config)}`,
                        libs: false,
                        libtool: false,
                    });
                });
            }
        },
    },
    {
        name: "imagemagick",
        source: { git: "https://github.com/imagemagick/imagemagick", tag: "7.1.2-36" },
        profile: { asan: true, debugOpt: false },
        variants: () => settings.magickVariants.map(magickSuffix).sort().join(","),
        prepare: async ({ msvc, path }) => {
            // Swaps GPL FFTW3 for BSD-licensed PocketFFT
            await applyPatch(path, "imagemagick-fourier-pocketfft.patch");

            if (msvc) {
                replaceInFile(`${path}/configure`, "GOMP_LIBS=''", "GOMP_LIBS=' '");

                replaceInFile(
                    `${path}/configure`,
                    "echo /'*' $ac_prefix_conf_OUT. Generated automatically at end of configure. '*'/ >>$tmp/pconfig.h",
                    "echo /'*' $ac_prefix_conf_OUT. Generated automatically at end of configure. '*'/ >>$tmp/pconfig.h\n    echo 'typedef __int64 ssize_t;' >>$tmp/pconfig.h",
                );
            }
        },
        build: async ({ isDebug, path, root, step }) => {
            await $`cp ${`${ROOT}/patches/imagemagick/pocketfft.c`} MagickCore/pocketfft.c`.cwd(path);
            await $`cp ${`${ROOT}/patches/imagemagick/pocketfft.h`} MagickCore/pocketfft.h`.cwd(path);

            for (const variant of settings.magickVariants) {
                const { depth, hdri } = variant,
                    hdr = hdri ? "enable" : "disable",
                    profiled = magickSuffix(variant) === magickSuffix(MAGICK_PGO_VARIANT);
                if (!profiled && settings.libsPgo === "gen") {
                    continue;
                }
                const args = `--disable-dependency-tracking --disable-legacy-support ${isDebug ? "--enable-assert" : "--disable-assert"} --enable-openmp --enable-opencl --with-threads --with-quantum-depth=${depth} --without-modules --without-utilities --disable-docs --${hdr}-hdri --disable-deprecated --without-perl --with-ltdl --with-bzlib --without-fftw --with-freetype --with-heic --without-jbig --with-jpeg --with-jxl --with-lcms --with-lzma --with-openexr --with-openjp2 --with-png --with-raw --with-tiff --with-webp --with-xml --with-zip --with-zlib --with-zstd --without-autotrace --without-djvu --without-dps --without-flif --without-fpx --without-fontconfig --without-gslib --without-gvc --without-dmr --without-lqr --without-pango --without-raqm --without-rsvg --with-uhdr --without-wmf --without-x --without-gdi32`;
                const buildVariant = () => buildAutoconf(path, isDebug, root, { args });
                await step(`q${depth}-${hdr}-hdri`, async () => {
                    if (profiled || settings.libsPgo !== "use") {
                        await buildVariant();
                    } else {
                        await withoutLibsProfile(buildVariant);
                    }
                });
            }
        },
        finish: async ({ isDebug, msvc, path, root }) => {
            await $`rm -f ${root}/bin/MagickCore-config ${root}/bin/MagickWand-config ${root}/bin/Magick++-config`;
            if (isDebug && msvc) {
                movePdbs(`${path}/MagickCore/.libs`, `${root}/bin`);
                movePdbs(`${path}/MagickWand/.libs`, `${root}/bin`);
                movePdbs(`${path}/Magick++/lib/.libs`, `${root}/bin`);

                for (const suffix of settings.magickVariants.map(magickSuffix)) {
                    for (const lib of ["Magick++", "MagickCore", "MagickWand"]) {
                        await copyLib(root, `${lib}-7.${suffix}.dll.lib`, `${lib}-7.${suffix}.lib`);
                    }
                }
            }
        },
    },
    {
        name: "qt5",
        source: { git: "https://github.com/qt/qt5", tag: "v6.12.0" },
        archPkg: "qt6-base",
        profile: { asan: true, debugOpt: false, rtti: true },
        build: async ({ isDebug, msvc, path }) => {
            const submodules = ["qtbase", "qtimageformats", "qttools", "qtsvg"],
                qpa = "windows",
                reduceExports = msvc ? "" : "-reduce-exports",
                ssl = "-ssl -schannel -no-openssl",
                graphics = "-opengl desktop -no-egl",
                winStyles = "-feature-style-windows -feature-style-windows11 -feature-style-windowsvista",
                common = `-no-guess-compiler -cmake-generator Ninja -c++std c++23 -gui -widgets -submodules ${submodules.join(",")} -pch -qpa "${qpa}" ${reduceExports} -disable-deprecated-up-to 0x060213 -nomake tests -nomake examples -nomake benchmarks -nomake manual-tests -nomake minimal-static-tests -nomake doc-snippets  -no-emojisegmenter -no-appstore-compliant -no-sbom -no-sbom-json -no-sbom-verify -no-system-proxies -no-mimetype-database -no-icu -no-gif -no-dbus ${ssl} -no-libb2 -system-harfbuzz -system-freetype -system-libpng -system-libjpeg -system-webp -system-zlib -system-doubleconversion -system-pcre -system-libmd4c -no-tiff -no-jasper -no-mng -no-zstd ${graphics}`,
                featureToggles = `-feature-accessibility -feature-animation -feature-calendarwidget -feature-cborstreamreader -feature-cborstreamwriter -feature-datetimeedit -feature-datetimeparser -feature-designer -feature-dom -feature-draganddrop -feature-imageformat_jpeg -feature-imageformat_png -feature-imageformat_xpm -no-feature-linguist -feature-rubberband -feature-style-stylesheet ${winStyles} -feature-texthtmlparser -feature-textmarkdownreader -feature-wizard -no-feature-androiddeployqt -no-feature-appstore-compliant -no-feature-assistant -no-feature-brotli -no-feature-distancefieldgenerator -no-feature-dnslookup -no-feature-dtls -no-feature-effects -no-feature-emojisegmenter -no-feature-fullqthelp -no-feature-gestures -no-feature-gssapi -no-feature-hijricalendar -no-feature-imageformat_bmp -no-feature-imageformat_ppm -no-feature-imageformat_xbm -no-feature-islamiccivilcalendar -no-feature-jalalicalendar -no-feature-kmap2qmap -no-feature-macdeployqt -no-feature-harmonydeployqt -no-feature-movie -no-feature-ocsp -no-feature-openssl-hash -no-feature-pdf -no-feature-pixeltool -no-feature-printsupport -no-feature-qdbus -no-feature-qdoc -no-feature-qdoc_coverage -no-feature-qmake -no-feature-qtattributionsscanner -no-feature-qtdiag -no-feature-qtplugininfo -no-feature-sessionmanager -no-feature-socks5 -no-feature-splashscreen -no-feature-sql -no-feature-sspi -no-feature-tabletevent -feature-testlib -no-feature-textmarkdownwriter -no-feature-textodfwriter -no-feature-timezone -no-feature-timezone_locale -no-feature-timezone_tzdb -no-feature-topleveldomain -no-feature-tuiotouch -no-feature-udpsocket -no-feature-wasm-exceptions -no-feature-wasm-jspi -no-feature-wasm-simd128 -no-feature-wasmdeployqt -no-feature-windeployqt -no-feature-vulkan`;

            await $`git submodule update --init --depth 1 ${submodules}`.cwd(path);
            await $`git submodule update --init --recursive --depth 1`.cwd(`${path}/qttools`);
            await applyPatch(`${path}/qtbase`, "qtbase-drop-unused-tools.patch");

            if (isDebug && msvc) {
                replaceInFile(
                    `${path}/qtbase/src/corelib/CMakeLists.txt`,
                    "add_dependencies(Core qmodule_pri)",
                    `add_dependencies(Core qmodule_pri)\ntarget_link_options(Core PRIVATE "-Wl,-FORCE:UNRESOLVED")`,
                );
            }

            const dir = buildDir(isDebug),
                linkage = isDebug ? "-sanitize address -no-static -no-static-runtime" : "-static -static-runtime";
            await $`./configure.bat ${raw(common)} -${dir} ${raw(linkage)} ${raw(featureToggles)} -- -B=${dir} -DCMAKE_TOOLCHAIN_FILE=${`${TOOLCHAINS_DIR}/${dir}.cmake`} -DQT_USE_DEFAULT_CMAKE_OPTIMIZATION_FLAGS=ON`.cwd(
                path,
            );
            await $`cmake --build ${dir} -j`.cwd(path);
            await $`cmake --install ${dir}`.cwd(path);
        },
    },
    {
        name: "upx",
        source: { git: "https://github.com/upx/upx", tag: "devel" },
        releaseOnly: true,
        profile: { march: "znver1", mtune: "znver1", rtti: true },
        prepare: async ({ path }) => {
            await applyPatch(path, "upx-install.patch");
            await $`git submodule update --depth 1 --init --recursive`.cwd(path);
        },
    },
    ruby("ruby-1.8.1", "https://cache.ruby-lang.org/pub/ruby/1.8/ruby-1.8.1.tar.gz", "1.8.1"),
    ruby("ruby-1.8.7", "https://cache.ruby-lang.org/pub/ruby/1.8/ruby-1.8.7-p374.tar.gz", "1.8.7-p374"),
    ruby("ruby-1.9.3", "https://cache.ruby-lang.org/pub/ruby/1.9/ruby-1.9.3-p551.tar.gz", "1.9.3-p551"),
    ruby("ruby-1.9.2", "https://cache.ruby-lang.org/pub/ruby/1.9/ruby-1.9.2-p330.tar.gz", "1.9.2-p330"),

    llvmProject,
    llvmRuntimes,
];

export function getPin(library: Library): string {
    return "git" in library.source ? library.source.tag : library.source.archive;
}

export function shouldBuildLibrary(name: string): boolean {
    const key = name.toLowerCase();
    if (settings.only && !settings.only.has(key)) {
        return false;
    }
    return !settings.exclude.has(key);
}
