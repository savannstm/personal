// Profile-guided optimization. Two independent pipelines:
// - libs: the libraries the trainers in patches/pgo exercise are built instrumented into a scratch prefix, the trainers
//   run on it, and the libraries are rebuilt into the real prefix with the merged profile, which then gets a
//   context-sensitive part from LTO-linked runs of the same trainers (libsPgo).
// - clang/lld: llvm-project's own profile, trained when llvm-project is prepared (trainLlvm, the last library built).
// Training runs (--pgo-train) write the profiles; every other run only reads the cached ones from pgo/.

import consola from "consola";
import $ from "dax";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import pc from "picocolors";

import { FFMPEG_VARIANTS, getPin, LIBRARIES } from "./libraries.ts";
import { FFMPEG_DEMUXERS, FFMPEG_FIXTURES_DIR, FFMPEG_INPUTS } from "./pgo-fixtures.ts";
import { buildRepos } from "./runner.ts";
import {
    CLANG64,
    CLANG64_PKG_CONFIG,
    DEV_CLANG,
    LIBS_PGO_DIR,
    LLVM_PGO_DIR,
    type LlvmTarget,
    llvmPgo,
    llvmTargets,
    MAGICK_PGO_VARIANT,
    magickSuffix,
    PROFILES_DIR,
    ROOT,
    settings,
    WIN,
    WIN_TAR,
} from "./settings.ts";
import { raw } from "./shell.ts";
import {
    configureToolchain,
    CONSUMER_PROFILE,
    DEBUG_TRAIN_CFLAGS,
    profileOf,
    RELEASE_NON_LTO_LINKER_FLAGS,
    updateEnv,
} from "./toolchain.ts";
import type { CliOptions, Library } from "./types.ts";

const MAGICK_DEFINES = [
    `-DMAGICKCORE_HDRI_ENABLE=${MAGICK_PGO_VARIANT.hdri ? 1 : 0}`,
    `-DMAGICKCORE_QUANTUM_DEPTH=${MAGICK_PGO_VARIANT.depth}`,
    "-DMAGICKCORE_CHANNEL_MASK_DEPTH=32",
];

// Spell-checking dictionaries for the nuspell trainer: pinned npm tarballs (wooorm/dictionaries), checked against their integrity,
// each with a public-domain text in its language (Project Gutenberg, patches/pgo/fixtures/text) to spell-check as prose.
// German is there for compounding, which English and Russian don't exercise.
const DICTIONARIES = [
    {
        integrity: "sha512-3NHnE1uq33ZE/CIwaZ6gqxa4BnglHnxeAcTM0GJ7cmtRGcvX9InMK/IqLtYcUMFCUpUNgybH+DzkqdgAo3F1zg==",
        text: "en.txt",
        url: "https://registry.npmjs.org/dictionary-en/-/dictionary-en-4.0.0.tgz",
    },
    {
        integrity: "sha512-tigem0CDnNpxEciW6ktwVH3wWB4FYpuvpwA6IR6UlF7bVu2kez6vOejVNyZgBX1TJIjuYTCTuLxzg/YOls2mRQ==",
        text: "ru.txt",
        url: "https://registry.npmjs.org/dictionary-ru/-/dictionary-ru-3.0.0.tgz",
    },
    {
        integrity: "sha512-0Xbq+YpWTscAL1e18aPPaqfG4goC2o9T595L/54v2OvOPC0/TJFFlclYanxuUoK73wutM5f9EgSuWGkvQXlOXw==",
        text: "de.txt",
        url: "https://registry.npmjs.org/dictionary-de/-/dictionary-de-3.0.0.tgz",
    },
];

// Fonts for the text trainer (harfbuzz as Qt uses it): Noto (OFL) from the @expo-google-fonts npm packages, one file each from a pinned version,
// so the shaped scripts and the fonts' tables don't depend on what the training machine has. Checked against their integrity.
const FONTS = [
    {
        file: "NotoSans.ttf",
        integrity: "sha512-8H806pZO0oZobNy5EaFki41lQiKMHTHec9EZvXQzye9LMKLuNwuiKnN/bAo3RF6Ikp7e90rKGtB/I/MmmaNftw==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans@0.4.2/400Regular/NotoSans_400Regular.ttf",
    },
    {
        file: "NotoSerif.ttf",
        integrity: "sha512-TCRiC7YvHuUTymnG+TWuUHIeGv2C0II2DU1EPjnhFqGu+IYbN/unazmz9xKbUR3yZZvUdy0E5j2qxjCAsH9xNg==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-serif@0.4.2/400Regular/NotoSerif_400Regular.ttf",
    },
    {
        file: "NotoSansMono.ttf",
        integrity: "sha512-cBXZz9U4Tm2AbRHlFtCODhXHdj7k414pnpXVUWUj5+S+DnsYiJceb8gXVIAGyULCktW1EfoW7+olZBfOIm3PXg==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-mono@0.4.2/400Regular/NotoSansMono_400Regular.ttf",
    },
    {
        file: "NotoSansJP.ttf",
        integrity: "sha512-8DQoZ9R+ezsXoTJt5ZgH0l29BjWZicYHtemhNZCmVYrprLSBSNbk4tsGYSgEVmXVdWSc5NZrypYTLSbofKVfpQ==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-jp@0.4.4/400Regular/NotoSansJP_400Regular.ttf",
    },
    {
        file: "NotoSansSC.ttf",
        integrity: "sha512-Qgb9iXpZ8dFi1/osw5FamRx6zaA+Mlu/o0bDZE6beVJ8KGN7DIoKDXuAQbo/Oircdfwa5zxMW74B0stuUzwA/Q==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-sc@0.4.4/400Regular/NotoSansSC_400Regular.ttf",
    },
    {
        file: "NotoSansKR.ttf",
        integrity: "sha512-e5svupiVFn3BtsLXsq/+bqF+QgyWmXCR/l5kzWVLUQoiAsV285NlqmScnVPWahX3Z1GBTmCI/fEMPAOEC7uhYg==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-kr@0.4.4/400Regular/NotoSansKR_400Regular.ttf",
    },
    {
        file: "NotoSansArabic.ttf",
        integrity: "sha512-FQ011tMTOMdcoV/ghW89dPg7VEmcqT3N97Rd+5Oc8X9hxgaSFIzCJE7vMc811nbSkYKllQ7CPRmIOKEjwtE0lA==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-arabic@0.4.3/400Regular/NotoSansArabic_400Regular.ttf",
    },
    {
        file: "NotoSansHebrew.ttf",
        integrity: "sha512-sDNYq9s82OIMTgcl+GpfoQ/7E9WSUNjFCkNgl/5hP8VE2v9+UPxGOFIzsUJ/ZEFgO2PrJQCGZQvxp71NF43mqQ==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-hebrew@0.4.1/400Regular/NotoSansHebrew_400Regular.ttf",
    },
    {
        file: "NotoSansDevanagari.ttf",
        integrity: "sha512-wSGZBv0bbg8CrINCxsOeHNCAPsk80smNdJu+jGSVa4v2AIxwoCjE13clx1BLuekCyO4OJDsX+Z6i2iD7WsTcIA==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-devanagari@0.4.2/400Regular/NotoSansDevanagari_400Regular.ttf",
    },
    {
        file: "NotoEmoji.ttf",
        integrity: "sha512-LdPqrxDUBHZJA6b6u19aZKx08kfTxcBcpJWvg2ZYC/nwtrGzic2WHDhhGGj7cCBRRS65JuFdxsluZh+WxbPSVg==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-emoji@0.4.8/400Regular/NotoEmoji_400Regular.ttf",
    },
    {
        file: "NotoSansThai.ttf",
        integrity: "sha512-YVCtDkwEjVA2dE+fYhx4j6LTqhagZJh7G9xYC22aICveylqr2lg+VazWVEnT2Mg53l6WGSO2s1nNdW6tf4t72w==",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-thai@0.4.2/400Regular/NotoSansThai_400Regular.ttf",
    },
];

// Photographs for the ImageMagick trainers (Kodak's lossless true-colour test images, released for unrestricted use):
// real texture and noise, which the lossy codecs' branch statistics depend on. Checked against their integrity.
const PHOTOS = [
    {
        integrity: "sha512-xXgpImDdSR3VkNfGrqDeVjjLEjKnGvsI1kBAg3B2vi57KbOiAqIW9+3PbvBYCvspIBaKyUXgfhjul/Lxen9rPQ==",
        url: "https://r0k.us/graphics/kodak/kodak/kodim01.png",
    },
    {
        integrity: "sha512-+5HMee7+q8rQj2Jxq9PCtbIvU5+hgcoZKFipgGaiasd1BKBSpH7YWyGbB/h7t3n9XqNkyQSy7mKHNNxBf5szJA==",
        url: "https://r0k.us/graphics/kodak/kodak/kodim23.png",
    },
];

// libheif's codecs that we don't build with a profile, linked from CLANG64 as in the real build; userenv/dbghelp are rav1e's
// Rust runtime deps (its .pc Libs.private).
const MAGICK_CODEC_LIBS = ["rav1e", "openh264", "userenv", "dbghelp"];

interface Trainer {
    name: string;
    // The libraries it exercises, plus everything they link that we build. Their union is what the pipeline builds.
    libraries: string[];
    // In patches/pgo; .cpp is compiled as C++.
    source: string;
    // Directories under the prefix's include/ to add.
    includes?: string[];
    defines?: string[];
    // Libraries linked from CLANG64 rather than built by us.
    libs?: string[];
    // Install prefixes under the release prefix (the ffmpeg variants) whose include/ and lib/ to add. The trainer is
    // built and run once per prefix, all runs' counts going to its profile.
    prefixes?: () => string[];
    // The trainer's command-line arguments (for a workload, and for the ffmpeg variant prefix when it runs once per prefix).
    args?: (workload: string, sub?: string) => Promise<string[]>;
    // Its weight against the other trainers' (default 1): they all add up to the same total otherwise.
    share?: number;
    // Separate runs of the program with their own relative weight in the trainer's profile, so that what the apps use
    // most (the common codecs) outweighs the rest. `args` come before the trainer's own.
    workloads?: Workload[];
}

interface Workload {
    name: string;
    weight: number;
    args: string[];
}

/** One run's raw profiles; `weight` is its share of its trainer's profile, `share` its trainer's against the others'. */
interface TrainedProfile {
    raws: string[];
    share: number;
    trainer: string;
    weight: number;
}

// ImageMagick plus everything it links, directly or through another library. dav1d, kvazaar and libde265 are libheif's codecs.
// Two trainers share it: magick.c drives the coders (what vu reads and writes), magick-ops.c the operations (resize
// filters, thumbnails, colorspaces, effects), both on the photographs.
const MAGICK_TRAINER: Omit<Trainer, "name" | "source"> = {
    args: fetchPhotos,
    defines: [...MAGICK_DEFINES, "-D_LIB", "-D_MT"],
    includes: ["ImageMagick-7", "OpenEXR"],
    libraries: [
        "bzip2",
        "brotli",
        "dav1d",
        "freetype",
        "harfbuzz",
        "highway",
        "imagemagick",
        "imath",
        "kvazaar",
        "lcms2",
        "libde265",
        "libdeflate",
        "libheif",
        "libjpeg-turbo",
        "libjxl",
        "libpng",
        "libraw",
        "libtiff",
        "libtool",
        "libultrahdr",
        "libwebp",
        "libxml2",
        "libzip",
        "opencl-headers",
        "opencl-icd",
        "openexr",
        "openjpeg",
        "openjph",
        "xz",
        "zlib-ng",
        "zstd",
    ],
    libs: MAGICK_CODEC_LIBS,
};

const TRAINERS: Trainer[] = [
    {
        ...MAGICK_TRAINER,
        name: "magick",
        source: "magick.c",
        // By how much vu meets them: the formats of photos and the web, the modern ones, TIFF, then the long tail.
        workloads: [
            { args: ["--only=png,jpeg,webp,gif,animation"], name: "common", weight: 8 },
            { args: ["--only=heic,avif,jxl,heicgrid"], name: "modern", weight: 6 },
            { args: ["--only=tiff"], name: "tiff", weight: 4 },
            {
                args: ["--only=bmp,tga,dds,psd,ppm,pgm,pbm,qoi,pcx,ico,xpm,rgb,gray,hdr,miff,svg"],
                name: "native",
                weight: 2,
            },
            { args: ["--only=exr,jp2,j2k,htj2k,raw,ora,uhdr"], name: "professional", weight: 2 },
            { args: ["--only=icc"], name: "icc", weight: 1 },
            // Photographs that outgrow the pixel cache's memory limit.
            { args: ["--only=large"], name: "large", weight: 2 },
        ],
    },
    {
        ...MAGICK_TRAINER,
        name: "magick-ops",
        // The effects are a rare path (GPU-first in vu), the rest of the operations are what it does with every image.
        share: 0.5,
        source: "magick-ops.c",
        workloads: [
            { args: ["--only=core"], name: "core", weight: 3 },
            { args: ["--only=effects"], name: "effects", weight: 1 },
        ],
    },
    {
        name: "text",
        source: "text.c",
        // FreeType, zlib, bzip2 and libpng are what harfbuzz links (hb-ft); only harfbuzz is run.
        libraries: ["harfbuzz", "freetype", "zlib-ng", "bzip2", "libpng"],
        includes: ["harfbuzz", "freetype2"],
        // harfbuzz is built with DirectWrite support.
        libs: ["dwrite"],
        args: fetchFonts,
    },
    { name: "quickjs", source: "quickjs.c", libraries: ["quickjs"] },
    {
        // nuspell calls ICU on every check (UTF-8 conversion and casing), so ICU is trained with it.
        name: "nuspell",
        source: "nuspell.cpp",
        libraries: ["icu", "nuspell"],
        defines: ["-DNUSPELL_STATIC_DEFINE", "-DU_STATIC_IMPLEMENTATION"],
        args: fetchDictionaries,
    },
    {
        name: "archive",
        source: "archive.c",
        libraries: ["libarchive", "xz"],
        // A 7z of an executable, compressed with 7-Zip's BCJ x86 filter (the Windows update archive).
        args: async () => [`${ROOT}/patches/pgo/fixtures/archive/exe-bcj.7z`],
    },
    {
        // Once per selected variant (--ffmpeg-variants), each decoding what it was built for.
        name: "ffmpeg",
        source: "ffmpeg.c",
        libraries: ["dav1d", "ffmpeg", "zlib-ng"],
        prefixes: () => settings.ffmpegVariants.map((variant) => `ffmpeg-${variant}`),
        args: ffmpegInputs,
        // vu's video is the heaviest decode of the apps; rap and rpgmtranslate decode audio.
        workloads: [
            { args: [], name: "video", weight: 3 },
            { args: [], name: "audio", weight: 2 },
        ],
    },
];

// Everything the trainers exercise: what the library pipeline builds with the profile.
export const PGO_LIBRARIES: ReadonlySet<string> = new Set(TRAINERS.flatMap((trainer) => trainer.libraries));

// Link-only context-sensitive instrumentation emits no __llvm_profile_filename, which the profile runtime references
// (.refptr on COFF); lld doesn't pull its definition from the runtime archive without this force-include.
const CS_LINK_NAME_VAR = "-Wl,-u,__llvm_profile_filename";

// Windows system libraries the trainers link after the archive group.
const PGO_SYSTEM_LIBS = [
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

/**
 * Every static archive in `lib` a trainer links. Some .pc files (ImageMagick's) omit transitive deps, so all archives go
 * in one group and lld only pulls the members it needs. Left out: the other ImageMagick variants, Magick++, import libs,
 * OpenCL, and `skip`.
 */
async function releaseArchives(lib: string, skip: string[] = []): Promise<string[]> {
    const otherVariants = settings.magickVariants
            .map(magickSuffix)
            .filter((suffix) => suffix !== magickSuffix(MAGICK_PGO_VARIANT))
            .map((suffix) => String.raw`\.${suffix}\.`),
        exclude = new RegExp(
            [...otherVariants, ...skip, String.raw`Magick\+\+`, String.raw`\.dll\.a$`, "OpenCL"].join("|"),
        );
    return (await readdir(lib))
        .filter((file) => file.endsWith(".a") && !exclude.test(file))
        .map((file) => `${lib}/${file}`);
}

/** Downloads `url` and checks it against its pinned integrity. */
async function fetchVerified(url: string, integrity: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`${url}: ${res.status} ${res.statusText}`);
    }
    const data = Buffer.from(await res.arrayBuffer()),
        hash = `sha512-${createHash("sha512").update(data).digest("base64")}`;
    if (hash !== integrity) {
        throw new Error(`${url}: integrity mismatch (${hash})`);
    }
    return data;
}

async function fetchPhotos(): Promise<string[]> {
    const dir = `${LIBS_PGO_DIR}/photos`;
    await mkdir(dir, { recursive: true });
    return Promise.all(
        PHOTOS.map(async ({ integrity, url }) => {
            const out = `${dir}/${basename(url)}`;
            if (!existsSync(out)) {
                await writeFile(out, await fetchVerified(url, integrity));
            }
            return out;
        }),
    );
}

const FFMPEG_AUDIO = new Set(FFMPEG_INPUTS.filter(({ kind }) => kind === "a").map(({ file }) => file));

/** Names the decoders or demuxers a variant of FFMPEG_VARIANTS enables. */
function variantList(variant: string, kind: "decoder" | "demuxer"): Set<string> {
    const match = new RegExp(`--enable-${kind}=(\\S+)`).exec(FFMPEG_VARIANTS[variant]?.codecs ?? "");
    return new Set(match?.[1]?.split(",") ?? []);
}

/**
 * The ffmpeg trainer's inputs: the fixtures committed under patches/pgo/fixtures/ffmpeg (see pgo-fixtures.ts), the audio or
 * the video ones by workload, and for each variant the files it must decode (it has a decoder for the file and its demuxer).
 */
async function ffmpegInputs(workload: string, prefix?: string): Promise<string[]> {
    const audio = workload === "audio",
        inputs = FFMPEG_INPUTS.filter(({ file }) => FFMPEG_AUDIO.has(file) === audio),
        variant = prefix?.replace(/^ffmpeg-/, "") ?? "",
        decoders = variantList(variant, "decoder"),
        demuxers = variantList(variant, "demuxer"),
        required = inputs.filter(
            (input) =>
                demuxers.has(FFMPEG_DEMUXERS[extname(input.file)] ?? "") &&
                input.decoders.some((decoder) => decoders.has(decoder)),
        );
    for (const { file } of inputs) {
        if (!existsSync(`${FFMPEG_FIXTURES_DIR}/${file}`)) {
            throw new Error(`PGO fixture ${file} is missing: run node dev/build-libs/pgo-fixtures.ts`);
        }
    }
    return [
        `--require=${required.map(({ file }) => file).join(",")}`,
        ...inputs.map(({ file }) => `${FFMPEG_FIXTURES_DIR}/${file}`),
    ];
}

async function fetchFonts(): Promise<string[]> {
    const dir = `${LIBS_PGO_DIR}/fonts`;
    await mkdir(dir, { recursive: true });
    await Promise.all(
        FONTS.map(async ({ file, integrity, url }) => {
            const out = `${dir}/${file}`;
            if (!existsSync(out)) {
                await writeFile(out, await fetchVerified(url, integrity));
            }
        }),
    );
    return [dir];
}

async function fetchDictionaries(): Promise<string[]> {
    const dir = `${LIBS_PGO_DIR}/dictionaries`;
    await mkdir(dir, { recursive: true });
    return Promise.all(
        DICTIONARIES.map(async ({ integrity, text, url }) => {
            const out = `${dir}/${url
                .split("/")
                .pop()!
                .replace(/\.tgz$/, "")}`;
            if (!existsSync(`${out}/package/index.aff`)) {
                const data = await fetchVerified(url, integrity);
                await mkdir(out, { recursive: true });
                await writeFile(`${out}.tgz`, data);
                await $`${WIN_TAR} -xzf ${`${out}.tgz`} -C ${out}`;
            }
            return [`${out}/package/index.aff`, `${ROOT}/patches/pgo/fixtures/text/${text}`];
        }),
    ).then((pairs) => pairs.flat());
}

/**
 * Applies the library profile: builds the trainers' libraries into the real prefix with it. A training run without a
 * profile for the current key trains one first: the libraries are built instrumented into their own prefix, the
 * trainers run on them, the libraries are rebuilt into the real prefix with that profile, and LTO-linked trainer runs
 * add the context-sensitive part.
 */
export async function libsPgo(options: CliOptions) {
    if (!WIN) {
        throw new Error("--pgo libs is only implemented for Windows (the trainers' system libraries are hard-coded).");
    }

    const profile = settings.libsProfdata,
        realPrefix = settings.prefix,
        genPrefix = `${LIBS_PGO_DIR}/prefix`,
        chain: CliOptions = {
            ...options,
            exclude: new Set(),
            only: new Set(PGO_LIBRARIES),
            onlyDebug: false,
            onlyRelease: true,
        };

    if (!settings.pgoTraining || existsSync(profile)) {
        if (!existsSync(profile)) {
            consola.warn(
                pc.yellow(
                    `No library profile for this build (${basename(profile)}), building without it. Run with --pgo-train to create one.`,
                ),
            );
            return;
        }
        // Rebuilt only when the profile changed (see libsProfileTag). A regular LTO build even in a training run, whose lld training links its bitcode.
        await withoutTraining(async () => {
            settings.libsPgo = "use";
            await buildRepos(chain);
            settings.libsPgo = null;
        });
        return;
    }

    await rm(LIBS_PGO_DIR, { force: true, recursive: true });
    await mkdir(PROFILES_DIR, { recursive: true });

    settings.libsPgo = "gen";
    settings.prefix = genPrefix;
    await buildRepos({ ...chain, force: true });

    await mergeNormalized(profile, [], await runTrainers(genPrefix, "ir"), "ir");

    // A regular LTO build rather than a profiling one: the context-sensitive training LTO-links its bitcode.
    settings.libsPgo = "use";
    settings.prefix = realPrefix;
    await withoutTraining(() => buildRepos({ ...chain, force: true }));

    const merged = `${LIBS_PGO_DIR}/merged.profdata`;
    await mergeNormalized(merged, [profile], await runTrainers(realPrefix, "cs"), "cs");
    await rename(merged, profile);
    await removeStaleProfiles(profile, "libs-");

    settings.libsPgo = null;
    await configureToolchain(options, CONSUMER_PROFILE);
}

function hash(parts: string[]): string {
    return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** Contents of the patch files a library's hooks reference (`${ROOT}/patches/...` paths in their source). */
async function patchContents(sources: string[]): Promise<string[]> {
    const paths = [...new Set(sources.flatMap((source) => source.match(/patches\/[\w./-]+\.\w+/g) ?? []))].sort();
    return Promise.all(
        paths.map(async (path) => `${path}\n${await readFile(`${ROOT}/${path}`, "utf8").catch(() => "")}`),
    );
}

/**
 * Names the profiles after a key of everything they're trained from, so a stale profile is never applied and a missing
 * one gets trained: each pipeline's library pins, configure arguments and source patches, its trainers (or LLVM's
 * training code), the toolchain and builder code that turns all that into compiler flags, and the version of CLANG64's
 * clang, which trains them. (Once our own clang exists it compiles the libraries, but its version follows the LLVM tag.)
 */
export async function resolvePgoProfiles() {
    const clang = WIN ? `${CLANG64}/bin/clang.exe` : "clang",
        // "unknown" (no matching profile) when CLANG64's clang isn't installed yet: only --gen-toolchains resolves before installing it.
        version = /version (\S+)/.exec(await $`${clang} --version`.noThrow().quiet().text())?.[1] ?? "unknown",
        shared = [
            version,
            ...(await Promise.all(["toolchain.ts", "builders.ts"].map((file) => readFile(`${ROOT}/${file}`, "utf8")))),
        ],
        describe = async (library: Library) => {
            const hooks = [library.prepare, library.build].map((hook) => String(hook ?? ""));
            return [
                library.name,
                getPin(library),
                library.args?.({ isDebug: false, msvc: false, path: "", root: "", step: (_, build) => build() }) ?? "",
                JSON.stringify(library.profile ?? {}),
                ...hooks,
                ...(await patchContents(hooks)),
            ];
        };

    // The fixtures the trainers read (media, texts, archives) and what builds the ffmpeg variants they decode.
    const fixtures = await fixtureHashes(),
        libs = LIBRARIES.filter((library) => PGO_LIBRARIES.has(library.name)),
        trainers = await Promise.all(
            TRAINERS.map((trainer) => readFile(`${ROOT}/patches/pgo/${trainer.source}`, "utf8")),
        );
    settings.libsProfdata = `${PROFILES_DIR}/libs-${hash([
        ...shared,
        ...(await Promise.all(libs.map(describe))).flat(),
        ...trainers,
        JSON.stringify({
            DICTIONARIES,
            FFMPEG_INPUTS,
            FFMPEG_VARIANTS,
            FONTS,
            fixtures,
            MAGICK_CODEC_LIBS,
            MAGICK_PGO_VARIANT,
            PGO_SYSTEM_LIBS,
            PHOTOS,
            TRAINERS,
        }),
        String(libsPgo),
        String(runTrainers),
        String(mergeNormalized),
        String(releaseArchives),
        String(ffmpegInputs),
        String(fetchDictionaries),
    ])}.profdata`;
    // CI's skip_pgo reuses the latest cached profile (named by its older key) instead of one for this key.
    if (process.env.PGO_LIBS_PROFILE) {
        settings.libsProfdata = `${PROFILES_DIR}/${process.env.PGO_LIBS_PROFILE}`;
    }

    const llvm = LIBRARIES.find((library) => library.name === "llvm-project")!,
        targets = llvmTargets().join("+"),
        llvmParts = [
            ...shared,
            // Its args point at the profile itself once that exists.
            ...(await describe(llvm)).map((part) => part.replace(/ -DLLVM_PROFDATA_FILE=\S+/, "")),
        ];
    settings.llvmProfdata = `${PROFILES_DIR}/llvm-${targets}-${hash([...llvmParts, targets, String(trainLlvm)])}.profdata`;
    // Each target's IR profile is keyed alone, so training one doesn't depend on the other (clang needs no libraries).
    for (const target of llvmTargets()) {
        settings.llvmIrProfdata[target] =
            `${PROFILES_DIR}/llvm-ir-${target}-${hash([...llvmParts, target, String(trainLlvm)])}.profdata`;
    }
    if (process.env.PGO_LLVM_PROFILE) {
        settings.llvmProfdata = `${PROFILES_DIR}/${process.env.PGO_LLVM_PROFILE}`;
    }
}

/** Content hashes of the committed fixtures (patches/pgo/fixtures), part of the profile key. */
async function fixtureHashes(): Promise<string[]> {
    const entries = await readdir(`${ROOT}/patches/pgo/fixtures`, { recursive: true, withFileTypes: true }),
        files = entries.filter((entry) => entry.isFile()).map((entry) => `${entry.parentPath}/${entry.name}`);
    return (
        await Promise.all(
            files.map(
                async (path) =>
                    `${basename(path)}:${createHash("sha256")
                        .update(await readFile(path))
                        .digest("hex")}`,
            ),
        )
    ).sort();
}

const hashes = new Map<string, { hash: string; mtime: number }>();

/** Short content hash of a profile, for build-state pins: a retrained profile rebuilds what was built with it. */
export function profileHash(path: string): string {
    const mtime = statSync(path).mtimeMs,
        cached = hashes.get(path);
    if (cached?.mtime === mtime) {
        return cached.hash;
    }
    const value = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
    hashes.set(path, { hash: value, mtime });
    return value;
}

/** The build-state pin suffix of a library built with the library profile in this run, so a new profile rebuilds it. */
export function libsProfileTag(library: Library): string {
    return settings.pgo.has("libs") &&
        PGO_LIBRARIES.has(library.name) &&
        profileOf(library).pgo !== false &&
        existsSync(settings.libsProfdata)
        ? `+pgo-${profileHash(settings.libsProfdata)}`
        : "";
}

/** Deletes the pipeline's profiles for other keys (`prefix`: libs- or llvm-). */
async function removeStaleProfiles(current: string, prefix: string) {
    for (const file of await readdir(PROFILES_DIR)) {
        if (file.startsWith(prefix) && file.endsWith(".profdata") && `${PROFILES_DIR}/${file}` !== current) {
            await rm(`${PROFILES_DIR}/${file}`);
        }
    }
}

async function withoutTraining(build: () => Promise<void>) {
    const training = settings.pgoTraining;
    settings.pgoTraining = false;
    try {
        await build();
    } finally {
        settings.pgoTraining = training;
    }
}

async function profraws(dir: string): Promise<string[]> {
    return (await readdir(dir)).filter((file) => file.endsWith(".profraw")).map((file) => `${dir}/${file}`);
}

/**
 * Builds and runs every trainer against `prefix`, returning each trainer's raw profiles.
 * ir: instrumented libraries, plain link. cs: the libraries built with the IR profile, LTO-linked with context-sensitive
 * instrumentation and the release flags consumers link with (-O3, x86-64-v3, full LTO), since consumers apply that part
 * of the profile at their own LTO link (CONSUMER_PROFILE's linkLibsProfile).
 */
async function runTrainers(prefix: string, stage: "cs" | "ir"): Promise<Map<string, TrainedProfile>> {
    const archives = await releaseArchives(`${prefix}/release/lib`, ["Qt6"]),
        include = `${prefix}/release/include`,
        optFlags =
            stage === "ir"
                ? ["-O1", "-fprofile-generate"]
                : [
                      "-O3",
                      "-march=x86-64-v3",
                      "-mtune=generic",
                      "-flto=full",
                      "-DNDEBUG",
                      // Without it lld links the archives' machine code instead of their bitcode, and nothing is LTO'd.
                      "-ffat-lto-objects",
                      `-fprofile-use=${settings.libsProfdata}`,
                  ],
        // Context-sensitive instrumentation on the link only: with it on the trainer's own compile as well, the LTO link
        // drops the profile file name variable and the profile runtime can't resolve __llvm_profile_filename.
        linkFlags = stage === "ir" ? [] : ["-Wl,--lto-O3", "-fcs-profile-generate", CS_LINK_NAME_VAR],
        profiles = new Map<string, TrainedProfile>();

    for (const trainer of TRAINERS.flatMap((trainer) =>
        trainer.prefixes
            ? trainer.prefixes().map((sub) => ({ ...trainer, name: `${trainer.name}-${sub}`, base: trainer.name, sub }))
            : [trainer],
    )) {
        const sub = "sub" in trainer ? trainer.sub : undefined,
            subArchives = sub ? await releaseArchives(`${prefix}/release/${sub}/lib`) : [],
            cxx = trainer.source.endsWith(".cpp"),
            driver = cxx ? "clang++" : "clang",
            dir = `${LIBS_PGO_DIR}/${stage}/${trainer.name}`,
            rawDir = `${dir}/raw`,
            obj = `${dir}/${trainer.name}.o`,
            exe = `${dir}/${trainer.name}.exe`,
            common = ["--target=x86_64-w64-windows-gnu", ...optFlags, "-fopenmp", "-pthread"],
            compile = [
                ...common,
                cxx ? "-std=gnu++23" : "-std=gnu17",
                ...(trainer.defines ?? []),
                ...(trainer.includes ?? []).map((sub) => `-I${include}/${sub}`),
                ...(sub ? [`-I${prefix}/release/${sub}/include`] : []),
                `-I${include}`,
                "-c",
                `${ROOT}/patches/pgo/${trainer.source}`,
                "-o",
                obj,
            ],
            link = [
                ...common,
                ...linkFlags,
                "-static",
                "-fuse-ld=lld",
                obj,
                "-Wl,--start-group",
                ...archives,
                ...subArchives,
                ...(trainer.libs ?? []).map((name) => `-l${name}`),
                ...PGO_SYSTEM_LIBS,
                "-Wl,--end-group",
                "-o",
                exe,
            ];

        await mkdir(rawDir, { recursive: true });
        await $`${driver} ${compile}`;
        await $`${driver} ${link}`;
        const base = "base" in trainer ? trainer.base : trainer.name;
        for (const workload of trainer.workloads ?? [{ args: [], name: "all", weight: 1 }]) {
            const workloadDir = `${rawDir}/${workload.name}`,
                key = `${base}-${workload.name}`;
            await mkdir(workloadDir, { recursive: true });
            await $`${exe} ${[...workload.args, ...((await trainer.args?.(workload.name, sub)) ?? [])]}`
                .cwd(dir)
                .env({ ...process.env, LLVM_PROFILE_FILE: `${workloadDir}/%m_%p.profraw` });
            const entry = profiles.get(key) ?? {
                raws: [],
                share: trainer.share ?? 1,
                trainer: base,
                weight: workload.weight,
            };
            entry.raws.push(...(await profraws(workloadDir)));
            profiles.set(key, entry);
        }
    }
    return profiles;
}

/**
 * Merges `base` profiles and each run's raw profiles into `output`. Hot and cold are judged against the whole profile,
 * so the trainers are weighted to the same total count (otherwise the long-running ones would make the code only the
 * short ones exercise look cold), and within a trainer its workloads to their relative weights.
 */
async function mergeNormalized(output: string, base: string[], runs: Map<string, TrainedProfile>, stage: "cs" | "ir") {
    const totals = new Map<string, number>(),
        shares = new Map<string, number>();
    for (const { trainer, weight } of runs.values()) {
        shares.set(trainer, (shares.get(trainer) ?? 0) + weight);
    }
    for (const [name, { raws }] of runs) {
        const merged = `${LIBS_PGO_DIR}/${stage}-${name}.profdata`;
        await $`llvm-profdata merge -output=${merged} ${raws}`;
        // The context-sensitive counts have their own summary (--showcs); a run's profile holds one kind or the other.
        const summary = await $`llvm-profdata show --detailed-summary ${merged}`.text(),
            csSummary = await $`llvm-profdata show --showcs --detailed-summary ${merged}`.text(),
            total = (text: string) => Number(/^Total count: (\d+)/m.exec(text)?.[1] ?? 0);
        totals.set(name, Math.max(total(summary), total(csSummary)));
        // A trainer that recorded nothing was built without counters or ran without exercising its libraries.
        if (!totals.get(name)) {
            throw new Error(`The ${name} trainer recorded no profile counts.`);
        }
    }

    // Integer weights: a trainer's total is 64x the largest run's times its share, split by its workloads' weights.
    const largest = Math.max(...totals.values()),
        weighted = [...runs].map(([name, { share, trainer, weight }]) => {
            const total = totals.get(name)!,
                value = Math.max(1, Math.round((64 * largest * share * weight) / (shares.get(trainer)! * total)));
            return `--weighted-input=${value},${LIBS_PGO_DIR}/${stage}-${name}.profdata`;
        });
    await $`llvm-profdata merge -output=${output} ${base} ${weighted}`;
}

/**
 * Trains llvm-project's profile before it's built (its prepare step), in two stages from the same source:
 * 1. IR: per target, a clang or lld instrumented before inlining compiles part of clang (--pgo clang) or links ImageMagick
 *    (--pgo lld); the counts become that target's IR profile (settings.llvmIrProfdata), so the two can train in separate
 *    jobs and clang's needs no libraries. --pgo-ir-only stops here.
 * 2. Context-sensitive: one full-LTO build of all targets together (as the final build links them), built with the merged
 *    IR profiles and instrumented after LTO's inlining, runs the same training; its counts are merged with the IR profiles.
 * The result is settings.llvmProfdata, which llvm-project's args pass as LLVM_PROFDATA_FILE; LLVM's CMake also passes it to the
 * (LTO) link, where the context-sensitive part applies.
 * Its name carries the key of everything it was trained from (resolvePgoProfiles), so a new LLVM tag or compiler retrains it.
 * `llvmArgs` are llvm-project's release CMake args, `major` its version (CLANG64's resource dir is named after it),
 * `march` its -march/-mtune, which the context-sensitive stage matches since inlining depends on the target.
 */
export async function trainLlvm(path: string, llvmArgs: string, major: string, march: string) {
    const targets = llvmTargets(),
        missingIr = targets.filter((target) => !existsSync(settings.llvmIrProfdata[target]!));
    // Only the training run writes profiles; other runs use the cached one or build without PGO.
    if (
        !settings.pgoTraining ||
        !llvmPgo() ||
        (settings.pgoIrOnly ? missingIr.length === 0 : existsSync(settings.llvmProfdata))
    ) {
        return;
    }
    if (targets.includes("lld") && !existsSync(`${DEV_CLANG}/release/include/ImageMagick-7`)) {
        throw new Error(
            `--pgo lld links ImageMagick from ${DEV_CLANG}, which isn't built yet: build the libraries first.`,
        );
    }
    // prepare runs before buildVariants' updateEnv: without this, CFLAGS holds the last library's -fprofile-use, which -fprofile-generate rejects.
    await updateEnv(false);
    for (const dir of ["instrument", "cs-instrument", "train", "train-debug", "lld-train"]) {
        await rm(`${LLVM_PGO_DIR}/${dir}`, { force: true, recursive: true });
    }

    // -O3 without -flto: IR instrumentation happens before LTO anyway; the training file matches the Windows release script.
    const llvmSrc = `${path}/llvm`,
        inst = `${LLVM_PGO_DIR}/instrument`,
        csInst = `${LLVM_PGO_DIR}/cs-instrument`,
        trainDir = `${LLVM_PGO_DIR}/train`,
        debugTrainDir = `${LLVM_PGO_DIR}/train-debug`,
        lldDir = `${LLVM_PGO_DIR}/lld-train`,
        irProfdata = `${LLVM_PGO_DIR}/ir.profdata`,
        // CLANG64's: the stages' instrumented builds don't all exist in every job (they're built from the profiles, not the other way round).
        profdata = `${CLANG64}/bin/llvm-profdata.exe`,
        // -DNDEBUG: these replace CMake's Release flags, which carry it; without it the instrumented clang has assertions (LLVM_ENABLE_ASSERTIONS=OFF doesn't add it back).
        cflags = "-O3 -DNDEBUG -march=x86-64-v3 -mtune=generic",
        csCflags = `-O3 -DNDEBUG -march=${march} -mtune=${march}`,
        withLld = targets.includes("lld");

    /** Builds the tools of `active` (clang and/or lld) instrumented into `dir`. */
    const buildInstrumented = async (dir: string, flags: string, instrumentArgs: string[], active: LlvmTarget[]) => {
        await $`cmake -G Ninja -S ${llvmSrc} -B ${dir} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_FLAGS_RELEASE=${flags} -DCMAKE_CXX_FLAGS_RELEASE=${flags} ${instrumentArgs} ${raw(llvmArgs)} -DLLVM_ENABLE_PROJECTS=${active.join(";")} -DLLVM_ENABLE_RUNTIMES= -DLLVM_DISTRIBUTION_COMPONENTS= -DCLANG_DEFAULT_CXX_STDLIB=libc++ -DCLANG_DEFAULT_RTLIB=compiler-rt -DCLANG_DEFAULT_UNWINDLIB=libunwind`.env(
            {
                ...process.env,
                PKG_CONFIG_PATH: CLANG64_PKG_CONFIG,
            },
        );
        await $`ninja ${active}`.cwd(dir);
        if (active.includes("lld")) {
            // ld.lld is not a ninja target here; the lld binary is what ld.lld symlinks to, and --ld-path needs the ld.lld name.
            await $`cp ${dir}/bin/lld.exe ${dir}/bin/ld.lld.exe`;
        }
    };

    // The instrumented clang lives outside the CLANG64 prefix, so it needs CLANG64's resource dir, libc++ and compiler-rt/libunwind to link.
    // --sysroot: otherwise its MinGW driver takes the CRT from a gcc found on PATH (the CI runner's C:/mingw64) and mixes it with CLANG64's libs.
    const resourceDir = `${CLANG64}/lib/clang/${major}`,
        trainRuntime = `--sysroot=${CLANG64} -resource-dir ${resourceDir} -rtlib=compiler-rt --unwindlib=libunwind -L ${CLANG64}/lib`,
        trainCFlags = `${trainRuntime} -isystem ${resourceDir}/include -isystem ${CLANG64}/include`,
        trainCxxFlags = `${trainRuntime} -stdlib=libc++ -isystem ${CLANG64}/include/c++/v1 -isystem ${resourceDir}/include -isystem ${CLANG64}/include`,
        // The instrumented binaries (llvm-profdata.exe included) need CLANG64's DLLs (libc++, libxml2) on PATH, otherwise they exit with STATUS_DLL_NOT_FOUND.
        clang64Env = { ...process.env, PATH: `${CLANG64}/bin;${process.env.PATH ?? ""}` },
        mainCpp = `${lldDir}/main.cpp`,
        magickDefs = [...MAGICK_DEFINES, "-D_MT"];

    if (withLld) {
        await mkdir(lldDir, { recursive: true });
        await writeFile(
            mainCpp,
            '#include <MagickWand/MagickWand.h>\nint main() {\n    MagickWandGenesis();\n    MagickWand* wand = NewMagickWand();\n    MagickReadImage(wand, "xc:red");\n    MagickWriteImage(wand, "out.png");\n    DestroyMagickWand(wand);\n    MagickWandTerminus();\n}\n',
        );
    }

    /** Configures a build of clang with the instrumented tools in `dir` into `out`, compiled with the given release-type flags. */
    const configureTrain = async (
        dir: string,
        out: string,
        releaseC: string,
        releaseCxx: string,
        tablegen: string[] = [],
    ) => {
        await $`cmake -G Ninja -S ${llvmSrc} -B ${out} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=${`${dir}/bin/clang.exe`} -DCMAKE_CXX_COMPILER=${`${dir}/bin/clang++.exe`} -DLLVM_ENABLE_LIBCXX=ON -DLLVM_ENABLE_PROJECTS=clang -DLLVM_ENABLE_ASSERTIONS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_DOCS=OFF -DLLVM_INCLUDE_UTILS=OFF -DCLANG_INCLUDE_DOCS=OFF -DCLANG_INCLUDE_TESTS=OFF -DLLVM_TARGETS_TO_BUILD=Native -DCMAKE_C_FLAGS=${trainCFlags} -DCMAKE_CXX_FLAGS=${trainCxxFlags} -DCMAKE_C_FLAGS_RELEASE=${releaseC} -DCMAKE_CXX_FLAGS_RELEASE=${releaseCxx} -DCMAKE_EXE_LINKER_FLAGS=${`${trainRuntime} -stdlib=libc++`} -DCMAKE_SHARED_LINKER_FLAGS=${`${trainRuntime} -stdlib=libc++`} -DCMAKE_MODULE_LINKER_FLAGS=${`${trainRuntime} -stdlib=libc++`} ${tablegen}`;
    };

    /** Runs the training workloads of `active` with the instrumented tools in `dir`, returning the raw profiles they wrote to `rawDir`. */
    const train = async (dir: string, rawDir: string, active: LlvmTarget[]): Promise<string[]> => {
        await mkdir(rawDir, { recursive: true });

        if (active.includes("clang")) {
            await rm(trainDir, { force: true, recursive: true });
            await configureTrain(dir, trainDir, `${cflags} ${trainCFlags}`, `${cflags} ${trainCxxFlags}`);
        }

        // Building the instrumented tools and configuring with them writes profiles that aren't representative; drop them before training.
        await Promise.all((await profraws(rawDir)).map((file) => rm(file)));

        if (active.includes("clang")) {
            await $`ninja tools/clang/lib/Sema/CMakeFiles/obj.clangSema.dir/Sema.cpp.obj`.cwd(trainDir);

            // LLVM is C++17 and never touches concepts, heavy constexpr, ranges or glaze/enchantum reflection, which our own code is
            // made of: compile a fixture of those patterns (patches/pgo/fixtures/cxx23) so their paths aren't treated as cold.
            const cxx23Dir = `${ROOT}/patches/pgo/fixtures/cxx23`;
            await $`${dir}/bin/clang++.exe --target=x86_64-w64-windows-gnu -std=c++23 -O3 -c ${raw(trainCxxFlags)} -I${cxx23Dir} ${cxx23Dir}/train.cpp -o ${trainDir}/cxx23.o`.env(
                clang64Env,
            );

            // The C frontend: every library we build, and tinyfiledialogs, is C, which the C++ training above never reaches.
            const cDir = `${ROOT}/patches/pgo/fixtures/c`;
            await $`${dir}/bin/clang.exe --target=x86_64-w64-windows-gnu -O3 -c ${raw(trainCFlags)} ${cDir}/tinyfiledialogs.c -o ${trainDir}/tinyfiledialogs.o`.env(
                clang64Env,
            );

            // The debug builds' compile: -O0 with DWARF and the ASAN pass (FastISel, debug info emission, instrumentation),
            // on several Sema translation units, which are heavy on templates.
            await rm(debugTrainDir, { force: true, recursive: true });
            // The tablegen tools are the ones just built.
            await configureTrain(
                dir,
                debugTrainDir,
                `${DEBUG_TRAIN_CFLAGS.join(" ")} ${trainCFlags}`,
                `${DEBUG_TRAIN_CFLAGS.join(" ")} ${trainCxxFlags}`,
                [
                    `-DLLVM_TABLEGEN=${trainDir}/bin/llvm-tblgen.exe`,
                    `-DCLANG_TABLEGEN=${trainDir}/bin/clang-tblgen.exe`,
                ],
            );
            await $`ninja ${["Sema", "SemaExpr", "SemaDecl", "SemaDeclCXX", "SemaOverload", "SemaTemplate"].map((unit) => `tools/clang/lib/Sema/CMakeFiles/obj.clangSema.dir/${unit}.cpp.obj`)}`.cwd(
                debugTrainDir,
            );
        }

        if (active.includes("lld")) {
            // lld training (not part of the upstream script): link ImageMagick and its dependency chain with the instrumented ld.lld,
            // driven by the regular clang. Release is a static full-LTO link (the LTO path), debug a non-LTO ASAN/DWARF link against MSYS2's dynamic ImageMagick (the import-lib path).
            const linkBase = [
                    "--target=x86_64-w64-windows-gnu",
                    "-std=gnu++23",
                    "-O3",
                    "-fopenmp",
                    `--ld-path=${dir}/bin/ld.lld.exe`,
                    mainCpp,
                ],
                releaseArgs = [
                    ...linkBase,
                    "-flto=full",
                    // Without it lld links the archives' machine code instead of their bitcode, and nothing is LTO'd.
                    "-ffat-lto-objects",
                    // The release links' own flags: the sections are what --gc-sections and --icf=all work on.
                    "-ffunction-sections",
                    "-fdata-sections",
                    ...RELEASE_NON_LTO_LINKER_FLAGS,
                    "-Wl,--lto-O3",
                    "-static",
                    "-pthread",
                    "-D_LIB",
                    ...magickDefs,
                    `-I${DEV_CLANG}/release/include/ImageMagick-7`,
                    "-Wl,--start-group",
                    ...(await releaseArchives(`${DEV_CLANG}/release/lib`, ["Qt6"])),
                    ...MAGICK_CODEC_LIBS.map((name) => `-l${name}`),
                    ...PGO_SYSTEM_LIBS,
                    "-Wl,--end-group",
                    "-o",
                    `${lldDir}/release.exe`,
                ],
                debugArgs = [
                    ...linkBase,
                    // The debug builds' flags (-O0 after the shared -O3): DWARF, ASAN and zstd-compressed debug sections.
                    ...DEBUG_TRAIN_CFLAGS,
                    "-D_DLL",
                    ...magickDefs,
                    `-I${CLANG64}/include/ImageMagick-7`,
                    `-L${CLANG64}/lib`,
                    `-lMagickWand-7.${magickSuffix(MAGICK_PGO_VARIANT)}`,
                    "-o",
                    `${lldDir}/debug.exe`,
                ];
            await $`clang++ ${releaseArgs}`.env(clang64Env);
            await $`clang++ ${debugArgs}`.env(clang64Env);
        }

        return profraws(rawDir);
    };

    await mkdir(LLVM_PGO_DIR, { recursive: true });
    await mkdir(PROFILES_DIR, { recursive: true });

    // 1. IR profiles, each target from its own instrumented build.
    for (const target of missingIr) {
        await rm(inst, { force: true, recursive: true });
        await buildInstrumented(inst, cflags, ["-DLLVM_BUILD_INSTRUMENTED=IR"], [target]);
        const output = settings.llvmIrProfdata[target]!;
        await $`${profdata} merge -output=${output} ${await train(inst, `${inst}/profiles`, [target])}`.env(clang64Env);
        await removeStaleProfiles(output, `llvm-ir-${target}-`);
    }
    if (settings.pgoIrOnly) {
        return;
    }
    await $`${profdata} merge -output=${irProfdata} ${targets.map((target) => settings.llvmIrProfdata[target]!)}`.env(
        clang64Env,
    );

    // 2. Context-sensitive profile, from a full-LTO build of all targets like the final one. One link job: two full-LTO links at once can run out of memory.
    // -u doesn't make the LTO link pull the runtime's name variable from its archive, so link that member's object directly.
    const csNameDir = `${LLVM_PGO_DIR}/cs-name`;
    await rm(csNameDir, { force: true, recursive: true });
    await mkdir(csNameDir, { recursive: true });
    await $`${CLANG64}/bin/llvm-ar.exe x ${resourceDir}/lib/windows/libclang_rt.profile-x86_64.a InstrProfilingNameVar.c.obj`
        .cwd(csNameDir)
        .env(clang64Env);
    await buildInstrumented(
        csInst,
        csCflags,
        [
            "-DLLVM_BUILD_INSTRUMENTED=CSIR",
            `-DLLVM_PROFDATA_FILE=${irProfdata}`,
            "-DLLVM_ENABLE_LTO=Full",
            "-DLLVM_PARALLEL_LINK_JOBS=2",
            `-DCMAKE_EXE_LINKER_FLAGS=${csNameDir}/InstrProfilingNameVar.c.obj`,
        ],
        targets,
    );
    await $`${profdata} merge -output=${settings.llvmProfdata} ${irProfdata} ${await train(csInst, `${csInst}/csprofiles`, targets)}`.env(
        clang64Env,
    );
    await removeStaleProfiles(settings.llvmProfdata, `llvm-${targets.join("+")}-`);
}
