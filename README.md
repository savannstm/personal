# things

Personal scripts and dev tooling, Deno/TypeScript-first.

## Layout

- `personal/` — personal scripts. Not meant to be general-purpose; read the top-of-file comment in each before running.
    - `convert-to-jxl.ts` — recursively transcodes a directory of images to JPEG XL, copying anything it can't convert.
    - `convert-to-hevc.ts` — batch re-encodes MKVs to HEVC via NVENC.
    - `gif-to-avif.ts` — batch-converts GIFs to AVIF.
- `dev/` — toolchain setup and library-building tooling.
    - `set-env.ts` — prints the PATH/INCLUDE/LIB/rustup env commands needed to compile with a given toolchain (`--toolchain msvc|clang|clang-ucrt`) in the current shell.
    - `install-devel.ts` — downloads/installs pinned dev tool releases from GitHub into a local install dir.
    - `build-ucrt64-asan.sh` — builds a MinGW/UCRT64-compatible ASan runtime from an LLVM checkout.
    - `build-dev-libraries/` — builds a large stack of third-party C/C++ libraries from source (see below).
- `configs/`, `.vscode/`, `eslint.config.ts`, `tsconfig.json`, `.prettierrc` — shared editor/lint/format config for this repo.

## Adapting `dev/build-dev-libraries/`

This builds ~40 pinned libraries (zlib, libjpeg-turbo, FFmpeg, Qt, etc.) in dependency order, in both debug and release variants. To point it at your own machine/library set:

- **Library list & versions**: [`libraries.ts`](dev/build-dev-libraries/libraries.ts) — the `LIBRARIES` array. Add/remove entries here; order matters (grouped in dependency tiers, top to bottom). Each entry needs a `url` (repo or archive) and a `tag`; use `build: "Custom" | "Meson"` when a library doesn't use plain CMake, `sourceSubdir` when the CMake root isn't the repo root, and `archiveSubdir`/`name` for zip-distributed libs.
- **Install paths / repo cache**: [`config.ts`](dev/build-dev-libraries/config.ts) — `REPOS_ROOT` (where sources are cloned), `DBG_ROOT`/`REL_ROOT` (install prefixes, overridable at runtime with `--prefix`), and the toolchain file paths.
- **Toolchain/environment detection**: [`index.ts`](dev/build-dev-libraries/index.ts) — `setupToolchainEnv` hardcodes Windows paths (`C:/msys64`, Visual Studio via `vswhere`, `C:/Program Files/LLVM`). If your MSYS2/VS/LLVM install lives elsewhere, edit the paths there. `REQUIRED_UTILITIES`/`BASE_PACKAGES`/`MINGW_PACKAGES` control what's checked/installed via pacman — adjust if you need different packages.
- **CMake/Meson invocation & patches**: [`build-runner.ts`](dev/build-dev-libraries/build-runner.ts) and [`toolchain.ts`](dev/build-dev-libraries/toolchain.ts) drive the actual per-library build; `patches/` holds source patches applied to specific libraries before building (named or matched by the build runner — check there if a library needs a new patch).
- **Custom build steps**: [`hooks.ts`](dev/build-dev-libraries/hooks.ts) — per-library pre/post-build hooks for libraries that need special handling beyond CMake/Meson defaults (ICU, FFmpeg, ImageMagick, Qt, etc.). Add a hook here if a new library needs custom configure flags or steps.

Run with `deno -A dev/build-dev-libraries/index.ts --toolchain <clang|clang-ucrt|msvc> [--only <names>] [--exclude <names>] [--prefix <path>]`.
