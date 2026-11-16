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
    - `build-libs/` - builds a large stack of third-party C/C++ libraries from source (see below).
- `configs/`, `.vscode/`, `eslint.config.ts`, `tsconfig.json`, `.prettierrc` - shared editor/lint/format config for this repo.

## Adapting `dev/build-libs/`

This builds ~40 pinned libraries (zlib, libjpeg-turbo, FFmpeg, Qt, etc.) in dependency order, in both debug and release variants. To point it at your own machine/library set:

- **Libraries**: [`libraries.ts`](dev/build-libs/libraries.ts) - the `LIBRARIES` array, in build order (a library comes after everything it links). Each library is one record holding all of its configuration: `source` (git `tag` or `archive`), `build` (CMake by default, `"meson"`, `"rust"`, or a function for a custom build), `profile` (overrides of `DEFAULT_PROFILE`: ASan, RTTI, `debugOpt`, ...), `msys2` (the CLANG64 package used instead on clang), `args` (configure arguments), `prepare` (source patches, once per checkout) and `finish` (per-variant fixups after install). The fields are documented on the `Library` type in [`types.ts`](dev/build-libs/types.ts); `patches/` holds the patch files the hooks apply.
- **Which libraries get built**: `skipReason` in [`runner.ts`](dev/build-libs/runner.ts). On clang, `debugOpt` dependency libraries come from their CLANG64 packages unless `--only-release` is passed (the ImageMagick PGO chain does), so a full clang run builds only the apps (md4c, projectM, FLTK, FFmpeg, ImageMagick, Qt, LLVM).
- **Paths and run settings**: [`settings.ts`](dev/build-libs/settings.ts) - the fixed paths (`C:/msys64`, `C:/PATH/llvm`, vswhere, toolchain files) and the `settings` object (install prefix: `C:/dev-<toolchain>` on Windows, sources in `C:/Repos-<toolchain>`, overridable with `--prefix`/`--repos`).
- **Host environment**: [`host.ts`](dev/build-libs/host.ts) - toolchain environment (MSYS2/VS/LLVM), required utilities and the pacman packages.
- **Compiler flags and toolchain files**: [`toolchain.ts`](dev/build-libs/toolchain.ts); the generic CMake/Meson/cargo/autotools drivers are in [`builders.ts`](dev/build-libs/builders.ts).
- **PGO**: [`pgo.ts`](dev/build-libs/pgo.ts) - two pipelines, each an IR profile plus a context-sensitive one trained on a full-LTO link:
    - `--pgo libs`: the `TRAINERS` in `pgo.ts`, whose programs are in [`patches/pgo/`](dev/build-libs/patches/pgo): ImageMagick and its chain, harfbuzz/freetype (text shaping and rasterization), quickjs (text-processing scripts), nuspell (spell-checking and suggestions with the pinned en/ru dictionaries) and libarchive/liblzma (LZMA zips). Their libraries are built release-only into the prefix with one merged profile; each trainer's counts are weighted to the same total so that short workloads don't look cold next to long ones.
    - `--pgo clang,lld`: llvm-project's training on compiling clang and linking ImageMagick.

    The context-sensitive part applies at the final LTO link, so the generated release toolchain files pass the library profile to your projects' links (clang only, once the profile exists).

    Profiles live in `pgo/profiles/`, named after a key of everything they're trained from: the trained libraries' pins, configure arguments and patches, the trainers (or LLVM's training code), `toolchain.ts`/`builders.ts`, and CLANG64's clang version. A changed input means a new key: the old profile is never applied, `--pgo-train` trains only the profiles missing for the current key, and libraries built with a profile record its content hash in `build-state.json`, so a new profile rebuilds them. `--print-pgo-keys` prints the profile names; CI caches the profiles under them and trains only on a cache miss (or with the `retrain` input).

Run with `node dev/build-libs/index.ts --toolchain <clang|msvc> [--only <names>] [--exclude <names>] [--prefix <path>]`. `--magick-variants` (default `q8,q16hdri`) and `--ffmpeg-variants` (default `rap,trap,rpgmtranslate,vu`) choose the ImageMagick and FFmpeg builds.
