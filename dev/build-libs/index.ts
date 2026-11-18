import { Command } from "commander";
import consola from "consola";
import { $ } from "dax";
import { basename, resolve } from "node:path";
import { exit } from "node:process";
import pc from "picocolors";

import { checkLibraryUpdates } from "./check-updates.ts";
import { installToolchainPackages, setupToolchainEnv, verifyPrerequisites, WINDOWS_ONLY_TOOLCHAINS } from "./host.ts";
import { FFMPEG_VARIANTS, LIBRARIES } from "./libraries.ts";
import { libsPgo, MAGICK_PGO_VARIANT, resolvePgoProfiles } from "./pgo.ts";
import { buildRepos } from "./runner.ts";
import { llvmPgo, magickSuffix, type MagickVariant, PGO_TARGETS, type PgoTarget, settings, WIN } from "./settings.ts";
import { configureToolchain, CONSUMER_PROFILE, isToolchain, TOOLCHAINS } from "./toolchain.ts";
import type { CliOptions } from "./types.ts";

function splitList(value: string | undefined): string[] {
    return (value ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function validateToolchain(toolchain: string): void {
    if (!isToolchain(toolchain)) {
        throw new Error(`Invalid toolchain "${toolchain}". Valid toolchains are: ${TOOLCHAINS.join(", ")}.`);
    }
    if (!WIN && WINDOWS_ONLY_TOOLCHAINS.has(toolchain)) {
        throw new Error(
            `Toolchain "${toolchain}" is only available on Windows, but the current platform is ${process.platform}.`,
        );
    }
}

function parseMagickVariants(value: string): MagickVariant[] {
    return splitList(value).map((variant) => {
        const match = /^q(8|16|32)(hdri)?$/.exec(variant);
        if (!match) {
            throw new Error(`Invalid --magick-variants entry "${variant}". Expected q8, q16, q32, optionally with hdri (e.g. q16hdri).`);
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

/** Parses the command line into the options and the run's `settings`. */
function parseCliArgs(): CliOptions {
    const program = new Command();

    program
        .option("--only <names>", "Only build these libraries (comma-separated)")
        .option("--exclude, --skip <names>", "Exclude these libraries (comma-separated)")
        .option("--force", "Rebuild even if the repository is already built at the pinned tag", false)
        .option("--toolchain <clang|msvc>", "Select toolchain for building", "clang")
        .option("--prefix <path>", "Install prefix for builds (overrides the default)")
        .option("--repos <path>", "Directory to clone library repositories into (default: C:/Repos-<toolchain> on Windows)")
        .option("--only-debug", "Only build the debug (shared) variant of each library")
        .option("--only-release", "Only build the release (static) variant of each library")
        .option(
            "--magick-variants <variants>",
            "ImageMagick builds, comma-separated: q8, q16 or q32, each optionally with hdri. The PGO training runs need q16hdri",
            "q8,q16hdri",
        )
        .option(
            "--ffmpeg-variants <variants>",
            `FFmpeg builds, comma-separated: ${Object.keys(FFMPEG_VARIANTS).join(", ")}`,
            Object.keys(FFMPEG_VARIANTS).join(","),
        )
        .option(
            "--pgo <targets>",
            "Comma-separated PGO targets, or `off`. clang, lld: train llvm-project's profile on compiling clang and linking ImageMagick (lld needs the libraries built). With --pgo-train, llvm-project stops after its profile is trained (no build). libs: profile the libraries with trainers in patches/pgo (ImageMagick and its chain, harfbuzz/freetype, quickjs, nuspell, libarchive) first (alone, it stops after that)",
            "clang,lld,libs",
        )
        .option(
            "--pgo-train",
            "Train the --pgo profiles missing for this build (they are keyed by the libraries' versions, patches, trainers and compiler): profiling builds without -flto, the profiles are written to pgo/profiles. Without it, existing profiles are only read",
            false,
        )
        .option("--print-pgo-keys", "Print the --pgo targets' profile file names for this build as `libs=<file>` / `llvm=<file>` lines (for CI caching) and exit", false)
        .option("--gen-toolchains", "Generate toolchain files in ./toolchains with default settings and exit")
        .option("--check-library-updates", "Compare pinned versions against Arch Linux packages and exit", false);

    program.parse();

    const opts = program.opts();
    const toolchain = opts.toolchain as string,
        onlyDebug = Boolean(opts.onlyDebug),
        onlyRelease = Boolean(opts.onlyRelease),
        prefix = opts.prefix as null | string,
        options: CliOptions = {
            checkLibraryUpdates: Boolean(opts.checkLibraryUpdates),
            exclude: new Set(splitList(opts.skip)),
            force: Boolean(opts.force),
            genToolchains: Boolean(opts.genToolchains),
            printPgoKeys: Boolean(opts.printPgoKeys),
            only: opts.only ? new Set(splitList(opts.only)) : null,
            onlyDebug,
            onlyRelease,
            prefix,
            reposRoot: opts.repos
                ? resolve(opts.repos as string).replaceAll("\\", "/")
                : WIN
                  ? `C:/Repos-${toolchain}`
                  : settings.reposRoot,
            toolchain: toolchain as CliOptions["toolchain"],
        };

    validateToolchain(toolchain);

    if (onlyDebug && onlyRelease) {
        throw new Error("Options --only-debug and --only-release are mutually exclusive; use at most one.");
    }

    const pgoTargets = splitList(opts.pgo as string).filter((target) => target !== "off"),
        invalidPgo = pgoTargets.filter((target) => !(PGO_TARGETS as readonly string[]).includes(target));
    if (invalidPgo.length > 0) {
        throw new Error(`Invalid --pgo target(s) "${invalidPgo.join(", ")}". Valid targets are: ${PGO_TARGETS.join(", ")}, off.`);
    }

    settings.pgo = new Set(pgoTargets as PgoTarget[]);
    settings.pgoTraining = Boolean(opts.pgoTrain);
    settings.magickVariants = parseMagickVariants(opts.magickVariants as string);
    settings.ffmpegVariants = parseFfmpegVariants(opts.ffmpegVariants as string);

    const pgoSuffix = magickSuffix(MAGICK_PGO_VARIANT);
    if (
        settings.pgoTraining &&
        (settings.pgo.has("libs") || settings.pgo.has("lld")) &&
        !settings.magickVariants.some((variant) => magickSuffix(variant) === pgoSuffix)
    ) {
        throw new Error(`--pgo-train with libs or lld links ImageMagick ${pgoSuffix}: add ${pgoSuffix.toLowerCase()} to --magick-variants.`);
    }

    if (prefix) {
        settings.prefix = prefix;
    } else if (WIN) {
        settings.prefix = `C:/dev-${toolchain}`;
    }

    settings.reposRoot = options.reposRoot;

    return options;
}

$.setPrintCommand(true);
const options = parseCliArgs();

if (options.checkLibraryUpdates) {
    await checkLibraryUpdates(LIBRARIES);
    exit(0);
}

// The profile files for this build's sources and compiler (keyed by CLANG64's clang version, so resolved once it's installed).
async function resolveProfiles() {
    if (settings.pgo.size > 0) {
        $.setPrintCommand(false);
        await resolvePgoProfiles();
        $.setPrintCommand(true);
    }
}

if (options.genToolchains) {
    consola.info(pc.cyan("Generating toolchain files..."));
    await resolveProfiles(); // the consumer files reference the library profile
    await configureToolchain(options, CONSUMER_PROFILE);
    consola.success(pc.green(`Toolchain files generated in ./toolchains for ${options.toolchain}.`));
    exit(0);
}

await setupToolchainEnv(options.toolchain);
await installToolchainPackages(options.toolchain);
await resolveProfiles();

if (options.printPgoKeys) {
    if (settings.pgo.has("libs")) {
        console.log(`libs=${basename(settings.libsProfdata)}`);
    }
    if (llvmPgo()) {
        console.log(`llvm=${basename(settings.llvmProfdata)}`);
    }
    exit(0);
}

await verifyPrerequisites(options.toolchain);
consola.info(pc.cyan(`Toolchain: ${options.toolchain}`));

// 1. Library PGO. Training builds the trained libraries instrumented, runs the trainers and rebuilds them with the
//    profile; otherwise they're rebuilt with the cached profile.
if (settings.pgo.has("libs")) {
    await libsPgo(options);
}

// 2. Everything else, llvm-project last (a clang/lld training run trains its profile right before building it).
//    A libs-only training run stops after step 1: there's nothing left to train.
const libsTrainingOnly = settings.pgoTraining && settings.pgo.has("libs") && !llvmPgo();
if (!libsTrainingOnly) {
    await buildRepos(options);
}
