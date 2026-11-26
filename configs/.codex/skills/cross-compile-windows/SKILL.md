---
name: cross-compile-windows
description: Configure, build and run Windows binaries (CMake + Ninja, optionally Rust via Corrosion, optionally tests and coverage under wine) from this Linux machine using the system Clang/LLVM and the MSYS2 CLANG64 sysroot on the Windows partition. Use whenever the user wants a Windows build, Windows test run or Windows coverage from Linux, or mentions wine, CLANG64 or the msys64 sysroot.
---

# Cross-compile Windows from Linux

Compiler and tools: system Clang/LLVM (`/usr/sbin`). Libraries and headers: MSYS2 CLANG64 at `/mnt/windows/msys64/clang64` (the only toolchain installed there). Paths are hardcoded in `clang64.cmake`; if a path is gone, stop and report. Build test targets only (no full app build).

Files (this skill's directory, `<skill-dir>`): `clang64.cmake` (toolchain), `wine.sh` (ctest emulator). Reference them in place; do not copy into `/tmp`.

## Configure

```
PKG_CONFIG_SYSROOT_DIR=/mnt/windows/msys64 \
PKG_CONFIG_LIBDIR=/mnt/windows/msys64/clang64/lib/pkgconfig:/mnt/windows/msys64/clang64/share/pkgconfig \
cmake -G Ninja -S <repo> -B ~/.cache/<name>-win -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_TOOLCHAIN_FILE=<skill-dir>/clang64.cmake
```

`PKG_CONFIG_SYSROOT_DIR` is the msys64 root, not `clang64`. Build-time helper programs (lua, magick, ...) are taken from the host. Build dirs go under `~/.cache`, not the repo.

## Known gotchas

- **Debug + Rust no_std staticlib:** the staticlib references `rust_eh_personality` and nothing defines it; `--allow-multiple-definition` does not help and lld's MinGW driver rejects `--defsym`. Define an empty `rust_eh_personality` in a small C static library and link it into the final targets.
- **Rust cdylib under Corrosion:** needs `RUSTFLAGS` link arguments pointing at the sysroot, lld and compiler-rt, and empty stub `libgcc.a` / `libgcc_s.a` archives on the link path. The built `.dll` lands in the build root; that directory must be on `WINEPATH` (`wine.sh` does this when `WINE_BUILD_DIR` is set to the build root, so export it before running ctest).
- **ctest discovery:** `gtest_discover_tests` defaults to a 5 s discovery timeout, too short under wine + xvfb; pass `DISCOVERY_TIMEOUT 120` per call (the `CMAKE_GTEST_DISCOVERY_TIMEOUT` variable did not take effect). Give tests a longer timeout (900 s) when `CMAKE_CROSSCOMPILING_EMULATOR` is set.
- **If CMake cannot re-run** (toolchain file moved), `ninja -t commands <target>` gives the compile and link lines to run by hand.

## Run under wine

- Use `xvfb-run` (done by `wine.sh`). Default `~/.wine` prefix is fine; do not modify it. A scratch prefix with a virtual desktop is acceptable for crash isolation.
- GUI tests are slow (~30 s each) and crash with the wine X driver `BadWindow` error under parallel load. Run `ctest -j4`, then `ctest --rerun-failed -j1`; count a test as unverified if it only fails under load and was not rerun serially.
- A crashed process writes no coverage data.

## Coverage

Add `-fprofile-instr-generate -fcoverage-mapping` to the compile flags and `-fprofile-instr-generate` to the link flags (the linker line already has `-rtlib=compiler-rt`). The Windows profile runtime is `msys64/clang64/lib/clang/<ver>/lib/windows/libclang_rt.profile-x86_64.a`; the Linux Clang has none. Set `LLVM_PROFILE_FILE` (per-process `%p` pattern), merge with the Linux `llvm-profdata`, report with the Linux `llvm-cov` pointed at the `.exe`/`.dll` files. Expect "mismatched data" warnings for some inline functions: counts for those may be low.
