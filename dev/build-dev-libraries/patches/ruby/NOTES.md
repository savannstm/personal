# Ruby 1.8.x / 1.9.x Windows builds: open notes

Builds: `node dev/build-dev-libraries/index.ts --only ruby-<ver> --only-release --toolchain clang --force`.
Toolchain: llvm-mingw msvcrt-i686 at `C:\PATH\llvm-mingw-msvcrt-i686` (clang 23). Prefix: `C:/dev-clang/release/ruby-<ver>`.

## Status (2026-10-31)

All four build, install, and run (`ruby.exe -v`, `require "set"`, `File.stat`): 1.8.1, 1.8.7p374, 1.9.2p330, 1.9.3p551.

## Fixed: stat crash in 1.8.x

`file.c` includes `missing/file.h` (-> `fcntl.h` -> `sys/stat.h`) before `config.h` defines `_FILE_OFFSET_BITS=64`, so it saw a 36-byte `struct stat` while `win32.c` (`rb_w32_stat`) wrote 48 bytes, smashing `test_e`'s return address. Fix: `-D_FILE_OFFSET_BITS=64` on the command line for all 1.8.x.

## Patches applied in `hooks.ts` (buildRuby / customBuild)

- All Ruby: `RUBYOPT=` cleared (host `-E` breaks old miniruby). Windows-style prefix, direct configure/`make ruby.exe rubyw.exe`/`install-bin install-lib` (not `make install`, which needs the encoding `.so` files that can't link against a static `ruby.exe`).
- Dllwrap stand-in: `patches/ruby/dllwrap.sh` writes an empty COFF object for `--output-exp=`.
- 1.8.x: `-fgnu89-inline` (lex.c `inline` functions need external definitions), `ac_cv_func_clock_gettime=no`.
- 1.8.7: guard `CLOCK_MONOTONIC`/`CLOCK_REALTIME` uses in `eval.c` against mingw's `time.h`.
- 1.8.1: `struct timezone` guard via `_TIMEZONE_DEFINED`; `gettimeofday` prototype/definition use `void *` for the tz argument; `install` (it has no `install-bin`/`install-lib`) and a `GNUmakefile` sed so its hardcoded `dllwrap` becomes the stand-in.
- 1.9.2: `_stati64` macro mapped to `_stat64` in `include/ruby/win32.h`.

## Also

- `--with-out-ext='*'` is ignored by 1.8.x configure (not supported); 1.8.x extensions still build.
