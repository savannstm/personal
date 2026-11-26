# build-libs tests

Compile, link and run checks against the artifacts of a `build-libs` CI run, installed on this machine.

## Install a run's artifacts

Remove the previous install first (`C:/LLVM`, `C:/dev-clang`), then download into an empty directory:

```sh
gh run download <run-id> -D <empty-dir>
```

| Artifact                                                 | Destination                            |
| -------------------------------------------------------- | -------------------------------------- |
| `llvm-bin-*/release/*` (includes the `llvm-rt` runtimes) | `C:/LLVM/`                             |
| `libs-*/debug`, `libs-*/release`                         | `C:/dev-clang/`                        |
| `ruby-<version>-*`                                       | `C:/dev-clang/release/ruby-<version>/` |
| `cargo-tools-*/*.exe`                                    | `C:/PATH/bin/`                         |

## Run

```sh
node dev/build-libs/tests/run.ts              # every suite, ruby-bench last
node dev/build-libs/tests/run.ts smoke libs   # some suites
node dev/build-libs/tests/compiler.ts lto     # one suite, filtered by name
```

Each suite sets up its environment from `dev/set-env.ts` and works in `%TEMP%/build-libs-tests/<suite>`.

| Suite        | Checks                                                                                       | Arguments                                         |
| ------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `smoke`      | every tool and Ruby starts; Ruby raises                                                      |                                                   |
| `compiler`   | C/C++ standards, LTO, PGO, sanitizers, coverage, OpenMP, modules, PCH, DLLs, binutils, CMake | `[name-regex]`                                    |
| `rust`       | rustc with our clang/lld: cargo profiles, C/C++/CMake dependencies, FFI                      |                                                   |
| `allocator`  | the rpmalloc patch, in a stress program (needs llvm-project sources)                         | `[llvm-dir]`                                      |
| `jumps`      | Ruby's `__builtin_setjmp` patch, in a stress program                                         |                                                   |
| `libs`       | every pkg-config package links and runs, plain and with the consumer toolchain flags         | `[plain\|consumer] [release\|debug] [name-regex]` |
| `cmake`      | every CMake package through `find_package` with the consumer toolchain files                 | `[release\|debug] [name-regex]`                   |
| `ruby-bench` | CI Rubies against the installed ones in `C:/PATH`                                            | `[rounds] [version-regex] [ruby-micro.rb]`        |

Requirements: MSYS2 CLANG64 with the build-libs packages; the nightly `gnullvm` and `msvc` Rust toolchains with the profiles of
`configs/config.toml` in `~/.cargo/config.toml`. `libs consumer release` links with full LTO and takes about half an hour.

## Results that are expected

- Failures upstream also has are written as expected: libFuzzer is not offered on MinGW, context-sensitive PGO with LTO does
  not link, `harfbuzz-subset` is not whole-archived next to `harfbuzz`.
- `compiler`'s precompiled header and module cases crash with a clang built before `llvm-rpmalloc-mingw.patch`.
- Packages without an API call in `libs.ts` (Qt `.pc` files, headers-only ones) are only linked, and say so.
