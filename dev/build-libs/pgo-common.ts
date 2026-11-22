import { readdirSync, rmSync } from "node:fs";

import { MAGICK_PGO_VARIANT, magickSuffix, PROFILES_DIR, settings } from "./settings.ts";

// Thrown by a library hook once a training run has produced its profile: the build itself is skipped.
export class TrainingDone extends Error {}

export const MAGICK_DEFINES = [
    `-DMAGICKCORE_HDRI_ENABLE=${MAGICK_PGO_VARIANT.hdri ? 1 : 0}`,
    `-DMAGICKCORE_QUANTUM_DEPTH=${MAGICK_PGO_VARIANT.depth}`,
    "-DMAGICKCORE_CHANNEL_MASK_DEPTH=32",
];

export const MAGICK_CODEC_LIBS = ["rav1e", "openh264", "userenv", "dbghelp"];

export const PGO_SYSTEM_LIBS = [
    "advapi32",
    "user32",
    "ole32",
    "cfgmgr32",
    "bcrypt",
    "urlmon",
    "ws2_32",
    "synchronization",
    "ntdll",
    "c++",
    "pthread",
    "omp",
    "m",
    "clang_rt.builtins-x86_64",
].map((name) => `-l${name}`);

export function releaseArchives(lib: string, skip: string[] = []): string[] {
    const otherVariants = settings.magickVariants
            .map(magickSuffix)
            .filter((suffix) => suffix !== magickSuffix(MAGICK_PGO_VARIANT))
            .map((suffix) => String.raw`\.${suffix}\.`),
        exclude = new RegExp(
            [...otherVariants, ...skip, String.raw`Magick\+\+`, String.raw`\.dll\.a$`, "OpenCL"].join("|"),
        );
    return readdirSync(lib)
        .filter((file) => file.endsWith(".a") && !exclude.test(file))
        .map((file) => `${lib}/${file}`);
}

export function removeStaleProfiles(current: string, prefix: string) {
    for (const file of readdirSync(PROFILES_DIR)) {
        if (file.startsWith(prefix) && file.endsWith(".profdata") && `${PROFILES_DIR}/${file}` !== current) {
            rmSync(`${PROFILES_DIR}/${file}`);
        }
    }
}

export function profraws(dir: string): string[] {
    return readdirSync(dir).filter((file) => file.endsWith(".profraw")).map((file) => `${dir}/${file}`);
}
