import consola from "consola";
import $ from "dax";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, cp, readdir, rm, writeFile } from "node:fs/promises";
import pc from "picocolors";

import { buildAutoconf, buildPlain, cmakeVal, copyLib, movePdbs, stripDllImport } from "./builders.ts";
import { profileHash, trainLlvm } from "./pgo.ts";
import {
    buildRoot,
    DEBUG_TOOLCHAIN,
    ICU_DATA_FILTERS,
    LLVM_MINGW_I686,
    LLVM_TABLEGEN_DIR,
    llvmPgo,
    magickSuffix,
    MSYS2_ROOT,
    RELEASE_TOOLCHAIN,
    ROOT,
    settings,
    WIN,
} from "./settings.ts";
import { bash, raw, toMsysPath } from "./shell.ts";
import type { Library } from "./types.ts";

// Tests are most of the checkout (llvm/test alone is 1.1 GB) and the builds turn them and the docs off.
const LLVM_UNUSED_DIRS = [
    "llvm/docs",
    "clang/docs",
    "clang-tools-extra/docs",
    "lld/docs",
    "lldb/docs",
    "llvm/test",
    "llvm/unittests",
    "clang/test",
    "clang/unittests",
    "clang-tools-extra/test",
    "clang-tools-extra/unittests",
    "lld/test",
    "lld/unittests",
    "lldb/test",
    "lldb/unittests",
];

/** Deletes everything of the checkout but `keep` (top-level directories), the tests and the docs. Runs in prepare, after the `git reset --hard` that restores them. */
async function pruneLlvmSources(path: string, keep: string[]): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== ".git" && !keep.includes(entry.name)) {
            await rm(`${path}/${entry.name}`, { force: true, recursive: true });
        }
    }
    await Promise.all(LLVM_UNUSED_DIRS.map((dir) => rm(`${path}/${dir}`, { force: true, recursive: true })));
}

// A patch that no longer applies (the source moved on) warns and the build continues, instead of throwing.
async function applyPatch(path: string, patch: string): Promise<void> {
    try {
        await $`git apply ${`${ROOT}/patches/${patch}`}`.cwd(path);
    } catch (error) {
        consola.warn(
            pc.yellow(
                `Patch ${patch} did not apply in ${path}: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
    }
}

// FFmpeg variants (--ffmpeg-variants), each installed to `${prefix}/ffmpeg-<name>`. `consumers` are the
// [CMake PROJECT_NAME, cache variable] pairs that the generated ffmpeg-root-*.cmake points at the variant.
export const FFMPEG_VARIANTS: Record<string, { codecs: string; consumers: [string, string][] }> = {
    rap: {
        codecs: "--enable-decoder=aac,ac3,alac,dca,eac3,flac,mp3float,opus,pcm_f32be,pcm_f32le,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_u8,truehd,vorbis --enable-demuxer=aac,ac3,aiff,avi,caf,dts,eac3,flac,matroska,mov,mp3,ogg,truehd,wav --enable-parser=aac,ac3,dca,flac,mlp,mpegaudio,opus,vorbis --enable-filter=aformat,alimiter,aresample,firequalizer",
        consumers: [["rap", "RAP_FFMPEG_ROOT"]],
    },
    trap: {
        codecs: "--enable-decoder=aac,alac,flac,mp3float,opus,pcm_f32le,pcm_s16le,pcm_s24le,pcm_s32le,pcm_u8,vorbis --enable-demuxer=aac,aiff,avi,flac,matroska,mov,mp3,ogg,wav --enable-parser=aac,flac,mpegaudio,opus,vorbis --enable-filter=aformat,alimiter,aresample,firequalizer",
        consumers: [["rap", "TRAP_FFMPEG_ROOT"]],
    },
    rpgmtranslate: {
        codecs: "--enable-demuxer=asf,avi,flac,matroska,mov,mp3,mpegps,ogg,wav --enable-decoder=aac,adpcm_ima_wav,adpcm_ms,flac,h264,mjpeg,mp2float,mp3float,mpeg1video,mpeg2video,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,opus,pcm_f32be,pcm_f32le,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_u8,pcm_s8,pcm_mulaw,pcm_alaw,pcm_dvd,theora,vc1,vorbis,vp8,vp9,wmav1,wmav2,wmv1,wmv2,wmv3 --enable-parser=h264,mpeg4video,mpegvideo,vc1",
        consumers: [["rpgmtranslate", "FFMPEG_ROOT"]],
    },
    vu: {
        codecs: "--enable-libdav1d --enable-zlib --enable-decoder=libdav1d,h264,hevc,vp8,vp9,mpeg4,theora,gif,apng,webp,webp_anim --enable-demuxer=matroska,mov,avi,ogg,gif,apng,webp,webp_anim --enable-parser=av1,h264,hevc,vp8,vp9,mpeg4video,gif,png",
        consumers: [["vu", "FFMPEG_ROOT"]],
    },
};

export const MSYS2_EXTRA = ["mesa", "imagemagick"];

const LLVM_MARCH = "znver1",
    LLVM_TAG = "llvmorg-23.1.6",
    LLVM_MAJOR = LLVM_TAG.replace(/^llvmorg-/, "").split(".")[0]!;

// The binaries. The runtimes (compiler-rt, libc++, libc++abi, libunwind) are the separate llvm-runtimes library.
const LLVM_DIST_COMPONENTS = [
    "clang",
    "clang-format",
    "clang-resource-headers",
    "clang-scan-deps",
    "clang-tidy",
    "clangd",
    "liblldb",
    "lld",
    "lldb",
    "llvm-ar",
    "llvm-cov",
    "llvm-dlltool",
    "llvm-objcopy",
    "llvm-objdump",
    "llvm-profdata",
    "llvm-ranlib",
    "llvm-rc",
    "llvm-strip",
    "llvm-symbolizer",
    "llvm-windres",
].join(";");

const llvmArgs = (tablegenBin = "") =>
    `-DLLVM_ENABLE_LIBCXX=ON -DLLVM_PARALLEL_LINK_JOBS=2 -DLLVM_TARGETS_TO_BUILD=X86 -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra;lld;lldb" -DCLANG_DEFAULT_CXX_STDLIB=libc++ -DCLANG_DEFAULT_RTLIB=compiler-rt -DCLANG_DEFAULT_UNWINDLIB=libunwind -DLLVM_ENABLE_RPMALLOC=ON -DLLVM_ENABLE_ASSERTIONS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_DOCS=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_ENABLE_BINDINGS=OFF -DCLANG_TOOLS_EXTRA_INCLUDE_DOCS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF -DCLANG_INCLUDE_TESTS=OFF -DCLANG_TOOLS_EXTRA_INCLUDE_TESTS=OFF -DLLDB_INCLUDE_TESTS=OFF -DCLANG_BUILD_EXAMPLES=OFF -DCLANG_INCLUDE_DOCS=OFF -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_ENABLE_OBJC_REWRITER=OFF -DZLIB_LIBRARY=${MSYS2_ROOT}/clang64/lib/libz.a -DZLIB_INCLUDE_DIR=${MSYS2_ROOT}/clang64/include -DLLVM_USE_STATIC_LIBXML2=ON -DLibXml2_USE_STATIC_LIBS=ON -DLIBXML2_DEFINITIONS=-DLIBXML_STATIC -DLLVM_NATIVE_TOOL_DIR=${tablegenBin} -DLLVM_DISTRIBUTION_COMPONENTS="${LLVM_DIST_COMPONENTS}"${llvmPgo() && existsSync(settings.llvmProfdata) ? ` -DLLVM_PROFDATA_FILE=${settings.llvmProfdata}` : ""}`;

// The host TableGen tools only run inside the build, so they're built here without -flto=full and reach the main build through LLVM_NATIVE_TOOL_DIR.
const LLVM_TABLEGEN_BIN = `${LLVM_TABLEGEN_DIR}/bin`,
    LLVM_TABLEGEN_TOOLS = ["llvm-tblgen", "llvm-min-tblgen", "clang-tblgen", "lldb-tblgen", "clang-tidy-confusable-chars-gen"];

async function buildLlvmTablegen(llvmPath: string) {
    // -DCMAKE_C_FLAGS=/CXX_FLAGS= clear the CFLAGS env var, which may still hold the previous library's -flto=full (see prepare in pgo.ts).
    await $`cmake -G Ninja -S ${llvmPath}/llvm -B ${LLVM_TABLEGEN_DIR} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS= -DCMAKE_CXX_FLAGS= ${raw(llvmArgs())} -DLLVM_ENABLE_PROJECTS=${"clang;clang-tools-extra;lldb"} -DLLVM_ENABLE_RUNTIMES= -DLLVM_DISTRIBUTION_COMPONENTS=`.env({
        ...process.env,
        LLVM_DEPS_PREFIX: `${MSYS2_ROOT}/clang64`,
        PKG_CONFIG_PATH: `${MSYS2_ROOT}/clang64/lib/pkgconfig;${MSYS2_ROOT}/clang64/share/pkgconfig`,
    });
    await $`ninja ${LLVM_TABLEGEN_TOOLS}`.cwd(LLVM_TABLEGEN_DIR);
}

const LIBLTDL_MSVC_CONFIG = `#define HAVE_DECL_CYGWIN_CONV_PATH 0
#define HAVE_INTTYPES_H 1
#define HAVE_LIBDLLOADER 1
#define HAVE_PRELOADED_SYMBOLS 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define LTDL_DLOPEN_DEPLIBS 1
#define LT_DLSEARCH_PATH "/lib:/usr/lib"
#define LT_LIBEXT "lib"
#define LT_LIBPREFIX "lib"
#define LT_MODULE_EXT ".dll"
#define LT_MODULE_PATH_VAR "PATH"
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
#define __error_t_defined 1
#define error_t int`;
const LIBLTDL_MINGW_CONFIG = `
#define HAVE_CLOSEDIR 1
#define HAVE_DECL_CYGWIN_CONV_PATH 0
#define HAVE_DIRENT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIBDLLOADER 1
#define HAVE_OPENDIR 1
#define HAVE_PRELOADED_SYMBOLS 1
#define HAVE_READDIR 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define LTDL_DLOPEN_DEPLIBS 1
#define LT_DLSEARCH_PATH "/lib:/usr/lib"
#define LT_LIBEXT "lib"
#define LT_LIBPREFIX "lib"
#define LT_MODULE_EXT ".dll"
#define LT_MODULE_PATH_VAR "PATH"
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
#define __error_t_defined 1
#define error_t int`;
const LIBLTDL_LINUX_CONFIG = `
#define HAVE_ARGZ_H 1
#define HAVE_CLOSEDIR 1
#define HAVE_DIRENT_H 1
#define HAVE_DLFCN_H 1
#define HAVE_DLERROR 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIBDL 1
#define HAVE_OPENDIR 1
#define HAVE_PRELOADED_SYMBOLS 1
#define HAVE_READDIR 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define LT_DLSEARCH_PATH "/lib:/usr/lib"
#define LT_LIBEXT "so"
#define LT_LIBPREFIX "lib"
#define LT_MODULE_EXT ".so"
#define LT_MODULE_PATH_VAR "LD_LIBRARY_PATH"
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

const LLVM_RUNTIMES_ARGS = `-DLLVM_ENABLE_RUNTIMES="compiler-rt;libcxx;libcxxabi;libunwind;openmp" -DLLVM_INCLUDE_TESTS=OFF -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXX_ENABLE_STATIC=ON -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_STATIC=ON -DLIBUNWIND_ENABLE_SHARED=OFF -DLIBUNWIND_ENABLE_STATIC=ON -DLIBOMP_ENABLE_SHARED=OFF -DCOMPILER_RT_BUILD_SANITIZERS=ON -DCOMPILER_RT_BUILD_PROFILE=ON -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON -DCOMPILER_RT_USE_BUILTINS_LIBRARY=ON -DSANITIZER_CXX_ABI=libc++ -DCMAKE_C_COMPILER_TARGET=x86_64-w64-windows-gnu -DCMAKE_CXX_COMPILER_TARGET=x86_64-w64-windows-gnu`;

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
            await $`sd -s -- "!defined(MI_NO_CXX_NEW_HANDLER)" "fal" src/alloc/alloc.c`.cwd(path);
        },
    },
    {
        // Only libltdl, compiled directly with a hand-written config.h.
        name: "libtool",
        source: { git: "https://github.com/autotools-mirror/libtool", tag: "v2.6.2" },
        profile: { pgo: false },
        msys2: "libtool",
        prepare: async ({ path }) => {
            if (WIN) {
                await $`sd -s -- "extern LT_DLSYM_CONST lt_dlsymlist preloaded_symbols[]" "extern LT_DLSYM_CONST lt_dlsymlist* preloaded_symbols = NULL" libltdl/ltdl.c`.cwd(
                    path,
                );
                await $`sd -s -- "LT_SCOPE const lt_dlvtable *	get_vtable (lt_user_data data);" "LT_SCOPE const lt_dlvtable *	get_vtable (lt_user_data data);\nLT_SCOPE const lt_dlvtable *	loadlibrary_LTX_get_vtable (lt_user_data data);" libltdl/ltdl.c`.cwd(
                    path,
                );
                await $`sd -s -- "errors += loader_init (get_vtable, 0);" "errors += loader_init (get_vtable, 0);\nerrors += loader_init (loadlibrary_LTX_get_vtable, 0);" libltdl/ltdl.c`.cwd(
                    path,
                );
                await $`sd -s -- "errors += lt_dlpreload_open (LT_STR(LTDLOPEN), loader_init_callback);" "" libltdl/ltdl.c`.cwd(
                    path,
                );
            }
        },
        build: async ({ isDebug, msvc, path }) => {
            const p = `${path}/libltdl`;

            await cp(`${p}/libltdl/lt__argz_.h`, `${p}/lt__argz.h`);
            await writeFile(
                `${p}/config.h`,
                WIN ? (msvc ? LIBLTDL_MSVC_CONFIG : LIBLTDL_MINGW_CONFIG) : LIBLTDL_LINUX_CONFIG,
            );

            await buildPlain(p, isDebug, {
                defines: ["HAVE_CONFIG_H", "LTDL", isDebug ? "DLL_EXPORT" : "LTDL", "LT_DEBUG_LOADERS"],
                headers: [
                    { dest: "ltdl.h", src: "ltdl.h" },
                    { dest: "libltdl/lt_dlloader.h", src: "libltdl/lt_dlloader.h" },
                    { dest: "libltdl/lt_error.h", src: "libltdl/lt_error.h" },
                    { dest: "libltdl/lt_system.h", src: "libltdl/lt_system.h" },
                ],
                includeDirs: ["./", "./libltdl", "./loaders"],
                libName: "libltdl.a",
                sources: [
                    "ltdl.c",
                    "lt_error.c",
                    "lt_dlloader.c",
                    "lt__alloc.c",
                    "lt__strl.c",
                    "lt__argz.c",
                    msvc ? "lt__dirent.c" : "",
                    "slist.c",
                    "loaders/preopen.c",
                    WIN ? "loaders/loadlibrary.c" : "loaders/dlopen.c",
                ],
            });
        },
        finish: async ({ isDebug, root }) => {
            if (WIN && isDebug) {
                await $`sd -s -- "defined LIBLTDL_DLL_IMPORT" "1" ${`${root}/include/libltdl/lt_system.h`}`;
            }
        },
    },
    {
        name: "bzip2",
        source: { git: "https://sourceware.org/git/bzip2", tag: "bzip2-1.0.8" },
        version: "1.0.8",
        msys2: "bzip2",
        prepare: async ({ path }) => {
            await $`sd "DESCRIPTION.+" "" libbz2.def`.cwd(path);
            // LIBRARY sets the DLL name recorded in the import lib; upstream's LIBBZ2 makes consumers load LIBBZ2.dll.
            await $`sd "LIBRARY.+" "LIBRARY bz2" libbz2.def`.cwd(path);
        },
        build: async ({ isDebug, path }) => {
            await buildPlain(path, isDebug, {
                defFile: "libbz2.def",
                headers: [{ dest: "bzlib.h", src: "bzlib.h" }],
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
            await $`sd -s "if(BUILD_SHARED_LIBS AND MSVC)" "if(BUILD_SHARED_LIBS AND (MSVC OR (CMAKE_CXX_SIMULATE_ID STREQUAL "MSVC")))" CMakeLists.txt`.cwd(
                path,
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
            await $`sd -s -- "set(NOLTOFLAG \${ZNOLTOFLAG})" "" CMakeLists.txt`.cwd(path);
        },
        finish: async ({ isDebug, msvc, root }) => {
            if (WIN && isDebug) {
                await (msvc ? copyLib(root, "zlib.lib", "z.lib") : copyLib(root, "libzlib.dll.a", "libz.dll.a"));
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
        // HWY_COMPILE_ONLY_STATIC: no runtime dispatch; the x86-64-v3 baseline (AVX2) is the only target
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
                await $`sd -s -- "if(NOT MSVC AND NOT CYGWIN)" "if (NOT (MSVC OR (CMAKE_C_SIMULATE_ID STREQUAL "MSVC")) AND NOT CYGWIN)" CMakeLists.txt`.cwd(
                    path,
                );
            }
        },
        finish: async ({ isDebug, root }) => {
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/lzma.h`);
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
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/libdeflate.h`);
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
                if (WIN) {
                    await stripDllImport(`${root}/include/pcre2.h`);
                    await $`sd -s -- "STATIC IMPORTED" "STATIC IMPORTED GLOBAL" ${`${root}/lib/cmake/pcre2/pcre2-targets.cmake`}`;
                }
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
            if (WIN && !isDebug && msvc) {
                await stripDllImport(`${root}/include/openjpeg-2.5/openjpeg.h`);
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
            if (WIN && !msvc && isDebug) {
                await $`sd -s "/// @cond Doxygen_Suppress" "/*" ${`${root}/include/Imath/ImathVec.h`}`;
                await $`sd -s "/// @endcond Doxygen_Suppress" "*/" ${`${root}/include/Imath/ImathVec.h`}`;
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
            if (WIN && !isDebug && msvc) {
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
            if (WIN && !isDebug && msvc) {
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
            if (WIN) {
                if (msvc) {
                    await applyPatch(path, "kvazaar-cmakelists.patch");
                } else {
                    await $`sd -s -- "-Wa,-muse-unaligned-vector-move" "" CMakeLists.txt`.cwd(path);
                }
            }
        },
        finish: async ({ isDebug, root }) => {
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/kvazaar.h`);
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
        // Autotools build of icu4c, with the data trimmed by patches/filters.json.
        name: "icu",
        source: { git: "https://github.com/unicode-org/icu", tag: "release-79.1" },
        profile: { rtti: true },
        msys2: "icu",
        prepare: async ({ msvc, path }) => {
            await $`sd -s -- "STATIC_PREFIX_WHEN_USED = s" "STATIC_PREFIX_WHEN_USED =" "icu4c/source/icudefs.mk.in"`.cwd(
                path,
            );
            await $`sd -s -- "STATIC_PREFIX = s" "STATIC_PREFIX =" "icu4c/source/icudefs.mk.in"`.cwd(path);

            await $`sd -s -- "OUTPUTFILE=icupkg.inc" "OUTPUTFILE=icupkg.inc\nCFLAGS += -fno-lto\nCXXFLAGS += -fno-lto\nLDFLAGSICUDT += -fno-lto" ${`${path}/icu4c/source/data/pkgdataMakefile.in`}`;

            // Builds may go to another device, avoid symlinks
            for (const dir of [".", "common", "i18n", "io", "stubdata", "tools/toolutil"]) {
                await $`sd -s -- "ln -s" "cp -rf" Makefile.in`.cwd(`${path}/icu4c/source/${dir}`);
            }
            await $`sd -s -- '#define LN_CMD "ln -s"' '#define LN_CMD "cp -f"' icu4c/source/tools/pkgdata/pkgdata.cpp`.cwd(
                path,
            );

            if (msvc) {
                await applyPatch(path, "plurrule.patch");
                await $`cp ${`${ROOT}/patches/mh-cygwin-clang-msvc.txt`} icu4c/source/config/mh-cygwin-msvc`.cwd(path);
                await $`sd -s "LIB.exe /nologo /out:" "llvm-ar qc " icu4c/source/tools/pkgdata/pkgdata.cpp`.cwd(path);
                await $`sd -s "link.exe" "lld-link" icu4c/source/tools/pkgdata/pkgdata.cpp`.cwd(path);
                await $`sd -s "rc.exe" "llvm-rc" icu4c/source/data/makedata.mak`.cwd(path);
                await $`sd -s "rc.exe" "llvm-rc" icu4c/source/data/Makefile.in`.cwd(path);
            }
        },
        build: async ({ isDebug, msvc, path, root }) => {
            const sourceDir = `${path}/icu4c/source`;
            await writeFile(`${sourceDir}/filters.json`, ICU_DATA_FILTERS);
            const common = `--enable-option-checking --disable-tests --disable-samples --enable-tools --disable-icu-config --disable-extras --disable-icuio --disable-layout --disable-layoutex --disable-dyload --disable-fuzzer --disable-tracing --disable-plugins --disable-draft --with-library-suffix=""`;

            await buildAutoconf(sourceDir, isDebug, root, {
                args: `${common} --with-data-packaging=${isDebug ? "library" : "static"}`,
                configure: `./runConfigureICU ${WIN ? (msvc ? "Cygwin" : "MinGW") : "Linux/clang"}`,
                env: `ICU_DATA_FILTER_FILE=filters.json CPPFLAGS="-DUCONFIG_NO_COLLATION=ON -DUCONFIG_NO_FORMATTING=ON -DUCONFIG_NO_TRANSLITERATION=ON -DUCONFIG_NO_REGULAR_EXPRESSIONS=ON -DUCONFIG_NO_SERVICE=ON -DUCONFIG_NO_IDNA=ON -DUCONFIG_NO_CONVERSION=OFF -DUCONFIG_NO_LEGACY_CONVERSION=OFF -DUCONFIG_NO_NORMALIZATION=OFF"`,
                libtool: false,
                makeEnv: msvc ? `MSYS2_ARG_CONV_EXCL="*"` : "",
            });
        },
        finish: async ({ isDebug, msvc, path, root }) => {
            if (!WIN) {
                return;
            }

            if (msvc) {
                if (isDebug) {
                    await movePdbs(`${path}/icu4c/source/bin`, `${root}/bin`);
                    await movePdbs(`${path}/icu4c/source/lib`, `${root}/bin`);
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
                await stripDllImport(`${root}/include/unicode/platform.h`);
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
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/libde265/de265.h`);
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
            await $`sd -s -- "find_dependency(ZLIB REQUIRED)" "include(CMakeFindDependencyMacro)\nfind_dependency(ZLIB REQUIRED)" ${`${root}/lib/cmake/spng/SPNGConfig.cmake`}`;
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
            if (WIN && !isDebug && !msvc) {
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
                await $`sd -s "if(NOT CMAKE_HOST_WIN32 OR CYGWIN OR MINGW)" "if(CMAKE_HOST_WIN32 OR CYGWIN OR MINGW)" CMakeLists.txt`.cwd(
                    path,
                );
                await $`sd -s "if(NOT WIN32 OR CYGWIN OR MINGW)" "if(WIN32 OR CYGWIN OR MINGW)" CMakeLists.txt`.cwd(
                    path,
                );
            }

            // Causes fail in CI for some reason
            await $`sd -s -- "#  error The include path of <zlib.h> is incorrect" "" pngpriv.h`.cwd(path);
        },
        finish: async ({ isDebug, msvc, root }) => {
            if (!WIN) {
                return;
            }

            if (isDebug) {
                await (msvc
                    ? copyLib(root, "libpng16.lib", "png16.lib")
                    : copyLib(root, "libpng16.dll.a", "libpng.dll.a"));
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
            await appendFile(
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
            if (!WIN) {
                await $`chmod +x configure`.cwd(path);
            }

            await buildAutoconf(path, isDebug, root, {
                args: `--enable-openmp --enable-jpeg --enable-zlib --enable-lcms --disable-examples`,
                env: `CPPFLAGS="${isDebug ? "-DLIBRAW_BUILDLIB" : "-DLIBRAW_NODLL"}"`,
            });
        },
        finish: async ({ isDebug, msvc, path, root }) => {
            if (isDebug && msvc) {
                await movePdbs(`${path}/lib/.libs`, `${root}/bin`);
                await copyLib(root, "raw.dll.lib", "raw.lib");
                await copyLib(root, "raw_r.dll.lib", "raw_r.lib");
            }

            await $`sd -s -- "-lstdc++" "" ${`${root}/lib/pkgconfig/libraw.pc`}`;
            await $`sd -s -- "-lstdc++" "" ${`${root}/lib/pkgconfig/libraw_r.pc`}`;

            if (!isDebug) {
                await stripDllImport(`${root}/include/libraw/libraw_types.h`);
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
            await $`sd -s -- "add_subdirectory(website/src)" "" CMakeLists.txt`.cwd(path);
            // shortcut: OpenEXR 3.5.4 vendors OpenJPH 0.33 but still requires 0.32 for discovery, so a PATH-found msys64 0.32 wins; drop once upstream bumps the minimum
            await $`sd -s -- "set(OPENEXR_MINIMUM_OPENJPH_VERSION 0.32.0)" "set(OPENEXR_MINIMUM_OPENJPH_VERSION 0.33.0)" cmake/OpenEXRSetup.cmake`.cwd(
                path,
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
            await $`sd -s -- "include(DefaultCFlags)" "" CMakeLists.txt`.cwd(path);
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
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/FL/Fl_Export.H`);
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
            if (WIN && !isDebug && msvc) {
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
            await $`sd -s "add_subdirectory(tools)" "" CMakeLists.txt`.cwd(path);
            await $`sd -s "find_package(GIF 5.1)" "" lib/jxl_extras.cmake`.cwd(path);
        },
        finish: async ({ isDebug, root }) => {
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/jxl/jxl_export.h`);
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
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/archive.h`);
                await stripDllImport(`${root}/include/archive_entry.h`);
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
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/libheif/heif_export.h`);
            }
        },
    },
    /* Disabled; its CLANG64 package is still installed (MSYS2_EXTRA).
    {
        name: "mesa",
        source: { git: "https://gitlab.freedesktop.org/mesa/mesa", tag: "mesa-26.2.6" },
        build: "meson",
        // Only mesa's build scripts import these Python modules.
        mesonCommand: ["uv", "run", "--with", "mako,setuptools,pyyaml", "meson"],
        args: () =>
            `-Dplatforms=windows -Degl=enabled -Degl-native-platform=surfaceless -Dgles1=disabled -Dgles2=enabled -Dopengl=true -Dglx=disabled -Dgallium-drivers=d3d12 -Dgallium-d3d12-graphics=enabled -Dgallium-d3d12-video=disabled -Dvulkan-drivers= -Dllvm=disabled -Dshader-cache=disabled -Dxmlconfig=disabled -Dexpat=disabled -Dzlib=disabled -Dzstd=disabled -Dvalgrind=disabled -Dlibunwind=disabled -Dlmsensors=disabled -Ddisplay-info=disabled -Dmicrosoft-clc=disabled -Dspirv-to-dxil=false -Dbuild-tests=false -Dhtml-docs=disabled -Dmin-windows-version=10 -Dvideo-codecs=`,
        prepare: async ({ msvc, path }) => {
            if (msvc) {
                await $`sd -s -- "_interlockedexchange64" "_InterlockedExchange64" src/util/u_atomic.h`.cwd(path);
                await $`sd -s -- "_interlockedexchangeadd64" "_InterlockedExchangeAdd64" src/util/u_atomic.h`.cwd(path);
                await $`sd -s -- "_interlockeddecrement64" "_InterlockedDecrement64" src/util/u_atomic.h`.cwd(path);
                await $`sd -s -- "_interlockedincrement64" "_InterlockedIncrement64" src/util/u_atomic.h`.cwd(path);
                // _InterlockedAdd/_InterlockedAdd8/_InterlockedAdd16/64 are ARM64-only
                // intrinsics and aren't defined for x86_64; rewrite p_atomic_add_return
                // to use the (defined) ExchangeAdd variants plus the delta instead.
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

                // MSVC's CRT math.h only defines M_PI/M_LOG2E/etc. when
                // _USE_MATH_DEFINES is set before it's included; NIR's builtin
                // builder relies on them being available unconditionally.
                const preArgsOld = `'-DPACKAGE_BUGREPORT="https://gitlab.freedesktop.org/mesa/mesa/-/issues"',`,
                    preArgsNew = `${preArgsOld}\n  '-D_USE_MATH_DEFINES',`;

                await $`sd -s -- ${preArgsOld} ${preArgsNew} meson.build`.cwd(path);
            }

            if (WIN) {
                // include/meson.build only installs the Khronos GL/GLES/EGL headers
                // (EGL/egl.h, eglext.h, eglplatform.h, ...) when the host isn't
                // Windows - the non-upstream eglext_angle.h/eglmesaext.h pair a few
                // lines down has no such guard, so a Windows build ends up with
                // those two but not the base egl.h that consumers (e.g. libultrahdr's
                // find_package(EGL)) actually look for. Drop the Windows exclusion so
                // the full header set gets installed everywhere with_egl is on.
                await $`sd -s -- ${"if not with_glvnd and host_machine.system() != 'windows'"} ${"if not with_glvnd"} include/meson.build`.cwd(
                    path,
                );
            }
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
            if (WIN) {
                await $`sd -s -- ${"if(MSVC AND NOT BUILD_SHARED_LIBS)"} ${"if((MSVC OR WIN32) AND NOT BUILD_SHARED_LIBS)"} CMakeLists.txt`.cwd(
                    path,
                );
                await $`sd -s -- ${"if(BUILD_SHARED_LIBS AND NOT MSVC)"} ${"if(BUILD_SHARED_LIBS AND NOT (MSVC OR WIN32))"} CMakeLists.txt`.cwd(
                    path,
                );
                await $`sd -s -- ${"combine_static_libs(${UHDR_CORE_LIB_NAME} ${UHDR_TARGET_NAME_STATIC})\n  if(NOT MSVC)"} ${"combine_static_libs(${UHDR_CORE_LIB_NAME} ${UHDR_TARGET_NAME_STATIC})\n  if(NOT (MSVC OR WIN32))"} CMakeLists.txt`.cwd(
                    path,
                );
                await $`sd -s -- ${"$<$<CONFIG:Debug>:Debug>"} "" CMakeLists.txt`.cwd(path);
            }
        },
    },

    // --- End-user apps, excluded from dependency ordering ---
    {
        // One minimal build per FFmpeg variant (--ffmpeg-variants), each into `${prefix}/ffmpeg-<variant>`.
        name: "ffmpeg",
        source: { git: "https://github.com/FFmpeg/FFmpeg", tag: "n9.0.2" },
        profile: { asan: true, debugOpt: false },
        prepare: async ({ msvc, path }) => {
            // Upstream 9.0 treats any lld-link "ignoring unknown argument" warning as a
            // hard failure in test_ld, which kills the compiler sanity check outright
            // for any -Wl,* flag the local LLD doesn't recognize. Revert to exit-code-only.
            await $`sd -s -- ${`test $ret -eq 0 && ! echo "$output" | grep -qE 'LNK4044|lld-link: warning: ignoring unknown argument'`} ${"test $ret -eq 0"} configure`.cwd(
                path,
            );

            // mlpdsp_init.c defines the ff_mlp_firorder_*/ff_mlp_iirorder_* jump labels inside an inline-asm block and
            // references them from C. With -flto=full the C reference becomes an undefined external in the bitcode and
            // the labels only exist as local symbols after late codegen, so linking against avcodec.lib fails with
            // "undefined symbol: ff_mlp_firorder_*" unless /FORCE:UNRESOLVED is passed. Building this one object
            // without LTO keeps the assembler resolving the labels locally, as it does in a regular build.
            await appendFile(`${path}/libavcodec/x86/Makefile`, "\n$(SUBDIR)x86/mlpdsp_init.o: CFLAGS += -fno-lto\n");

            if (msvc) {
                await $`sd -s -- ${"$AR rcs"} "llvm-ar rcs" compat/windows/makedef`.cwd(path);
                await $`sd ${"SLIB_INSTALL_EXTRA_SHLIB='$(SLIBNAME:$(SLIBSUF)=.lib)'"} ${`SLIB_INSTALL_EXTRA_SHLIB='$(SLIBNAME:$(SLIBSUF)=.lib)$(SLIBNAME_WITH_MAJOR:$(SLIBSUF)=.pdb)'`} configure`.cwd(
                    path,
                );
                await $`sd -s -- ${"SLIB_INSTALL_EXTRA_LIB='$(SLIBNAME_WITH_MAJOR:$(SLIBSUF)=.def)'"} ${"SLIB_INSTALL_EXTRA_LIB='$(SLIBNAME:$(SLIBSUF)=.lib)'"} configure`.cwd(
                    path,
                );
            }
        },
        build: async ({ isDebug, msvc, path, root, step }) => {
            const { AR, CC, CFLAGS, CXX, CXXFLAGS, LDFLAGS, RANLIB, STRIP, WINDRES } = process.env,
                common = `--target-os=${WIN ? (msvc ? "win64" : "mingw32") : "linux"} --arch=x86_64 --cpu=x86-64-v3 ${msvc ? "--toolchain=msvc" : ""} --stdc=gnu17 --stdcxx=gnu++23 --cc=${CC} --cxx=${CXX} --ar=${AR} --strip=${STRIP} --ld=${CC} --ranlib=${RANLIB} --windres=${WINDRES} --disable-autodetect --disable-all --enable-asm --enable-protocol=file --enable-avformat --enable-avcodec --enable-avfilter --enable-swscale --enable-swresample --extra-cflags="${CFLAGS}" --extra-ldflags="${LDFLAGS}" --extra-cxxflags="${CXXFLAGS}" --optflags="${CFLAGS}"`,
                buildType = isDebug
                    ? "--disable-optimizations --enable-debug --disable-stripping"
                    : "--enable-optimizations --disable-debug --enable-stripping";

            for (const [variant, { codecs }] of Object.entries(FFMPEG_VARIANTS)) {
                if (!settings.ffmpegVariants.includes(variant)) {
                    continue;
                }
                await step(`ffmpeg-${variant}`, async () => {
                    await bash`cd ${toMsysPath(path)} && make clean`.noThrow();
                    await buildAutoconf(path, isDebug, `${root}/ffmpeg-${variant}`, {
                        args: `${common} ${buildType} ${codecs}`,
                        libs: false,
                        libtool: false,
                    });
                });
            }
        },
    },
    {
        // One build per ImageMagick variant (--magick-variants).
        name: "imagemagick",
        source: { git: "https://github.com/imagemagick/imagemagick", tag: "7.1.2-36" },
        profile: { asan: true, debugOpt: false },
        prepare: async ({ msvc, path }) => {
            // Swaps GPL FFTW3 for BSD-licensed PocketFFT, amalgamated into fourier.c. Safe to
            // git apply exactly once here: buildVariants resets the tree hard before prepare runs.
            // Also subsumes the old MAGICKCORE_HAVE_COMPLEX_H / HAVE_C{ABS,ARG,IMAG,REAL} rewrites,
            // since the patch undefines the former and defines the latter four outright.
            await applyPatch(path, "imagemagick-fourier-pocketfft.patch");

            if (msvc) {
                await $`sd -s "GOMP_LIBS=''" "GOMP_LIBS=' '" configure`.cwd(path);

                await $`sd ${String.raw`echo /'\*' \$ac_prefix_conf_OUT\. Generated automatically at end of configure\. '\*'/ >>\$tmp/pconfig\.h`} ${`echo /'*' $$ac_prefix_conf_OUT. Generated automatically at end of configure. '*'/ >>$$tmp/pconfig.h\n    echo 'typedef __int64 ssize_t;' >>$$tmp/pconfig.h`} configure`.cwd(
                    path,
                );
            }
        },
        build: async ({ isDebug, path, root, step }) => {
            // fourier.c is patched to #include this instead of linking GPL FFTW3, and the copy has
            // to happen here rather than in prepare: buildVariants runs `git clean -fdx` per variant
            // after prepare, which would delete these as untracked files.
            await $`cp ${`${ROOT}/patches/imagemagick/pocketfft.c`} MagickCore/pocketfft.c`.cwd(path);
            await $`cp ${`${ROOT}/patches/imagemagick/pocketfft.h`} MagickCore/pocketfft.h`.cwd(path);

            for (const { depth, hdri } of settings.magickVariants) {
                const hdr = hdri ? "enable" : "disable";
                await step(`q${depth}-${hdr}-hdri`, () =>
                    buildAutoconf(path, isDebug, root, {
                        args:
                            `--disable-dependency-tracking --disable-legacy-support ${isDebug ? "--enable-assert" : "--disable-assert"} --enable-openmp --enable-opencl --with-threads --with-quantum-depth=${depth} --without-modules --without-utilities --disable-docs --${hdr}-hdri --disable-deprecated --without-perl --with-ltdl ` +
                            "--with-bzlib --without-fftw --with-freetype --with-heic --without-jbig --with-jpeg --with-jxl --with-lcms --with-lzma --with-openexr --with-openjp2 --with-png --with-raw --with-tiff --with-webp --with-xml --with-zip --with-zlib --with-zstd --without-autotrace --without-djvu --without-dps --without-flif --without-fpx --without-fontconfig --without-gslib --without-gvc --without-dmr --without-lqr --without-pango --without-raqm --without-rsvg --with-uhdr --without-wmf --without-x --without-gdi32",
                    }),
                );
            }
        },
        finish: async ({ isDebug, msvc, path, root }) => {
            await $`rm -f ${root}/bin/MagickCore-config ${root}/bin/MagickWand-config ${root}/bin/Magick++-config`;
            if (isDebug && msvc) {
                await movePdbs(`${path}/MagickCore/.libs`, `${root}/bin`);
                await movePdbs(`${path}/MagickWand/.libs`, `${root}/bin`);
                await movePdbs(`${path}/Magick++/lib/.libs`, `${root}/bin`);

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
                common = `-no-guess-compiler -cmake-generator Ninja -c++std c++23 -gui -widgets -submodules ${submodules.join(",")} -pch -qpa "${WIN ? "windows" : "xcb;wayland"}" ${msvc ? "" : "-reduce-exports"} -disable-deprecated-up-to 0x060213 -nomake tests -nomake examples -nomake benchmarks -nomake manual-tests -nomake minimal-static-tests -nomake doc-snippets  -no-emojisegmenter -no-appstore-compliant -no-sbom -no-sbom-json -no-sbom-verify -no-system-proxies -no-mimetype-database -no-icu -no-gif -no-dbus ${WIN ? "-ssl -schannel -no-openssl" : "-no-ssl -no-openssl -no-schannel"} -no-libb2 -system-harfbuzz -system-freetype -system-libpng -system-libjpeg -system-webp -system-zlib -system-doubleconversion -system-pcre -system-libmd4c -no-tiff -no-jasper -no-mng -no-zstd ${!WIN ? "-no-glib -no-evdev -no-mtdev -no-tslib -no-eglfs -no-linuxfb -no-gtk -xcb-xlib -libudev -libinput -opengl -egl" : "-opengl desktop -no-egl"}`,
                featureToggles = `-feature-accessibility -feature-animation -feature-calendarwidget -feature-cborstreamreader -feature-cborstreamwriter -feature-datetimeedit -feature-datetimeparser -feature-designer -feature-dom -feature-draganddrop -feature-imageformat_jpeg -feature-imageformat_png -feature-imageformat_xpm -feature-linguist -feature-rubberband -feature-style-stylesheet ${WIN ? "-feature-style-windows -feature-style-windows11 -feature-style-windowsvista" : ""} -feature-texthtmlparser -feature-textmarkdownreader -feature-wizard -no-feature-androiddeployqt -no-feature-appstore-compliant -no-feature-assistant -no-feature-brotli -no-feature-distancefieldgenerator -no-feature-dnslookup -no-feature-dtls -no-feature-effects -no-feature-emojisegmenter -no-feature-fullqthelp -no-feature-gestures -no-feature-gssapi -no-feature-hijricalendar -no-feature-imageformat_bmp -no-feature-imageformat_ppm -no-feature-imageformat_xbm -no-feature-islamiccivilcalendar -no-feature-jalalicalendar -no-feature-kmap2qmap -no-feature-macdeployqt -no-feature-harmonydeployqt -no-feature-movie -no-feature-ocsp -no-feature-openssl-hash -no-feature-pdf -no-feature-pixeltool -no-feature-printsupport -no-feature-qdbus -no-feature-qdoc -no-feature-qdoc_coverage -no-feature-qmake -no-feature-qtattributionsscanner -no-feature-qtdiag -no-feature-qtplugininfo -no-feature-sessionmanager -no-feature-socks5 -no-feature-splashscreen -no-feature-sql -no-feature-sspi -no-feature-tabletevent -feature-testlib -no-feature-textmarkdownwriter -no-feature-textodfwriter -no-feature-timezone -no-feature-timezone_locale -no-feature-timezone_tzdb -no-feature-topleveldomain -no-feature-tuiotouch -no-feature-udpsocket -no-feature-wasm-exceptions -no-feature-wasm-jspi -no-feature-wasm-simd128 -no-feature-wasmdeployqt -no-feature-windeployqt ${!WIN ? "-no-feature-wayland-client-wl-shell -no-feature-liburing -no-feature-xlib -feature-system-xcb-xinput -no-feature-vnc" : ""}`;

            await $`git submodule update --init --depth 1 ${submodules}`.cwd(path);
            await $`git submodule update --init --recursive --depth 1`.cwd(`${path}/qttools`);

            if (isDebug) {
                if (msvc) {
                    await $`sd -s "add_dependencies(Core qmodule_pri)" ${`add_dependencies(Core qmodule_pri)\ntarget_link_options(Core PRIVATE "-Wl,-FORCE:UNRESOLVED")`} qtbase/src/corelib/CMakeLists.txt`.cwd(
                        path,
                    );
                }

                await $`./configure${raw(WIN ? ".bat" : "")} ${raw(common)} -debug -sanitize address -no-static -no-static-runtime ${raw(featureToggles)} -- -B=debug -DCMAKE_TOOLCHAIN_FILE=${DEBUG_TOOLCHAIN} -DQT_USE_DEFAULT_CMAKE_OPTIMIZATION_FLAGS=ON`.cwd(
                    path,
                );
                await $`cmake --build debug -j`.cwd(path);
                await $`cmake --install debug`.cwd(path);
            } else {
                await $`./configure${raw(WIN ? ".bat" : "")} ${raw(common)} -release -static -static-runtime ${raw(featureToggles)} -- -B=release -DCMAKE_TOOLCHAIN_FILE=${RELEASE_TOOLCHAIN} -DQT_USE_DEFAULT_CMAKE_OPTIMIZATION_FLAGS=ON`.cwd(
                    path,
                );
                await $`cmake --build release -j`.cwd(path);
                await $`cmake --install release`.cwd(path);
            }
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

    // --- Last: its lld PGO training links ImageMagick and its libraries ---
    {
        name: "llvm-project",
        source: { git: "https://github.com/llvm/llvm-project", tag: LLVM_TAG },
        sourceSubdir: "llvm",
        releaseOnly: true,
        // C++20: libc++ makes unique_ptr constexpr in C++23, which breaks LLVM's TableGen Matchers.h (make_unique of an incomplete type).
        profile: { cxxStd: "20", debugOpt: false, march: LLVM_MARCH, mtune: LLVM_MARCH, ownClang: false, rtti: true, fatLto: false },
        args: () => llvmArgs(LLVM_TABLEGEN_BIN),
        // CLANG64's pkg-config resolves libxml2's static deps (iconv, bcrypt, zlib) for LLVM's static libxml2 check.
        env: { LLVM_DEPS_PREFIX: `${MSYS2_ROOT}/clang64` },
        // A training run trains the profile here, before the build that uses it.
        prepare: async ({ path }) => {
            await applyPatch(path, "llvm-argdumper.patch");
            await pruneLlvmSources(path, ["clang", "clang-tools-extra", "cmake", "libc", "lld", "lldb", "llvm", "third-party"]);
            // lld and lldb add their docs directory without an option to turn it off.
            await $`sd -s "add_subdirectory(docs)" "" lld/CMakeLists.txt lldb/CMakeLists.txt`.cwd(path);
            await buildLlvmTablegen(path);
            await trainLlvm(path, llvmArgs(LLVM_TABLEGEN_BIN), LLVM_MAJOR, LLVM_MARCH);
        },
        // The LLVM profile changes the output without changing the pin, so its content is part of the build state too.
        statePin: (pin) =>
            `${pin}${llvmPgo() && existsSync(settings.llvmProfdata) ? `+pgo-${profileHash(settings.llvmProfdata)}` : ""}`,
        // install-distribution builds only LLVM_DIST_COMPONENTS and their dependencies, then installs them.
        cmakeTarget: "install-distribution",
    },
    // The runtimes are built apart from llvm-project, with CLANG64's clang: its libraries find the libc++, libunwind and
    // libomp the sanitizer DLLs link against, which llvm-project's just-built clang can't. Fat LTO objects: consumers
    // link these libraries, which need native code (compiler-rt builtins) next to the bitcode.
    {
        name: "llvm-runtimes",
        source: { git: "https://github.com/llvm/llvm-project", tag: LLVM_TAG },
        sourceSubdir: "runtimes",
        releaseOnly: true,
        profile: { cxxStd: "20", debugOpt: false, march: LLVM_MARCH, mtune: LLVM_MARCH, ownClang: false, ownLibcxx: true, rtti: true, compilerRt: true },
        args: () => LLVM_RUNTIMES_ARGS,
        // The flags aren't part of the tag, so a changed flag would otherwise leave the restored build as it was.
        statePin: (pin) => `${pin}+args-${createHash("sha256").update(LLVM_RUNTIMES_ARGS).digest("hex").slice(0, 12)}`,
        prepare: async ({ path }) => {
            // Static libomp on Windows: LLVM refuses LIBOMP_ENABLE_SHARED=OFF there; this is the patch MSYS2 applies for its static llvm-openmp.
            await applyPatch(path, "llvm-openmp-static-windows.patch");
            await pruneLlvmSources(path, ["cmake", "compiler-rt", "libc", "libcxx", "libcxxabi", "libunwind", "llvm", "openmp", "runtimes", "third-party"]);
        },
        cmakeTarget: "install",
        msvcTools: true,
    },
];

/**
 * Ruby 1.8/1.9 predate 64-bit Windows (their win32 port assumes a 32-bit `long` and MSVCRT internals), so they build
 * with the manually installed llvm-mingw i686 toolchain instead of clang64. Release only, installed to `${prefix}/release/<name>`.
 */
function ruby(name: string, archive: string, version: string): Library {
    return {
        name,
        source: { archive, subdir: `ruby-${version}`, version },
        releaseOnly: true,
        profile: { rtti: true },
        build: ({ path }) => buildRuby(path, name),
    };
}

async function buildRuby(p: string, name: string) {
    const triple = "i686-w64-mingw32",
        // Flags that target x86_64 or pull in the clang64 x86_64 runtime and libs; the i686 build must not get them.
        x64Flag = /^(-march=|-mtune=|--target=|-fopenmp|-static-openmp|-l|-L)/,
        keep = (flags: string) =>
            flags
                .split(" ")
                .filter((flag) => !x64Flag.test(flag))
                .join(" "),
        // x86-64-v3's instruction set, spelled out since -march is rejected for i686 targets.
        isa = "-mavx -mavx2 -mbmi -mbmi2 -mf16c -mfma -mlzcnt -mmovbe -mpopcnt -msse4.2 -mxsave",
        // The shell splits PATH on `:`, so the drive letter has to be an MSYS path.
        bin = toMsysPath(`${LLVM_MINGW_I686}/bin`),
        // Ruby's C code relies on -fno-strict-aliasing; the -Wno-error flags turn clang 16+ hard errors on its old code back into warnings.
        // 1.8's `inline` functions (lex.c) need gnu89 inline semantics to get an external definition. file.c includes
        // fcntl.h (and so sys/stat.h) before config.h sets _FILE_OFFSET_BITS=64, giving it a smaller `struct stat` than
        // win32.c's rb_w32_stat writes; defining it up front keeps the layout identical.
        cflags = `${keep(process.env.CFLAGS!)} ${isa} ${name.startsWith("ruby-1.8") ? "-fgnu89-inline -D_FILE_OFFSET_BITS=64" : ""} -fno-strict-aliasing -Wno-error=implicit-function-declaration -Wno-error=int-conversion -Wno-error=incompatible-function-pointer-types -Wno-error=incompatible-pointer-types -Wno-error=implicit-int`,
        ldflags = `${keep(process.env.LDFLAGS!)} ${isa}`;

    // Not buildAutoconf: its MSYS-style --prefix is resolved against the current drive by Ruby's native rbinstall, so the
    // prefix has to stay a Windows path. `install` depends on the encoding .so files, which can't link against a static
    // ruby.exe, so only the program and the Ruby libraries are installed.
    // RUBYOPT is cleared: the host's value (e.g. `-E`) is rejected by the old miniruby while it builds rbconfig.rb.
    const extraEnv = `RUBYOPT= PATH="${bin}:$PATH" CC=${triple}-clang CXX=${triple}-clang++ AR=${triple}-ar RANLIB=${triple}-ranlib STRIP=${triple}-strip MAKEFLAGS="LDSHARED=true WINDRES=${triple}-windres DLLWRAP=${toMsysPath(`${ROOT}/patches/ruby/dllwrap.sh`)}" CFLAGS="${cflags}" LDFLAGS="${ldflags}"`;

    if (name === "ruby-1.8.1") {
        // mingw's sys/time.h already defines `struct timezone` (guarded by _TIMEZONE_DEFINED); Ruby's win32.h redefines it.
        await $`sd -s '#ifdef __MINGW32__\nstruct timezone {' '#if defined(__MINGW32__) && !defined(_TIMEZONE_DEFINED)\n#define _TIMEZONE_DEFINED\nstruct timezone {' win32/win32.h`.cwd(p);
        await $`sd -s 'gettimeofday(struct timeval *, struct timezone *)' 'gettimeofday(struct timeval *, void *)' win32/win32.h`.cwd(p);
        await $`sd -s 'gettimeofday(struct timeval *tv, struct timezone *tz)' 'gettimeofday(struct timeval *tv, void *tz)' win32/win32.c`.cwd(p);
    }

    if (name === "ruby-1.8.7") {
        // mingw's time.h defines CLOCK_MONOTONIC/CLOCK_REALTIME and calls `_clock_gettime32`, which msvcrt doesn't export.
        await $`sd -f m '^#ifdef (CLOCK_(?:MONOTONIC|REALTIME))$' '#if defined($1) && !defined(__MINGW32__)' eval.c`.cwd(p);
    }

    if (name === "ruby-1.9.2") {
        // MinGW's msvcrt headers have no `struct _stati64`; Ruby's win32.h only maps it by a function-like macro, which
        // leaves the struct tag unresolved. Map it to `_stat64` (MinGW's struct) and keep the wrapper on `_stat64`.
        await $`sd -s '#define _stati64(path, st) rb_w32_stati64(path, st)' '#define _stati64 _stat64\n#define _stat64(path, st) rb_w32_stati64(path, st)' include/ruby/win32.h`.cwd(p);
    }

    await bash`cd ${toMsysPath(p)} && ${extraEnv} ./configure --host=${triple} --disable-install-doc --disable-rubygems --with-out-ext='*' --disable-shared --enable-static ${name.startsWith("ruby-1.8") ? "ac_cv_func_clock_gettime=no" : ""} --prefix=${buildRoot(false)}/${name}`;
    if (name === "ruby-1.8.1") {
        // Its GNUmakefile hardcodes `dllwrap --target=... --driver-name=...`, which resolves to llvm-mingw's dlltool shim.
        await $`sd -s 'dllwrap --target=mingw32 --driver-name=$(CC)' '$(DLLWRAP)' GNUmakefile`.cwd(p);
    }

    // Extensions can't be built as .so for a static ruby.exe, so zlib (plus stringio, which the research harness needs) is
    // compiled into the program: its Init_zlib is registered by an Init_ext that replaces dmyext.o in the archive.
    // llvm-mingw ships no i686 libz, so build one from the zlib sources.
    const zlibDir = `${settings.reposRoot}/zlib-i686`,
        zlibObjs =
            "adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback inffast inflate inftrees trees uncompr zutil",
        legacy = name.startsWith("ruby-1.8"),
        initZlib = legacy
            ? 'Init_zlib(); rb_provide("zlib.so"); Init_stringio(); rb_provide("stringio.so");'
            : 'ruby_init_ext("zlib.so", Init_zlib); ruby_init_ext("stringio.so", Init_stringio);',
        // 1.9's encodings and transcoders are .so files in a normal build; here they're linked in (see patches/ruby/encs.sh).
        encsStep = legacy
            ? "touch enc_protos.inc enc_calls.inc enc_objs.txt"
            : `sh ${toMsysPath(`${ROOT}/patches/ruby/encs.sh`)}`,
        initProto = legacy ? "" : "void ruby_init_ext(const char *name, void (*init)(void));";
    await bash`mkdir -p ${toMsysPath(zlibDir)} && cd ${toMsysPath(zlibDir)} && if [ ! -f libz.a ]; then export PATH="${bin}:$PATH" && curl -sL -o zlib.tar.gz https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz && tar xf zlib.tar.gz --strip-components=1 && for f in ${zlibObjs}; do ${triple}-clang -O2 -c $f.c -o $f.o || exit 1; done && ${triple}-ar rcs libz.a *.o; fi`;

    const zlibCflags = `-I${toMsysPath(zlibDir)} -Wno-error=incompatible-pointer-types`;
    await bash`cd ${toMsysPath(p)} && export ${extraEnv} && LIBA=$(printf 'print:\n\t@echo $(LIBRUBY_A)\n' | make -s -f Makefile -f - print) && make miniruby.exe $LIBA && ${encsStep} && printf '#include "ruby.h"
void Init_zlib(void);
void Init_stringio(void);
${initProto}
#include "enc_protos.inc"
void Init_ext(void) {
#include "enc_calls.inc"
${initZlib} }
' > extinit.c && $CC $CFLAGS ${zlibCflags} -I. -I./include -I./.ext/include/i386-mingw32 -c ext/zlib/zlib.c -o zlib_ext.o && $CC $CFLAGS -I. -I./include -I./.ext/include/i386-mingw32 -c ext/stringio/stringio.c -o stringio_ext.o && $CC $CFLAGS -I. -I./include -I./.ext/include/i386-mingw32 -c extinit.c -o extinit.o && $AR d $LIBA dmyext.o && $AR rs $LIBA extinit.o zlib_ext.o stringio_ext.o $(cat enc_objs.txt) && make EXTLDFLAGS="-L${toMsysPath(zlibDir)} -lz" ruby.exe rubyw.exe && cp $LIBA \${LIBA%-static.a}.a && make ${name === "ruby-1.8.1" ? "install" : "install-bin install-lib"}`;
}

export function getPin(library: Library): string {
    return "git" in library.source ? library.source.tag : library.source.archive;
}

export function shouldBuildLibrary(name: string, options: { exclude: Set<string>; only: null | Set<string> }): boolean {
    const key = name.toLowerCase();
    if (options.only) {
        return options.only.has(key);
    }
    return !options.exclude.has(key);
}
