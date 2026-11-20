// The LLVM libraries: llvm-project (the binaries) and llvm-runtimes (compiler-rt, libc++, libc++abi, libunwind, libomp).
// Both are bootstrapped with CLANG64's clang (profile.ownClang: false) and install into the clang target's prefix.
// llvm-project is the last library built: a PGO training run trains its profile in prepare (trainLlvm in pgo.ts).

import $ from "dax";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";

import { applyPatch } from "./builders.ts";
import { profileHash, trainLlvm } from "./pgo.ts";
import { CLANG64, CLANG64_PKG_CONFIG, LLVM_TABLEGEN_DIR, llvmPgo, settings } from "./settings.ts";
import { raw } from "./shell.ts";
import type { Library, ToolchainProfile } from "./types.ts";

const LLVM_MARCH = "znver1",
    LLVM_TAG = "llvmorg-23.1.6",
    LLVM_MAJOR = LLVM_TAG.replace(/^llvmorg-/, "").split(".")[0]!;

// What llvm-project and llvm-runtimes share. C++20: libc++ makes unique_ptr constexpr in C++23, which breaks LLVM's
// TableGen Matchers.h (make_unique of an incomplete type).
const LLVM_SOURCE = { git: "https://github.com/llvm/llvm-project", tag: LLVM_TAG },
    LLVM_PROFILE: Partial<ToolchainProfile> = {
        cxxStd: "20",
        debugOpt: false,
        march: LLVM_MARCH,
        mtune: LLVM_MARCH,
        ownClang: false,
        rtti: true,
    };

// CMake arguments of both builds. A build ignores what it doesn't read (the runtimes build has no LLDB), so everything
// not specific to one of them lives here. Dependencies come from CLANG64 and are linked statically: zlib by its libz.a,
// zstd by LLVM_USE_STATIC_ZSTD (its find_library otherwise takes libzstd.dll.a, the import library of the DLL), both
// FORCE_ON so that a missing static library fails the configure instead of silently dropping the compression.
const LLVM_COMMON_ARGS = [
    "-DLLVM_PARALLEL_LINK_JOBS=2",
    "-DLLVM_TARGETS_TO_BUILD=X86",
    "-DCLANG_DEFAULT_CXX_STDLIB=libc++",
    "-DCLANG_DEFAULT_RTLIB=compiler-rt",
    "-DCLANG_DEFAULT_UNWINDLIB=libunwind",
    "-DLLVM_ENABLE_RPMALLOC=ON",
    "-DLLVM_ENABLE_ASSERTIONS=OFF",
    "-DLLVM_INCLUDE_TESTS=OFF",
    "-DLLVM_INCLUDE_DOCS=OFF",
    "-DLLVM_INCLUDE_UTILS=OFF",
    "-DLLVM_INCLUDE_BENCHMARKS=OFF",
    "-DLLVM_INCLUDE_EXAMPLES=OFF",
    "-DLLVM_ENABLE_BINDINGS=OFF",
    "-DLLVM_ENABLE_LIBEDIT=OFF",
    "-DLLVM_ENABLE_LIBPFM=OFF",
    "-DCLANG_INCLUDE_TESTS=OFF",
    "-DCLANG_INCLUDE_DOCS=OFF",
    "-DCLANG_BUILD_EXAMPLES=OFF",
    "-DCLANG_ENABLE_STATIC_ANALYZER=OFF",
    "-DCLANG_ENABLE_OBJC_REWRITER=OFF",
    "-DCLANG_TOOLS_EXTRA_INCLUDE_DOCS=OFF",
    "-DLLDB_INCLUDE_TESTS=OFF",
    "-DLLDB_ENABLE_PYTHON=OFF",
    "-DLLDB_ENABLE_PYTHON_LIMITED_API=OFF",
    "-DLLDB_ENABLE_SWIG=OFF",
    "-DLLDB_ENABLE_DYNAMIC_SCRIPTINTERPRETERS=OFF",
    "-DLLDB_ENABLE_LUA=OFF",
    "-DLLDB_ENABLE_LZMA=OFF",
    "-DLLDB_ENABLE_LIBEDIT=OFF",
    "-DLLDB_ENABLE_CURSES=OFF",
    "-DLLDB_ENABLE_LIBXML2=OFF",
    "-DLLDB_ENABLE_TREESITTER=OFF",
    "-DLLDB_ENABLE_PROTOCOL_SERVERS=OFF",
    "-DLLDB_ENABLE_MTE=OFF",
    "-DLLDB_ENABLE_LIBCXX_TESTS=OFF",
    "-DLLVM_ENABLE_ZLIB=FORCE_ON",
    `-DZLIB_LIBRARY=${CLANG64}/lib/libz.a`,
    `-DZLIB_INCLUDE_DIR=${CLANG64}/include`,
    "-DLLVM_ENABLE_ZSTD=FORCE_ON",
    "-DLLVM_USE_STATIC_ZSTD=ON",
    "-DLLVM_USE_STATIC_LIBXML2=ON",
    "-DLIBXML2_DEFINITIONS=-DLIBXML_STATIC",
].join(" ");

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

// The binaries. The runtimes are the separate llvm-runtimes library.
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
    `${LLVM_COMMON_ARGS} -DLLVM_ENABLE_LIBCXX=ON -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra;lld;lldb" -DLLVM_NATIVE_TOOL_DIR=${tablegenBin} -DLLVM_DISTRIBUTION_COMPONENTS="${LLVM_DIST_COMPONENTS}"${llvmPgo() && existsSync(settings.llvmProfdata) ? ` -DLLVM_PROFDATA_FILE=${settings.llvmProfdata}` : ""}`;

// The host TableGen tools only run inside the build, so they're built here without -flto=full and reach the main build through LLVM_NATIVE_TOOL_DIR.
const LLVM_TABLEGEN_BIN = `${LLVM_TABLEGEN_DIR}/bin`,
    LLVM_TABLEGEN_TOOLS = [
        "llvm-tblgen",
        "llvm-min-tblgen",
        "clang-tblgen",
        "lldb-tblgen",
        "clang-tidy-confusable-chars-gen",
    ];

async function buildLlvmTablegen(llvmPath: string) {
    // -DCMAKE_C_FLAGS=/CXX_FLAGS= clear the CFLAGS env var, which may still hold the previous library's -flto=full (see prepare in pgo.ts).
    await $`cmake -G Ninja -S ${llvmPath}/llvm -B ${LLVM_TABLEGEN_DIR} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS= -DCMAKE_CXX_FLAGS= ${raw(llvmArgs())} -DLLVM_ENABLE_PROJECTS=${"clang;clang-tools-extra;lldb"} -DLLVM_ENABLE_RUNTIMES= -DLLVM_DISTRIBUTION_COMPONENTS=`.env(
        {
            ...process.env,
            LLVM_DEPS_PREFIX: CLANG64,
            PKG_CONFIG_PATH: CLANG64_PKG_CONFIG,
        },
    );
    await $`ninja ${LLVM_TABLEGEN_TOOLS}`.cwd(LLVM_TABLEGEN_DIR);
}

const LLVM_RUNTIMES_ARGS = `${LLVM_COMMON_ARGS} -DLLVM_ENABLE_RUNTIMES="compiler-rt;libcxx;libcxxabi;libunwind;openmp" -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXX_ENABLE_STATIC=ON -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_STATIC=ON -DLIBUNWIND_ENABLE_SHARED=OFF -DLIBUNWIND_ENABLE_STATIC=ON -DLIBOMP_ENABLE_SHARED=OFF -DCOMPILER_RT_BUILD_SANITIZERS=ON -DCOMPILER_RT_BUILD_PROFILE=ON -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON -DCOMPILER_RT_USE_BUILTINS_LIBRARY=ON -DSANITIZER_CXX_ABI=libc++ -DCMAKE_C_COMPILER_TARGET=x86_64-w64-windows-gnu -DCMAKE_CXX_COMPILER_TARGET=x86_64-w64-windows-gnu -DSANITIZER_CXX_ABI_LIBRARIES="-Llib;-lc++;-lc++abi;-lunwind"`;
const LLVM_RUNTIMES_ARGS_HASH = createHash("sha256").update(LLVM_RUNTIMES_ARGS).digest("hex").slice(0, 12);

export const llvmProject: Library = {
    name: "llvm-project",
    source: LLVM_SOURCE,
    sourceSubdir: "llvm",
    releaseOnly: true,
    profile: { ...LLVM_PROFILE, ownRuntimes: true, fatLto: false },
    args: () => llvmArgs(LLVM_TABLEGEN_BIN),
    // CLANG64's pkg-config resolves libxml2's static deps (iconv, bcrypt, zlib) for LLVM's static libxml2 check.
    env: { LLVM_DEPS_PREFIX: CLANG64 },
    // A training run trains the profile here, before the build that uses it.
    prepare: async ({ path }) => {
        await applyPatch(path, "llvm-argdumper.patch");
        await pruneLlvmSources(path, [
            "clang",
            "clang-tools-extra",
            "cmake",
            "libc",
            "lld",
            "lldb",
            "llvm",
            "third-party",
        ]);
        // lld and lldb add their docs directory without an option to turn it off.
        await $`sd -s "add_subdirectory(docs)" "" lld/CMakeLists.txt lldb/CMakeLists.txt`.cwd(path);
        await buildLlvmTablegen(path);
        await trainLlvm(path, llvmArgs(LLVM_TABLEGEN_BIN), LLVM_MAJOR, LLVM_MARCH);
    },
    // The LLVM profile changes the output without changing the pin, so its content is part of the build state too. Its libc++
    // and libomp come from llvm-runtimes, so that job's flags are part of it as well. The LLVM flags aren't part of the tag either.
    statePin: (pin) =>
        `${pin}${llvmPgo() && existsSync(settings.llvmProfdata) ? `+pgo-${profileHash(settings.llvmProfdata)}` : ""}+runtimes-${LLVM_RUNTIMES_ARGS_HASH}+args-${createHash("sha256").update(llvmArgs(LLVM_TABLEGEN_BIN)).digest("hex").slice(0, 12)}`,
    // install-distribution builds only LLVM_DIST_COMPONENTS and their dependencies, then installs them.
    cmakeTarget: "install-distribution",
};

// Built apart from llvm-project, with CLANG64's clang: its libraries find the libc++, libunwind and libomp the sanitizer
// DLLs link against, which llvm-project's just-built clang can't. Fat LTO objects: consumers link these libraries, which
// need native code (compiler-rt builtins) next to the bitcode.
export const llvmRuntimes: Library = {
    name: "llvm-runtimes",
    source: LLVM_SOURCE,
    sourceSubdir: "runtimes",
    releaseOnly: true,
    profile: { ...LLVM_PROFILE, ownLibcxx: true, compilerRt: true, lto: false },
    args: () => LLVM_RUNTIMES_ARGS,
    // The flags aren't part of the tag, so a changed flag would otherwise leave the restored build as it was.
    statePin: (pin) => `${pin}+args-${LLVM_RUNTIMES_ARGS_HASH}`,
    prepare: async ({ path }) => {
        // Static libomp on Windows: LLVM refuses LIBOMP_ENABLE_SHARED=OFF there; this is the patch MSYS2 applies for its static llvm-openmp.
        await applyPatch(path, "llvm-openmp-static-windows.patch");
        await pruneLlvmSources(path, [
            "cmake",
            "compiler-rt",
            "libc",
            "libcxx",
            "libcxxabi",
            "libunwind",
            "llvm",
            "openmp",
            "runtimes",
            "third-party",
        ]);
    },
    cmakeTarget: "install",
    msvcTools: true,
};
