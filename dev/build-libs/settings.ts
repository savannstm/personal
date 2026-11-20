import { readFile } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const WIN = process.platform === "win32";
export const SEP = delimiter;
export const ROOT = dirname(fileURLToPath(import.meta.url)).replaceAll("\\", "/");
export const LLVM_ROOT = "C:/LLVM"; // the clang the toolchains build with: bin, lib/clang/<major> (compiler-rt)
export const LLVM_MINGW_I686 = "C:/PATH/llvm-mingw-msvcrt-i686"; // manual install of mstorsjo/llvm-mingw msvcrt-i686, Ruby builds only
export const MSYS2_ROOT = "C:/msys64";
export const CLANG64 = `${MSYS2_ROOT}/clang64`; // the clang that bootstraps ours, and the packages used in place of libraries clang doesn't build
export const CLANG64_PKG_CONFIG = `${CLANG64}/lib/pkgconfig;${CLANG64}/share/pkgconfig`;
export const WIN_TAR = "C:/Windows/System32/tar.exe"; // the bsdtar bundled with Windows: extracts .zip as well as .tar.*
export const VSWHERE = "C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe";
export const DEV_CLANG = "C:/dev-clang"; // the clang target's install prefix, which llvm-project is built against
export const BUILD_STATE_FILE = `${ROOT}/build-state.json`;
export const LLVM_PGO_DIR = `${ROOT}/pgo/llvm`;
export const LLVM_TABLEGEN_DIR = `${ROOT}/tablegen/llvm`;
export const LIBS_PGO_DIR = `${ROOT}/pgo/libs`;
// The trained profiles, named after the key of everything they were trained from (see resolvePgoProfiles in pgo.ts).
export const PROFILES_DIR = `${ROOT}/pgo/profiles`;
export const TOOLCHAINS_DIR = `${ROOT}/toolchains`;
export const DEBUG_TOOLCHAIN = `${TOOLCHAINS_DIR}/debug.cmake`;
export const RELEASE_TOOLCHAIN = `${TOOLCHAINS_DIR}/release.cmake`;
export const DEBUG_NATIVE = `${TOOLCHAINS_DIR}/native-debug.ini`;
export const RELEASE_NATIVE = `${TOOLCHAINS_DIR}/native-release.ini`;
export const INJECT_TARGETS = `${TOOLCHAINS_DIR}/inject-targets.cmake`;
export const DEBUG_FFMPEG_ROOT = `${TOOLCHAINS_DIR}/ffmpeg-root-debug.cmake`;
export const RELEASE_FFMPEG_ROOT = `${TOOLCHAINS_DIR}/ffmpeg-root-release.cmake`;
export const ICU_DATA_FILTERS = await readFile(`${ROOT}/patches/filters.json`, "utf8");

// clang/lld: what llvm-project's profile is trained on (lld links ImageMagick, so it needs the libraries built). libs: the PGO pipeline for the libraries with trainers in patches/pgo.
export const PGO_TARGETS = ["clang", "lld", "libs"] as const;
export type PgoTarget = (typeof PGO_TARGETS)[number];

// Library PGO: "gen" builds the trained libraries instrumented, "use" builds it with the merged profile, null is a normal build.
export type LibsPgoMode = "gen" | "use" | null;

export interface MagickVariant {
    depth: number;
    hdri: boolean;
}

/** The suffix ImageMagick gives the variant's libraries, e.g. `MagickCore-7.Q16HDRI`. */
export function magickSuffix({ depth, hdri }: MagickVariant): string {
    return `Q${depth}${hdri ? "HDRI" : ""}`;
}

/** The whole mutable state of a run. Set from the CLI in index.ts; only the library PGO pipeline changes it afterwards. */
export const settings = {
    // Install prefix: libraries go to `${prefix}/debug` and `${prefix}/release`.
    prefix: WIN ? "C:/dev" : "/usr/local",
    reposRoot: `${ROOT}/Repos`,
    pgo: new Set<PgoTarget>(PGO_TARGETS) as ReadonlySet<PgoTarget>,
    // Training run: profiling builds without -flto, and the profiles get written. Otherwise the cached profiles are only read.
    pgoTraining: false,
    libsPgo: null as LibsPgoMode,
    // This run's profiles, keyed by its sources and compiler (resolvePgoProfiles); empty until resolved.
    libsProfdata: "",
    llvmProfdata: "",
    magickVariants: [] as MagickVariant[],
    ffmpegVariants: [] as string[],
};

export function buildRoot(isDebug: boolean): string {
    return `${settings.prefix}/${buildDir(isDebug)}`;
}

export function buildDir(isDebug: boolean): string {
    return isDebug ? "debug" : "release";
}

export function llvmPgo(): boolean {
    return settings.pgo.has("clang") || settings.pgo.has("lld");
}
