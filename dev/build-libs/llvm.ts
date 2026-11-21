import $ from "dax";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";

import { applyPatch } from "./builders.ts";
import { trainLlvm } from "./pgo.ts";
import { CLANG64, CLANG64_PKG_CONFIG, LLVM_TABLEGEN_DIR, llvmPgo, settings } from "./settings.ts";
import { raw } from "./shell.ts";
import { marchFlags, profileOf, releaseOptFlags } from "./toolchain.ts";
import type { Library, ToolchainProfile } from "./types.ts";

const LLVM_SOURCE = { git: "https://github.com/llvm/llvm-project", tag: "llvmorg-23.1.6" },
    LLVM_PROFILE: Partial<ToolchainProfile> = {
        cxxStd: "20",
        debugOpt: false,
        march: "znver1",
        mtune: "znver1",
        ownClang: false,
        rtti: true,
    };

const LLVM_COMMON_ARGS =
    `-DLLVM_PARALLEL_LINK_JOBS=2 -DLLVM_TARGETS_TO_BUILD=X86 -DCLANG_DEFAULT_CXX_STDLIB=libc++ -DCLANG_DEFAULT_RTLIB=compiler-rt -DCLANG_DEFAULT_UNWINDLIB=libunwind -DLLVM_ENABLE_RPMALLOC=ON -DLLVM_ENABLE_ASSERTIONS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_DOCS=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_ENABLE_BINDINGS=OFF -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF -DCLANG_INCLUDE_TESTS=OFF -DCLANG_INCLUDE_DOCS=OFF -DCLANG_BUILD_EXAMPLES=OFF -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_ENABLE_OBJC_REWRITER=OFF -DCLANG_TOOLS_EXTRA_INCLUDE_DOCS=OFF -DLLDB_INCLUDE_TESTS=OFF -DLLDB_ENABLE_PYTHON=OFF -DLLDB_ENABLE_PYTHON_LIMITED_API=OFF -DLLDB_ENABLE_SWIG=OFF -DLLDB_ENABLE_DYNAMIC_SCRIPTINTERPRETERS=OFF -DLLDB_ENABLE_LUA=OFF -DLLDB_ENABLE_LZMA=OFF -DLLDB_ENABLE_LIBEDIT=OFF -DLLDB_ENABLE_CURSES=OFF -DLLDB_ENABLE_LIBXML2=OFF -DLLDB_ENABLE_TREESITTER=OFF -DLLDB_ENABLE_PROTOCOL_SERVERS=OFF -DLLDB_ENABLE_MTE=OFF -DLLDB_ENABLE_LIBCXX_TESTS=OFF -DLLVM_ENABLE_ZLIB=FORCE_ON -DZLIB_LIBRARY=${CLANG64}/lib/libz.a -DZLIB_INCLUDE_DIR=${CLANG64}/include -DLLVM_ENABLE_ZSTD=FORCE_ON -DLLVM_USE_STATIC_ZSTD=ON -DLLVM_USE_STATIC_LIBXML2=ON -DLIBXML2_DEFINITIONS=-DLIBXML_STATIC`;

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

async function pruneLlvmSources(path: string, keep: string[]): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== ".git" && !keep.includes(entry.name)) {
            await rm(`${path}/${entry.name}`, { force: true, recursive: true });
        }
    }
    await Promise.all(LLVM_UNUSED_DIRS.map((dir) => rm(`${path}/${dir}`, { force: true, recursive: true })));
}

const LLVM_DIST_COMPONENTS =
    "clang;clang-format;clang-resource-headers;clang-scan-deps;clang-tidy;clangd;liblldb;lld;lldb;llvm-ar;llvm-cov;llvm-dlltool;llvm-objcopy;llvm-objdump;llvm-profdata;llvm-ranlib;llvm-rc;llvm-strip;llvm-symbolizer;llvm-windres";

function llvmArgs(tablegenBin = ""): string {
    let args = `${LLVM_COMMON_ARGS} -DLLVM_ENABLE_LIBCXX=ON -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra;lld;lldb" -DLLVM_NATIVE_TOOL_DIR=${tablegenBin} -DLLVM_DISTRIBUTION_COMPONENTS="${LLVM_DIST_COMPONENTS}"`;
    if (llvmPgo() && existsSync(settings.llvmProfdata)) {
        args += ` -DLLVM_PROFDATA_FILE=${settings.llvmProfdata}`;
    }
    return args;
}

const LLVM_TABLEGEN_BIN = `${LLVM_TABLEGEN_DIR}/bin`,
    LLVM_TABLEGEN_TOOLS = [
        "llvm-tblgen",
        "llvm-min-tblgen",
        "clang-tblgen",
        "lldb-tblgen",
        "clang-tidy-confusable-chars-gen",
    ];

async function buildLlvmTablegen(llvmPath: string) {
    await $`cmake -G Ninja -S ${llvmPath}/llvm -B ${LLVM_TABLEGEN_DIR} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS= -DCMAKE_CXX_FLAGS= ${raw(llvmArgs())} -DLLVM_ENABLE_PROJECTS=${"clang;clang-tools-extra;lldb"} -DLLVM_ENABLE_RUNTIMES= -DLLVM_DISTRIBUTION_COMPONENTS=`.env(
        {
            ...process.env,
            LLVM_DEPS_PREFIX: CLANG64,
            PKG_CONFIG_PATH: CLANG64_PKG_CONFIG,
        },
    );
    await $`ninja ${LLVM_TABLEGEN_TOOLS}`.cwd(LLVM_TABLEGEN_DIR);
}

const LLVM_RUNTIMES_ARGS = `${LLVM_COMMON_ARGS} -DLLVM_ENABLE_RUNTIMES="compiler-rt;libcxx;libcxxabi;libunwind;openmp" -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXX_ENABLE_STATIC=ON -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_STATIC=ON -DLIBUNWIND_ENABLE_SHARED=OFF -DLIBUNWIND_ENABLE_STATIC=ON -DLIBOMP_ENABLE_SHARED=OFF -DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON -DCOMPILER_RT_INSTALL_PATH=lib/clang/23 -DCOMPILER_RT_BUILD_SANITIZERS=ON -DCOMPILER_RT_BUILD_PROFILE=ON -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON -DCOMPILER_RT_USE_BUILTINS_LIBRARY=ON -DSANITIZER_CXX_ABI=libc++ -DCMAKE_C_COMPILER_TARGET=x86_64-w64-windows-gnu -DCMAKE_CXX_COMPILER_TARGET=x86_64-w64-windows-gnu -DSANITIZER_CXX_ABI_LIBRARIES="-Llib;-lc++;-lc++abi;-lunwind"`;

export const llvmProject: Library = {
    name: "llvm-project",
    source: LLVM_SOURCE,
    sourceSubdir: "llvm",
    releaseOnly: true,
    profile: { ...LLVM_PROFILE, ownRuntimes: true, fatLto: false },
    args: () => llvmArgs(LLVM_TABLEGEN_BIN),
    env: { LLVM_DEPS_PREFIX: CLANG64 },
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
        await $`sd -s "add_subdirectory(docs)" "" lld/CMakeLists.txt lldb/CMakeLists.txt`.cwd(path);
        await buildLlvmTablegen(path);
        const profile = profileOf(llvmProject),
            optFlags = [...marchFlags(profile), ...releaseOptFlags(false, false)].join(" ");
        await trainLlvm(path, llvmArgs(LLVM_TABLEGEN_BIN), optFlags);
    },
    cmakeTarget: "install-distribution",
};

export const llvmRuntimes: Library = {
    name: "llvm-runtimes",
    source: LLVM_SOURCE,
    sourceSubdir: "runtimes",
    releaseOnly: true,
    profile: { ...LLVM_PROFILE, ownLibcxx: true, lto: false },
    args: () => LLVM_RUNTIMES_ARGS,
    prepare: async ({ path }) => {
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
