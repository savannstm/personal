import { Command, Option } from "commander";
import consola from "consola";
import { $ } from "dax";
import { basename, resolve } from "node:path";
import { exit } from "node:process";
import pc from "picocolors";

import { checkLibraryUpdates } from "./check-updates.ts";
import { installToolchainPackages, setupToolchainEnv, verifyPrerequisites } from "./host.ts";
import { FFMPEG_VARIANTS } from "./ffmpeg.ts";
import { LIBRARIES } from "./libraries.ts";
import { libsPgo, resolvePgoProfiles } from "./pgo.ts";
import { buildRepos } from "./runner.ts";
import {
    llvmPgo,
    llvmTargets,
    MAGICK_PGO_VARIANT,
    magickSuffix,
    type MagickVariant,
    PGO_TARGETS,
    type PgoTarget,
    settings,
} from "./settings.ts";
import { configureToolchain, CONSUMER_PROFILE, TOOLCHAINS } from "./toolchain.ts";
import type { Toolchain } from "./types.ts";

function splitList(value: string | undefined): string[] {
    return (value ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function parseMagickVariants(value: string): MagickVariant[] {
    return splitList(value).map((variant) => {
        const match = /^q(8|16|32)(hdri)?$/.exec(variant);
        if (!match) {
            throw new Error(
                `Invalid --magick-variants entry "${variant}". Expected q8, q16, q32, optionally with hdri (e.g. q16hdri).`,
            );
        }
        return { depth: Number(match[1]), hdri: Boolean(match[2]) };
    });
}

function parseFfmpegVariants(value: string): string[] {
    const variants = splitList(value),
        invalid = variants.filter((variant) => !(variant in FFMPEG_VARIANTS));
    if (invalid.length > 0) {
        throw new Error(
            `Invalid --ffmpeg-variants "${invalid.join(", ")}". Valid variants are: ${Object.keys(FFMPEG_VARIANTS).join(", ")}.`,
        );
    }
    return variants;
}

function parseCliArgs() {
    const program = new Command();

    program
        .option("--only <names>", "Only build these libraries (comma-separated)")
        .option("--exclude, --skip <names>", "Exclude these libraries (comma-separated)")
        .option("--force", "Rebuild even if the repository is already built at the pinned tag", false)
        .addOption(new Option("--toolchain <toolchain>", "Select toolchain for building").choices(TOOLCHAINS).default("clang"))
        .option("--prefix <path>", "Install prefix for builds (overrides the default)")
        .option(
            "--repos <path>",
            "Directory to clone library repositories into (default: C:/Repos-<toolchain> on Windows)",
        )
        .option("--only-debug", "Only build the debug (shared) variant of each library")
        .option("--only-release", "Only build the release (static) variant of each library")
        .option(
            "--magick-variants <variants>",
            "ImageMagick variants (q8, q16, q32; optional hdri)",
            "q8,q16hdri",
        )
        .option(
            "--ffmpeg-variants <variants>",
            `FFmpeg variants: ${Object.keys(FFMPEG_VARIANTS).join(", ")}`,
            Object.keys(FFMPEG_VARIANTS).join(","),
        )
        .option(
            "--pgo <targets>",
            "PGO targets: clang, lld, libs, or off",
            "clang,lld,libs",
        )
        .option(
            "--pgo-train",
            "Train missing --pgo profiles into pgo/profiles",
            false,
        )
        .option(
            "--pgo-ir-only",
            "With --pgo-train: train only the IR profiles",
            false,
        )
        .option(
            "--print-pgo-keys",
            "Print the PGO profile file names and exit",
            false,
        )
        .option("--gen-toolchains", "Generate toolchain files in ./toolchains with default settings and exit")
        .option("--check-library-updates", "Compare pinned versions against Arch Linux packages and exit", false);

    program.parse();

    const opts = program.opts();
    const toolchain = opts.toolchain as Toolchain,
        onlyDebug = Boolean(opts.onlyDebug),
        onlyRelease = Boolean(opts.onlyRelease);

    if (onlyDebug && onlyRelease) {
        throw new Error("Options --only-debug and --only-release are mutually exclusive; use at most one.");
    }

    const pgoTargets = splitList(opts.pgo as string).filter((target) => target !== "off"),
        invalidPgo = pgoTargets.filter((target) => !(PGO_TARGETS as readonly string[]).includes(target));
    if (invalidPgo.length > 0) {
        throw new Error(
            `Invalid --pgo target(s) "${invalidPgo.join(", ")}". Valid targets are: ${PGO_TARGETS.join(", ")}, off.`,
        );
    }

    const known = new Set(LIBRARIES.map((library) => library.name)),
        unknown = [...splitList(opts.only as string), ...splitList(opts.skip as string)].filter(
            (name) => !known.has(name),
        );
    if (unknown.length > 0) {
        throw new Error(`Unknown library name(s) in --only/--exclude: ${unknown.join(", ")}.`);
    }

    // The paths end up unquoted in MSYS2 shell commands and compiler flag strings.
    for (const path of [opts.prefix, opts.repos]) {
        if (typeof path === "string" && /\s/.test(path)) {
            throw new Error(`--prefix and --repos must not contain whitespace: "${path}".`);
        }
    }

    settings.toolchain = toolchain;
    settings.exclude = new Set(splitList(opts.skip));
    settings.force = Boolean(opts.force);
    settings.genToolchains = Boolean(opts.genToolchains);
    settings.only = opts.only ? new Set(splitList(opts.only)) : null;
    settings.onlyDebug = onlyDebug;
    settings.onlyRelease = onlyRelease;
    settings.pgo = new Set(pgoTargets as PgoTarget[]);
    settings.pgoTraining = Boolean(opts.pgoTrain);
    settings.pgoIrOnly = Boolean(opts.pgoIrOnly);
    settings.magickVariants = parseMagickVariants(opts.magickVariants as string);
    settings.ffmpegVariants = parseFfmpegVariants(opts.ffmpegVariants as string);

    const pgoSuffix = magickSuffix(MAGICK_PGO_VARIANT);
    if (
        settings.pgoTraining &&
        (settings.pgo.has("libs") || settings.pgo.has("lld")) &&
        !settings.magickVariants.some((variant) => magickSuffix(variant) === pgoSuffix)
    ) {
        throw new Error(
            `--pgo-train with libs or lld links ImageMagick ${pgoSuffix}: add ${pgoSuffix.toLowerCase()} to --magick-variants.`,
        );
    }

    if (opts.prefix) {
        settings.prefix = opts.prefix as string;
    } else {
        settings.prefix = `C:/dev-${toolchain}`;
    }

    if (opts.repos) {
        settings.reposRoot = resolve(opts.repos as string).replaceAll("\\", "/");
    } else {
        settings.reposRoot = `C:/Repos-${toolchain}`;
    }

    return { checkLibraryUpdates: Boolean(opts.checkLibraryUpdates), printPgoKeys: Boolean(opts.printPgoKeys) };
}

$.setPrintCommand(true);
const cli = parseCliArgs();

if (cli.checkLibraryUpdates) {
    await checkLibraryUpdates(LIBRARIES);
    exit(0);
}

async function resolveProfiles() {
    if (settings.pgo.size > 0) {
        $.setPrintCommand(false);
        await resolvePgoProfiles();
        $.setPrintCommand(true);
    }
}

if (settings.genToolchains) {
    consola.info(pc.cyan("Generating toolchain files..."));
    await resolveProfiles(); // the consumer files reference the library profile
    configureToolchain(CONSUMER_PROFILE);
    consola.success(pc.green(`Toolchain files generated in ./toolchains for ${settings.toolchain}.`));
    exit(0);
}

await setupToolchainEnv(settings.toolchain);
await installToolchainPackages(settings.toolchain);
await resolveProfiles();

if (cli.printPgoKeys) {
    if (settings.pgo.has("libs")) {
        console.log(`libs=${basename(settings.libsProfdata)}`);
    }
    if (llvmPgo()) {
        console.log(`llvm=${basename(settings.llvmProfdata)}`);
        for (const target of llvmTargets()) {
            console.log(`ir-${target}=${basename(settings.llvmIrProfdata[target]!)}`);
        }
    }
    exit(0);
}

await verifyPrerequisites(settings.toolchain);
consola.info(pc.cyan(`Toolchain: ${settings.toolchain}`));

if (settings.pgo.has("libs")) {
    await libsPgo();
}

const libsTrainingOnly = settings.pgoTraining && settings.pgo.has("libs") && !llvmPgo();
if (!libsTrainingOnly) {
    await buildRepos();
}
