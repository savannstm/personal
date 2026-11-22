import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Toolchain } from "./types.ts";

export const ROOT = dirname(fileURLToPath(import.meta.url)).replaceAll("\\", "/");
export const MSYS2_ROOT = "C:/msys64";
export const CLANG64 = `${MSYS2_ROOT}/clang64`;
export const CLANG64_PKG_CONFIG = `${CLANG64}/lib/pkgconfig;${CLANG64}/share/pkgconfig`;
export const WIN_TAR = "C:/Windows/System32/tar.exe";
export const VSWHERE = "C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe";
export const PROFILES_DIR = `${ROOT}/pgo/profiles`;
export const TOOLCHAINS_DIR = `${ROOT}/toolchains`;

export const PGO_TARGETS = ["clang", "lld", "libs"] as const;
export type PgoTarget = (typeof PGO_TARGETS)[number];
export type LlvmTarget = Exclude<PgoTarget, "libs">;

type LibsPgoMode = "gen" | "use" | null;

export interface MagickVariant {
    depth: number;
    hdri: boolean;
}

export const MAGICK_PGO_VARIANT: MagickVariant = { depth: 16, hdri: true };

export function magickSuffix({ depth, hdri }: MagickVariant): string {
    return `Q${depth}${hdri ? "HDRI" : ""}`;
}

export const settings = {
    toolchain: "clang" as Toolchain,
    exclude: new Set<string>(),
    force: false,
    genToolchains: false,
    only: null as null | Set<string>,
    onlyDebug: false,
    onlyRelease: false,
    prefix: "",
    reposRoot: "",
    pgo: new Set<PgoTarget>(PGO_TARGETS) as ReadonlySet<PgoTarget>,
    pgoTraining: false,
    pgoIrOnly: false,
    libsPgo: null as LibsPgoMode,
    libsProfdata: "",
    libsIrProfdata: "", // set during the context-sensitive stage: the library builds apply the IR profile, the final one doesn't exist yet
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
