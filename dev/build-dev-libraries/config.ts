import { readFile } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const WIN = process.platform === "win32";
export const SEP = delimiter;
export const ROOT = dirname(fileURLToPath(import.meta.url));
export const LLVM_ROOT = "C:/PATH/llvm"; // installed by install-dev-tools
export const REPOS_ROOT =`${ROOT}/Repos`;
export const BUILD_STATE_FILE = `${ROOT}/build-state.json`;
export const TOOLCHAINS_DIR = `${ROOT}/toolchains`;
export const DEBUG_TOOLCHAIN = `${TOOLCHAINS_DIR}/debug.cmake`;
export const RELEASE_TOOLCHAIN = `${TOOLCHAINS_DIR}/release.cmake`;
export const DEBUG_NATIVE = `${TOOLCHAINS_DIR}/native-debug.ini`;
export const RELEASE_NATIVE = `${TOOLCHAINS_DIR}/native-release.ini`;
export const INJECT_TARGETS = `${TOOLCHAINS_DIR}/inject-targets.cmake`;
export let DBG_ROOT = WIN ? "C:/dev/debug" : "/usr/local/debug";
export let REL_ROOT = WIN ? "C:/dev/release" : "/usr/local/release";
export const ICU_DATA_FILTERS = await readFile(`${ROOT}/patches/filters.json`, "utf8");

export function setPrefix(prefix: string): void {
    DBG_ROOT = `${prefix}/debug`;
    REL_ROOT = `${prefix}/release`;
}

export function buildRoot(isDebug: boolean): string {
    return isDebug ? DBG_ROOT : REL_ROOT;
}

export function buildDir(isDebug: boolean): string {
    return isDebug ? "debug" : "release";
}
