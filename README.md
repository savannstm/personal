# things

Personal scripts and dev tooling, Node/TypeScript-first.

## Layout

- `personal/` - personal scripts. Not meant to be general-purpose; read the top-of-file comment in each before running.
    - `convert-to-jxl.ts` - recursively transcodes a directory of images to JPEG XL, copying anything it can't convert.
    - `convert-to-hevc.ts` - batch re-encodes MKVs to HEVC via NVENC.
    - `gif-to-avif.ts` - batch-converts GIFs to AVIF.
- `dev/` - toolchain setup and library-building tooling.
    - `set-env.ts` - prints the commands that set up the whole C/C++ toolchain (PATH, INCLUDE/LIB, CMake variables, rustup default) for `--toolchain msvc|clang` in the current shell. No C/C++ tool is on the global PATH or in the machine environment; `personal/install-tools/toolchain.ts` is the shared list of where they live.
- `personal/install-tools/` - installs the dev and personal tools on Windows: `node personal/install-tools/index.ts --toolchain clang|msvc` (or `bootstrap.ps1`). `clang` installs the C/C++ dev tools from MSYS2's CLANG64; `msvc` leaves MSYS2 untouched and uses GitHub archives plus VS Build Tools; without the flag both are installed. Everything installs under `C:\PATH` where the program allows it, except MSYS2 (`C:\msys64`), Steam, VS Build Tools and the .NET/VC++/DirectX runtimes (their default locations) and Discord. `--clear [--yes]` removes it all again through the programs' own uninstallers, keeping user settings and the configs.
    - `install-devel.ts` - downloads/installs pinned dev tool releases from GitHub into a local install dir.
    - `build-dev-libraries/` - builds a large stack of third-party C/C++ libraries from source (see below).
- `configs/`, `.vscode/`, `eslint.config.ts`, `tsconfig.json`, `.prettierrc` - shared editor/lint/format config for this repo.

## Adapting `dev/build-dev-libraries/`

This builds ~40 pinned libraries (zlib, libjpeg-turbo, FFmpeg, Qt, etc.) in dependency order, in both debug and release variants. To point it at your own machine/library set:

- **Library list & versions**: [`libraries.ts`](dev/build-dev-libraries/libraries.ts) - the `LIBRARIES` array. Add/remove entries here; order matters (grouped in dependency tiers, top to bottom). Each entry needs a `url` (repo or archive) and a `tag`; use `build: "Custom" | "Meson"` when a library doesn't use plain CMake, `sourceSubdir` when the CMake root isn't the repo root, and `archiveSubdir`/`name` for zip-distributed libs.
- **Install paths / repo cache**: [`config.ts`](dev/build-dev-libraries/config.ts) - `REPOS_ROOT` (where sources are cloned), `DBG_ROOT`/`REL_ROOT` (install prefixes, overridable at runtime with `--prefix`), and the toolchain file paths.
- **Toolchain/environment detection**: [`index.ts`](dev/build-dev-libraries/index.ts) - `setupToolchainEnv` hardcodes Windows paths (`C:/msys64`, `C:/PATH/llvm`, Visual Studio via `vswhere`). If your MSYS2/VS/LLVM install lives elsewhere, edit the paths there. `REQUIRED_UTILITIES`/`BASE_PACKAGES`/`MINGW_PACKAGES` control what's checked/installed via pacman - adjust if you need different packages.
- **CMake/Meson invocation & patches**: [`build-runner.ts`](dev/build-dev-libraries/build-runner.ts) and [`toolchain.ts`](dev/build-dev-libraries/toolchain.ts) drive the actual per-library build; `patches/` holds source patches applied to specific libraries before building (named or matched by the build runner - check there if a library needs a new patch).
- **Custom build steps**: [`hooks.ts`](dev/build-dev-libraries/hooks.ts) - per-library pre/post-build hooks for libraries that need special handling beyond CMake/Meson defaults (ICU, FFmpeg, ImageMagick, Qt, etc.). Add a hook here if a new library needs custom configure flags or steps.

Run with `node dev/build-dev-libraries/index.ts --toolchain <clang|msvc> [--only <names>] [--exclude <names>] [--prefix <path>]`.
