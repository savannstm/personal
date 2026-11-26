# things

Personal scripts and dev tooling.

You can see the personal scripts at `personal/` and the scripts that build a bunch of C/C++ development libraries at `dev/build-libs`. You're probably interested in the latter one.

`dev/build-libs` scripts build ~40 development libraries I use in my projects in two variants: with the flags for best debugging, and with the flags for best performance. The libraries are also PGOed, LTOed, and any issues that block compilation on specific toolchains (e.g. MSVC) are patched.

- **Build**: `node dev/build-libs/index.ts --toolchain <clang|msvc> [--only <names>] [--exclude <names>] [--prefix <path>]`. Supported toolchains are `clang` (CLANG64 for Windows, system-vendored for Linux) and `msvc`.
- **Test**: `node dev/build-libs/tests/run.ts` compiles, links and runs against an installed CI run; see [`dev/build-libs/tests`](dev/build-libs/tests/README.md).
- **Adapt**: edit `libraries.ts` (the `LIBRARIES` array, in build order, one record per library), `settings.ts` (paths and install prefix), `toolchain.ts` (compiler flags and toolchain files), and `host.ts` (required tools and packages).
