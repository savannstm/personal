import $ from "dax";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildAutoconf, replaceInFile, stripDllImport } from "./builders.ts";
import { buildRoot, CLANG64, ROOT, settings } from "./settings.ts";
import { bash, toMsysPath } from "./shell.ts";
import type { Library } from "./types.ts";

export const LLVM_MINGW_I686 = "C:/PATH/llvm-mingw-msvcrt-i686";

// What the x86_64 Rubies' libruby and extensions (gmp, openssl, psych, fiddle) link statically: release-only static libraries from the
// repo's flags (-O3 -flto=full, no fat objects: the extensions link with LTO as well), instead of CLANG64's DLLs.
const RUBY_DEP_PROFILE = { fatLto: false, mtune: "znver1" } as const;

export const RUBY_DEPENDENCIES: Library[] = [
    {
        name: "gmp",
        source: { archive: "https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz", subdir: "gmp-6.3.0", version: "6.3.0" },
        releaseOnly: true,
        toolchains: ["clang"],
        profile: RUBY_DEP_PROFILE,
        build: async ({ isDebug, path, root }) => {
            await buildAutoconf(path, isDebug, root, {
                // The probe's COMDAT section (.rdata$foo,...,one_only,foo) makes clang's assembler require a symbol foo, which the objects don't define.
                env: "ABI=64 gmp_cv_asm_rodata='.section .rdata,\"dr\"'",
            });
        },
    },
    {
        name: "libyaml",
        source: { git: "https://github.com/yaml/libyaml", tag: "0.2.7" },
        releaseOnly: true,
        toolchains: ["clang"],
        profile: RUBY_DEP_PROFILE,
        args: () => "-DBUILD_TESTING=OFF",
        finish: async ({ root }) => {
            // Static library: yaml.h would import its functions from a DLL.
            stripDllImport(`${root}/include/yaml.h`);
        },
    },
    {
        name: "libffi",
        source: {
            archive: "https://github.com/libffi/libffi/releases/download/v3.8.1/libffi-3.8.1.tar.gz",
            subdir: "libffi-3.8.1",
            version: "3.8.1",
        },
        releaseOnly: true,
        toolchains: ["clang"],
        profile: RUBY_DEP_PROFILE,
        build: async ({ isDebug, path, root }) => {
            // libtool: false with its options by hand: libffi's libtool is generated in a subdirectory, out of reach of the patch (a static library never needs it).
            await buildAutoconf(path, isDebug, root, {
                args: "--disable-docs --disable-multi-os-directory --disable-dependency-tracking --with-gnu-ld --build=x86_64-w64-mingw32 --host=x86_64-w64-mingw32 lt_cv_deplibs_check_method=pass_all lt_cv_prog_gnu_ld=yes",
                libtool: false,
            });
        },
    },
    {
        name: "openssl",
        source: { git: "https://github.com/openssl/openssl", tag: "openssl-3.6.5" },
        releaseOnly: true,
        toolchains: ["clang"],
        profile: RUBY_DEP_PROFILE,
        build: async ({ path, root }) => {
            // Not buildAutoconf: Configure is a Perl script. The libraries only (no apps, docs or tests); CC, CFLAGS, AR and RC come from the env.
            await bash`cd ${toMsysPath(path)} && perl Configure mingw64 no-shared no-tests no-docs --prefix=${root} --libdir=lib --openssldir=${root}/ssl && make -j$(nproc) build_libs && make install_dev`;
        },
        finish: async ({ root }) => {
            // Ruby's openssl extension takes pkg-config's word for the libraries and never probes for the static ones' Windows dependencies.
            replaceInFile(`${root}/lib/pkgconfig/libcrypto.pc`, /^Libs: .*$/m, "$& -lws2_32 -lgdi32 -lcrypt32");
        },
    },
];

export function ruby(name: string, archive: string, version: string): Library {
    return {
        name,
        source: { archive, subdir: `ruby-${version}`, version },
        releaseOnly: true,
        profile: { fatLto: false, mtune: "znver1", rtti: true },
        build: ({ path }) => buildRuby(path, name),
    };
}

// An x86_64 Ruby (shared libruby; 3.x with every default extension, so gems, bundler, Rails and Jekyll work; 2.7 minimal: just
// encodings, zlib and stringio), built with the repo's CLANG64 toolchain, unlike the i686 llvm-mingw rubies above.
export function rubyX64(name: string, archive: string, version: string): Library {
    const legacy = version.startsWith("2.");
    return {
        name,
        source: { archive, subdir: `ruby-${version}`, version },
        releaseOnly: true,
        toolchains: ["clang"],
        profile: { fatLto: false, mtune: "znver1", rtti: true },
        // The build stamp ignores source edits: without this, a cached Ruby with the C runtime's jumps is skipped.
        variants: () => "builtin-jumps",
        prepare: async ({ path }) => {
            replaceInFile(`${path}/eval_intern.h`, RUBY_JUMPS, CLANG_BUILTIN_JUMPS);
            // --no-llvm-bc makes llvm-nm skip LTO's bitcode objects, so mkexports.rb finds no symbols to export from libruby.
            replaceInFile(`${path}/configure`, 'NM="$NM --no-llvm-bc"', ":", { optional: true });
            if (legacy) {
                await patchRuby27(path);
            } else {
                // Static OpenSSL: libruby exports send, recv, connect, ... too, taking CRT descriptors instead of sockets, and
                // is linked first. ws2_32 has to precede it, or every TLS connection fails with ENOTSOCK.
                replaceInFile(
                    `${path}/ext/openssl/extconf.rb`,
                    'require "mkmf"\n',
                    'require "mkmf"\n$LOCAL_LIBS << " -lws2_32"\n',
                );
            }
        },
        build: ({ path, root }) => buildRubyX64(path, `${root}/${name}`, legacy),
        finish: ({ root }) => finishRubyX64(`${root}/${name}`, legacy),
    };
}

// What the repo's flags break in Ruby: LTO (libruby fails to link on .refptr symbols), -static (lld then ignores the libruby import
// library, so no extension links), hidden visibility (extensions' Init_ functions aren't exported), OpenMP (unused).
const RUBY_DROPPED_FLAGS = new Set([
    "-fopenmp",
    "-fvisibility-inlines-hidden",
    "-fvisibility=hidden",
    "-static",
    "-static-libgcc",
    "-static-libstdc++",
    "-static-openmp",
]);
const withoutDroppedFlags = (flags: string) =>
    flags
        .split(" ")
        .filter((flag) => flag && !RUBY_DROPPED_FLAGS.has(flag))
        .join(" ");

// Ruby's exception jumps through the compiler builtins, as in GCC builds: the C runtime's longjmp unwinds through SEH and makes a
// raise several times slower. Clang's __builtin_setjmp stores a wrong frame pointer on Windows (every raise crashes), so RBP is
// written over it. configure keeps --with-setjmp-type=setjmp: gc.c's use of RUBY_SETJMP needs the registers in the buffer.
const RUBY_JUMPS =
    "#define ruby_setjmp(env) RUBY_SETJMP(env)\n#define ruby_longjmp(env,val) RUBY_LONGJMP((env),(val))\n";
export const CLANG_BUILTIN_JUMPS = `#define ruby_setjmp(env) __extension__({ \
    void **const jumps_ = (void **)(env); \
    const int jumped_ = __builtin_setjmp(jumps_); \
    if (!jumped_) __asm__ __volatile__("movq %%rbp, (%0)" : : "r"(jumps_) : "memory"); \
    jumped_; \
})
#define ruby_longjmp(env,val) __builtin_longjmp((void **)(env), (val))
`;

async function buildRubyX64(path: string, prefix: string, legacy: boolean) {
    // Ruby needs -fno-strict-aliasing; 2.7's C is too old for clang's stricter defaults.
    const cflags = `${withoutDroppedFlags(process.env.CFLAGS!)} -fno-strict-aliasing${legacy ? " -Wno-error=implicit-function-declaration -Wno-error=int-conversion -Wno-error=incompatible-function-pointer-types -Wno-error=incompatible-pointer-types -Wno-error=implicit-int" : ""}`,
        ldflags = withoutDroppedFlags(process.env.LDFLAGS!);

    // libwinpthread (static) is for clock_gettime. 2.7 detects the C runtime by the msvc*.dll its test program imports; UCRT
    // has none, so say it's UCRT. 2.7 builds only zlib and stringio (encodings are built regardless), like the 1.x rubies, and
    // no rubygems; monitor is there with digest because the installer (tool/rbinstall.rb) loads rubygems, which requires them.
    await buildAutoconf(path, false, prefix, {
        args: `--build=x86_64-w64-mingw32 --host=x86_64-w64-mingw32 --disable-install-doc --disable-yjit --disable-zjit --with-baseruby=no --with-setjmp-type=setjmp${legacy ? " --with-ext='digest*,monitor,stringio,zlib' --disable-rubygems" : ""} --with-opt-dir=${buildRoot(false)}`,
        env: `RUBYOPT= LIBS=-l:libwinpthread.a${legacy ? " rb_cv_msvcrt=ucrt140" : ""} CFLAGS="${cflags}" LDFLAGS="${ldflags}"`,
        jobs: "$(nproc)",
        libs: false,
        libtool: false,
        linkage: "--enable-shared",
        nativePrefix: true,
    });
}

// 2.7 predates UCRT on MinGW and is written for MSVC's compiler and runtime: win32.c writes FILE::_file (opaque in UCRT; the
// dup2 in open_null already does the job), defines clock_gettime/clock_getres (libwinpthread's headers declare them), declares a
// static function in a block scope, and calls MSVC's debug-runtime functions (_CrtSetReportMode, _RTC_SetErrorFunc). Its
// GNUmakefile also hands llvm-windres a preprocessor option, which it rejects (newer Ruby knows), and its mkexports.rb can't read
// llvm-objdump's output (the DLL would export 7 symbols); 3.3's can, so patches/ruby/mkexports-3.3.rb replaces it.
async function patchRuby27(path: string) {
    replaceInFile(
        `${path}/cygwin/GNUmakefile.in`,
        '@WINDRES@ --preprocessor="$(CPP) -xc" -DRC_INVOKED',
        "@WINDRES@ -DRC_INVOKED",
    );
    copyFileSync(`${ROOT}/patches/ruby/mkexports-3.3.rb`, `${path}/win32/mkexports.rb`);
    // The minimal build installs no gems: installing the default and bundled ones needs openssl, psych and more.
    replaceInFile(`${path}/tool/rbinstall.rb`, "$exclude = []", "$exclude = [:gem]");
    const file = `${path}/win32/win32.c`;
    replaceInFile(file, /FILE_FILENO\((std[a-z]+)\) = (open_null\(\d\));/g, "$2;");
    replaceInFile(file, /^clock_(gettime|getres)\(clockid_t/gm, "rb_unused_clock_$1(clockid_t");
    replaceInFile(
        file,
        "    static void set_pioinfo_extra(void);\n\n    _CrtSetReportMode(_CRT_ASSERT, 0);\n    _set_invalid_parameter_handler(invalid_parameter);\n    _RTC_SetErrorFunc(rtc_error_handler);\n",
        "    _set_invalid_parameter_handler(invalid_parameter);\n",
    );
    replaceInFile(
        file,
        "static int w32_cmdvector(const WCHAR *, char ***, UINT, rb_encoding *);\n",
        "static int w32_cmdvector(const WCHAR *, char ***, UINT, rb_encoding *);\nstatic void set_pioinfo_extra(void);\n",
    );
}

// The installed Ruby is what users build gems with, so rbconfig must not carry this build's paths (resource dir, prefix libraries,
// sccache) and the dependency DLLs ship next to it.
async function finishRubyX64(prefix: string, legacy: boolean) {
    // This build's paths: the prefix (resource dir, libc++ headers, libraries) and CLANG64's clang headers.
    const escape = (path: string) => path.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`),
        ownPaths = `(?:${escape(buildRoot(false))}|${escape(CLANG64)}/lib/clang)`,
        ownFlags = new RegExp(
            String.raw`( ?-resource-dir [^\s"']+| ?-isystem ${ownPaths}[^\s"']*| ?-L${ownPaths}[^\s"']*| ?-nostdinc\+\+| ?-lc\+\+abi| ?-lunwind| ?-lclang_rt\.[^\s"']+)`,
            "g",
        );
    const rbconfigs = readdirSync(prefix, { recursive: true, encoding: "utf8" }).filter((file) =>
        file.endsWith("rbconfig.rb"),
    );
    for (const rbconfig of rbconfigs) {
        const file = `${prefix}/${rbconfig}`;
        writeFileSync(file, readFileSync(file, "utf8").replace(ownFlags, "").replaceAll("sccache ", ""));
    }

    // 3.x links OpenSSL, libyaml, GMP and libffi statically; whatever DLLs still come from CLANG64 are copied transitively.
    const bin = `${prefix}/bin`,
        queue = readdirSync(prefix, { recursive: true, encoding: "utf8" })
            .filter((file) => /\.(dll|so|exe)$/.test(file))
            .map((file) => `${prefix}/${file}`);
    for (const file of queue) {
        for (const [, dll] of (await $`llvm-objdump -p ${file}`.text()).matchAll(/DLL Name: (\S+)/g)) {
            const source = `${CLANG64}/bin/${dll}`;
            if (existsSync(source) && !existsSync(`${bin}/${dll}`)) {
                copyFileSync(source, `${bin}/${dll}`);
                queue.push(`${bin}/${dll}`);
            }
        }
    }

    // Only the install itself on PATH: anything missing above fails here instead of on the user's machine.
    await $`${bin}/ruby.exe -e ${legacy ? RUBY_SMOKE_TEST_27 : RUBY_SMOKE_TEST}`.env({
        PATH: `${bin};C:/Windows/System32`,
        RUBYOPT: "",
    });
}

// 2.7 is minimal: basic Ruby, every encoding (and transcoder), zlib and stringio.
const RUBY_SMOKE_TEST_27 = `
    abort "raise" unless 10_000.times.count { |i| catch(:out) { begin; raise ArgumentError if i.odd?; throw :out, true; rescue ArgumentError; true; ensure; i.to_s; end } } == 10_000
    Encoding.name_list.each { |name| Encoding.find(name) }
    require "zlib"
    require "stringio"
    abort "broken" unless "é".encode("Shift_JIS", undef: :replace).encode("UTF-8") && Zlib.crc32("a") == 0xe8b7be43 && StringIO.new("a").read == "a"
`;

const RUBY_SMOKE_TEST = `
    abort "raise" unless 10_000.times.count { |i| catch(:out) { begin; raise ArgumentError if i.odd?; throw :out, true; rescue ArgumentError; true; ensure; i.to_s; end } } == 10_000
    missing = %w[bigdecimal date digest etc fcntl io/console json monitor objspace open3 openssl psych ripper securerandom socket stringio strscan zlib].reject { |lib|
        begin; require lib; true; rescue LoadError => e; warn "#{lib}: #{e.message}"; false; end
    }
    abort "missing: #{missing.join(", ")}" unless missing.empty? && Encoding::UTF_8 && Psych.load("a: 1") == { "a" => 1 }
`;

async function buildRuby(p: string, name: string) {
    const legacy = name.startsWith("ruby-1.8"),
        triple = "i686-w64-mingw32",
        // The repo's x64 resource dir (its headers and compiler-rt) and runtime choices have no i686 counterpart: llvm-mingw's clang uses its own.
        x64Flag = /^(-march=|--target=|-fopenmp|-static-openmp|-l|-L|-rtlib=|--unwindlib=)/,
        keep = (flags: string) => {
            const tokens = flags.split(" "),
                kept: string[] = [];
            for (let idx = 0; idx < tokens.length; idx++) {
                const flag = tokens[idx]!;
                if (flag === "-resource-dir" || (flag === "-isystem" && tokens[idx + 1]!.includes("/lib/clang/"))) {
                    idx++;
                } else if (!x64Flag.test(flag)) {
                    kept.push(flag);
                }
            }
            return kept.join(" ");
        },
        isa = "-mavx -mavx2 -mbmi -mbmi2 -mf16c -mfma -mlzcnt -mmovbe -mpopcnt -msse4.2 -mxsave",
        bin = toMsysPath(`${LLVM_MINGW_I686}/bin`),
        cflags = `${keep(process.env.CFLAGS!)} ${isa} ${legacy ? "-fgnu89-inline -D_FILE_OFFSET_BITS=64" : ""} -fno-strict-aliasing -Wno-error=implicit-function-declaration -Wno-error=int-conversion -Wno-error=incompatible-function-pointer-types -Wno-error=incompatible-pointer-types -Wno-error=implicit-int -DNDEBUG`,
        ldflags = `${keep(process.env.LDFLAGS!)} ${isa}`;

    const extraEnv = `RUBYOPT= PATH="${bin}:$PATH" CC=${triple}-clang CXX=${triple}-clang++ AR=${triple}-ar RANLIB=${triple}-ranlib STRIP=${triple}-strip MAKEFLAGS="LDSHARED=true WINDRES=${triple}-windres DLLWRAP=${toMsysPath(`${ROOT}/patches/ruby/dllwrap.sh`)}" CFLAGS="${cflags}" LDFLAGS="${ldflags}"`;

    if (name === "ruby-1.8.1") {
        replaceInFile(
            `${p}/win32/win32.h`,
            "#ifdef __MINGW32__\nstruct timezone {",
            "#if defined(__MINGW32__) && !defined(_TIMEZONE_DEFINED)\n#define _TIMEZONE_DEFINED\nstruct timezone {",
        );
        replaceInFile(
            `${p}/win32/win32.h`,
            "gettimeofday(struct timeval *, struct timezone *)",
            "gettimeofday(struct timeval *, void *)",
        );
        replaceInFile(
            `${p}/win32/win32.c`,
            "gettimeofday(struct timeval *tv, struct timezone *tz)",
            "gettimeofday(struct timeval *tv, void *tz)",
        );
    }

    if (name === "ruby-1.8.7") {
        replaceInFile(
            `${p}/eval.c`,
            /^#ifdef (CLOCK_(?:MONOTONIC|REALTIME))$/gm,
            "#if defined($1) && !defined(__MINGW32__)",
        );
    }

    if (name === "ruby-1.9.2") {
        replaceInFile(
            `${p}/include/ruby/win32.h`,
            "#define _stati64(path, st) rb_w32_stati64(path, st)",
            "#define _stati64 _stat64\n#define _stat64(path, st) rb_w32_stati64(path, st)",
        );
    }

    await bash`cd ${toMsysPath(p)} && ${extraEnv} ./configure --host=${triple} --disable-install-doc --disable-rubygems --with-out-ext='*' --disable-shared --enable-static ${legacy ? "ac_cv_func_clock_gettime=no" : ""} --prefix=${buildRoot(false)}/${name}`;
    if (name === "ruby-1.8.1") {
        replaceInFile(`${p}/GNUmakefile`, "dllwrap --target=mingw32 --driver-name=$(CC)", "$(DLLWRAP)");
    }

    const zlibDir = `${settings.reposRoot}/zlib-i686`,
        zlibObjs =
            "adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback inffast inflate inftrees trees uncompr zutil",
        initZlib = legacy
            ? 'Init_zlib(); rb_provide("zlib.so"); Init_stringio(); rb_provide("stringio.so");'
            : 'ruby_init_ext("zlib.so", Init_zlib); ruby_init_ext("stringio.so", Init_stringio);',
        encsStep = legacy
            ? "touch enc_protos.inc enc_calls.inc enc_objs.txt"
            : `sh ${toMsysPath(`${ROOT}/patches/ruby/encs.sh`)}`,
        initProto = legacy ? "" : "void ruby_init_ext(const char *name, void (*init)(void));";
    await bash`mkdir -p ${toMsysPath(zlibDir)} && cd ${toMsysPath(zlibDir)} && if [ ! -f libz.a ]; then export PATH="${bin}:$PATH" && curl -fsL -o zlib.tar.gz https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz && tar xf zlib.tar.gz --strip-components=1 && for f in ${zlibObjs}; do ${triple}-clang -O2 -c $f.c -o $f.o || exit 1; done && ${triple}-ar rcs libz.a *.o; fi`;

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
