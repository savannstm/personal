import { readFile } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SEP = delimiter;
export const ROOT = dirname(fileURLToPath(import.meta.url)).replaceAll("\\", "/");
export const LLVM_ROOT = "C:/LLVM";
export const MSVC_LLVM_ROOT = "C:/PATH/llvm";
export const LLVM_MINGW_I686 = "C:/PATH/llvm-mingw-msvcrt-i686";
export const MSYS2_ROOT = "C:/msys64";
export const CLANG64 = `${MSYS2_ROOT}/clang64`;
export const CLANG64_PKG_CONFIG = `${CLANG64}/lib/pkgconfig;${CLANG64}/share/pkgconfig`;
export const WIN_TAR = "C:/Windows/System32/tar.exe";
export const VSWHERE = "C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe";
export const DEV_CLANG = "C:/dev-clang";
export const BUILD_STATE_FILE = `${ROOT}/build-state.json`;
export const LLVM_PGO_DIR = `${ROOT}/pgo/llvm`;
export const LLVM_TABLEGEN_DIR = `${ROOT}/tablegen/llvm`;
export const LIBS_PGO_DIR = `${ROOT}/pgo/libs`;
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

export const PGO_TARGETS = ["clang", "lld", "libs"] as const;
export type PgoTarget = (typeof PGO_TARGETS)[number];
export type LlvmTarget = Exclude<PgoTarget, "libs">;

export type LibsPgoMode = "gen" | "use" | null;

export interface MagickVariant {
    depth: number;
    hdri: boolean;
}

export const MAGICK_PGO_VARIANT: MagickVariant = { depth: 16, hdri: true };

export function magickSuffix({ depth, hdri }: MagickVariant): string {
    return `Q${depth}${hdri ? "HDRI" : ""}`;
}

export const settings = {
    prefix: "C:/dev",
    reposRoot: `${ROOT}/Repos`,
    pgo: new Set<PgoTarget>(PGO_TARGETS) as ReadonlySet<PgoTarget>,
    pgoTraining: false,
    pgoIrOnly: false,
    libsPgo: null as LibsPgoMode,
    libsProfdata: "",
    llvmProfdata: "",
    llvmIrProfdata: {} as Partial<Record<LlvmTarget, string>>,
    magickVariants: [] as MagickVariant[],
    ffmpegVariants: [] as string[],
};

export function buildRoot(isDebug: boolean): string {
    return `${settings.prefix}/${buildDir(isDebug)}`;
}

export function buildDir(isDebug: boolean): string {
    return isDebug ? "debug" : "release";
}

export function llvmTargets(): LlvmTarget[] {
    return PGO_TARGETS.filter((target): target is LlvmTarget => target !== "libs" && settings.pgo.has(target));
}

export function llvmPgo(): boolean {
    return settings.pgo.has("clang") || settings.pgo.has("lld");
}
