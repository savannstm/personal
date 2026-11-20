import $ from "dax";

import { buildRoot, LLVM_MINGW_I686, ROOT, settings } from "./settings.ts";
import { bash, toMsysPath } from "./shell.ts";
import type { Library } from "./types.ts";

/**
 * Ruby 1.8/1.9 predate 64-bit Windows (their win32 port assumes a 32-bit `long` and MSVCRT internals), so they build
 * with the manually installed llvm-mingw i686 toolchain instead of clang64. Release only, installed to `${prefix}/release/<name>`.
 */
export function ruby(name: string, archive: string, version: string): Library {
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
        await $`sd -s '#ifdef __MINGW32__\nstruct timezone {' '#if defined(__MINGW32__) && !defined(_TIMEZONE_DEFINED)\n#define _TIMEZONE_DEFINED\nstruct timezone {' win32/win32.h`.cwd(
            p,
        );
        await $`sd -s 'gettimeofday(struct timeval *, struct timezone *)' 'gettimeofday(struct timeval *, void *)' win32/win32.h`.cwd(
            p,
        );
        await $`sd -s 'gettimeofday(struct timeval *tv, struct timezone *tz)' 'gettimeofday(struct timeval *tv, void *tz)' win32/win32.c`.cwd(
            p,
        );
    }

    if (name === "ruby-1.8.7") {
        // mingw's time.h defines CLOCK_MONOTONIC/CLOCK_REALTIME and calls `_clock_gettime32`, which msvcrt doesn't export.
        await $`sd -f m '^#ifdef (CLOCK_(?:MONOTONIC|REALTIME))$' '#if defined($1) && !defined(__MINGW32__)' eval.c`.cwd(
            p,
        );
    }

    if (name === "ruby-1.9.2") {
        // MinGW's msvcrt headers have no `struct _stati64`; Ruby's win32.h only maps it by a function-like macro, which
        // leaves the struct tag unresolved. Map it to `_stat64` (MinGW's struct) and keep the wrapper on `_stat64`.
        await $`sd -s '#define _stati64(path, st) rb_w32_stati64(path, st)' '#define _stati64 _stat64\n#define _stat64(path, st) rb_w32_stati64(path, st)' include/ruby/win32.h`.cwd(
            p,
        );
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
