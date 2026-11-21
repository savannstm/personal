import $ from "dax";

import { buildRoot, LLVM_MINGW_I686, ROOT, settings } from "./settings.ts";
import { bash, toMsysPath } from "./shell.ts";
import type { Library } from "./types.ts";

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
    const legacy = name.startsWith("ruby-1.8"),
        triple = "i686-w64-mingw32",
        x64Flag = /^(-march=|-mtune=|--target=|-fopenmp|-static-openmp|-l|-L)/,
        keep = (flags: string) =>
            flags
                .split(" ")
                .filter((flag) => !x64Flag.test(flag))
                .join(" "),
        isa = "-mavx -mavx2 -mbmi -mbmi2 -mf16c -mfma -mlzcnt -mmovbe -mpopcnt -msse4.2 -mxsave",
        bin = toMsysPath(`${LLVM_MINGW_I686}/bin`),
        cflags = `${keep(process.env.CFLAGS!)} ${isa} ${legacy ? "-fgnu89-inline -D_FILE_OFFSET_BITS=64" : ""} -fno-strict-aliasing -Wno-error=implicit-function-declaration -Wno-error=int-conversion -Wno-error=incompatible-function-pointer-types -Wno-error=incompatible-pointer-types -Wno-error=implicit-int -DNDEBUG`,
        ldflags = `${keep(process.env.LDFLAGS!)} ${isa}`;

    const extraEnv = `RUBYOPT= PATH="${bin}:$PATH" CC=${triple}-clang CXX=${triple}-clang++ AR=${triple}-ar RANLIB=${triple}-ranlib STRIP=${triple}-strip MAKEFLAGS="LDSHARED=true WINDRES=${triple}-windres DLLWRAP=${toMsysPath(`${ROOT}/patches/ruby/dllwrap.sh`)}" CFLAGS="${cflags}" LDFLAGS="${ldflags}"`;

    if (name === "ruby-1.8.1") {
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
        await $`sd -f m '^#ifdef (CLOCK_(?:MONOTONIC|REALTIME))$' '#if defined($1) && !defined(__MINGW32__)' eval.c`.cwd(
            p,
        );
    }

    if (name === "ruby-1.9.2") {
        await $`sd -s '#define _stati64(path, st) rb_w32_stati64(path, st)' '#define _stati64 _stat64\n#define _stat64(path, st) rb_w32_stati64(path, st)' include/ruby/win32.h`.cwd(
            p,
        );
    }

    await bash`cd ${toMsysPath(p)} && ${extraEnv} ./configure --host=${triple} --disable-install-doc --disable-rubygems --with-out-ext='*' --disable-shared --enable-static ${legacy ? "ac_cv_func_clock_gettime=no" : ""} --prefix=${buildRoot(false)}/${name}`;
    if (name === "ruby-1.8.1") {
        await $`sd -s 'dllwrap --target=mingw32 --driver-name=$(CC)' '$(DLLWRAP)' GNUmakefile`.cwd(p);
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
