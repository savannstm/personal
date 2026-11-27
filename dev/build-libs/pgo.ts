import consola from "consola";
import $ from "dax";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import pc from "picocolors";

import { FFMPEG_VARIANTS } from "./ffmpeg.ts";
import { getPin, LIBRARIES, shouldBuildLibrary } from "./libraries.ts";
import { LLVM_MAJOR } from "./llvm.ts";
import {
    MAGICK_CODEC_LIBS,
    MAGICK_DEFINES,
    PGO_SYSTEM_LIBS,
    profraws,
    releaseArchives,
    removeStaleProfiles,
} from "./pgo-common.ts";
import { FFMPEG_DEMUXERS, FFMPEG_FIXTURES_DIR, FFMPEG_INPUTS } from "./pgo-fixtures.ts";
import { buildRepos } from "./runner.ts";
import { CLANG64, llvmPgo, llvmTargets, PROFILES_DIR, ROOT, settings, WIN_TAR } from "./settings.ts";
import {
    CLANG_WIN_TARGET,
    configureToolchain,
    CONSUMER_PROFILE,
    marchFlags,
    releaseOptFlags,
    THRESHOLD_LTO_LDFLAGS,
} from "./toolchain.ts";
import type { Library } from "./types.ts";

const LIBS_PGO_DIR = `${ROOT}/pgo/libs`;

const DICTIONARIES = [
    {
        text: "en.txt",
        url: "https://registry.npmjs.org/dictionary-en/-/dictionary-en-4.0.0.tgz",
    },
    {
        text: "ru.txt",
        url: "https://registry.npmjs.org/dictionary-ru/-/dictionary-ru-3.0.0.tgz",
    },
    {
        text: "de.txt",
        url: "https://registry.npmjs.org/dictionary-de/-/dictionary-de-3.0.0.tgz",
    },
];

const FONTS = [
    {
        file: "NotoSans.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans@0.4.2/400Regular/NotoSans_400Regular.ttf",
    },
    {
        file: "NotoSerif.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-serif@0.4.2/400Regular/NotoSerif_400Regular.ttf",
    },
    {
        file: "NotoSansMono.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-mono@0.4.2/400Regular/NotoSansMono_400Regular.ttf",
    },
    {
        file: "NotoSansJP.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-jp@0.4.4/400Regular/NotoSansJP_400Regular.ttf",
    },
    {
        file: "NotoSansSC.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-sc@0.4.4/400Regular/NotoSansSC_400Regular.ttf",
    },
    {
        file: "NotoSansKR.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-kr@0.4.4/400Regular/NotoSansKR_400Regular.ttf",
    },
    {
        file: "NotoSansArabic.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-arabic@0.4.3/400Regular/NotoSansArabic_400Regular.ttf",
    },
    {
        file: "NotoSansHebrew.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-hebrew@0.4.1/400Regular/NotoSansHebrew_400Regular.ttf",
    },
    {
        file: "NotoSansDevanagari.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-devanagari@0.4.2/400Regular/NotoSansDevanagari_400Regular.ttf",
    },
    {
        file: "NotoEmoji.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-emoji@0.4.8/400Regular/NotoEmoji_400Regular.ttf",
    },
    {
        file: "NotoSansThai.ttf",
        url: "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-thai@0.4.2/400Regular/NotoSansThai_400Regular.ttf",
    },
];

const PHOTOS = [
    {
        url: "https://r0k.us/graphics/kodak/kodak/kodim01.png",
    },
    {
        url: "https://r0k.us/graphics/kodak/kodak/kodim23.png",
    },
];

interface Trainer {
    name: string;
    libraries: string[];
    source: string;
    includes?: string[];
    defines?: string[];
    libs?: string[];
    prefixes?: () => string[];
    args?: (workload: string, sub?: string) => Promise<string[]>;
    share?: number;
    workloads?: Workload[];
}

interface Workload {
    name: string;
    weight: number;
    args: string[];
}

interface TrainedProfile {
    raws: string[];
    share: number;
    trainer: string;
    weight: number;
}

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
            { args: ["--only=large"], name: "large", weight: 2 },
        ],
    },
    {
        ...MAGICK_TRAINER,
        name: "magick-ops",
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
        libraries: ["harfbuzz", "freetype", "zlib-ng", "bzip2", "libpng"],
        includes: ["harfbuzz", "freetype2"],
        libs: ["dwrite"],
        args: fetchFonts,
    },
    { name: "quickjs", source: "quickjs.c", libraries: ["quickjs"] },
    {
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
        args: async () => [`${ROOT}/patches/pgo/fixtures/archive/exe-bcj.7z`],
    },
    {
        name: "ffmpeg",
        source: "ffmpeg.c",
        libraries: ["dav1d", "ffmpeg", "zlib-ng"],
        prefixes: () => settings.ffmpegVariants.map((variant) => `ffmpeg-${variant}`),
        args: ffmpegInputs,
        workloads: [
            { args: [], name: "video", weight: 3 },
            { args: [], name: "audio", weight: 2 },
        ],
    },
];

export const PGO_LIBRARIES: ReadonlySet<string> = new Set(TRAINERS.flatMap((trainer) => trainer.libraries));

const CS_LINK_NAME_VAR = "-Wl,-u,__llvm_profile_filename";

async function fetchBytes(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`${url}: ${res.status} ${res.statusText}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

async function download(out: string, url: string): Promise<void> {
    if (!existsSync(out)) {
        writeFileSync(out, await fetchBytes(url));
    }
}

async function fetchPhotos(): Promise<string[]> {
    const dir = `${LIBS_PGO_DIR}/photos`;
    mkdirSync(dir, { recursive: true });
    return Promise.all(
        PHOTOS.map(async ({ url }) => {
            const out = `${dir}/${basename(url)}`;
            await download(out, url);
            return out;
        }),
    );
}

const FFMPEG_AUDIO = new Set(FFMPEG_INPUTS.filter(({ kind }) => kind === "a").map(({ file }) => file));

function variantList(variant: string, kind: "decoders" | "demuxers"): Set<string> {
    return new Set(FFMPEG_VARIANTS[variant]?.[kind].split(","));
}

async function ffmpegInputs(workload: string, prefix?: string): Promise<string[]> {
    const audio = workload === "audio",
        inputs = FFMPEG_INPUTS.filter(({ file }) => FFMPEG_AUDIO.has(file) === audio),
        variant = prefix?.replace(/^ffmpeg-/, "") ?? "",
        decoders = variantList(variant, "decoders"),
        demuxers = variantList(variant, "demuxers"),
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
    mkdirSync(dir, { recursive: true });
    await Promise.all(FONTS.map(({ file, url }) => download(`${dir}/${file}`, url)));
    return [dir];
}

async function fetchDictionaries(): Promise<string[]> {
    const dir = `${LIBS_PGO_DIR}/dictionaries`;
    mkdirSync(dir, { recursive: true });
    return Promise.all(
        DICTIONARIES.map(async ({ text, url }) => {
            const out = `${dir}/${url
                .split("/")
                .pop()!
                .replace(/\.tgz$/, "")}`;
            if (!existsSync(`${out}/package/index.aff`)) {
                const data = await fetchBytes(url);
                mkdirSync(out, { recursive: true });
                writeFileSync(`${out}.tgz`, data);
                await $`${WIN_TAR} -xzf ${`${out}.tgz`} -C ${out}`;
            }
            return [`${out}/package/index.aff`, `${ROOT}/patches/pgo/fixtures/text/${text}`];
        }),
    ).then((pairs) => pairs.flat());
}

// Dependencies of chain libraries that have no trainer: built along with the chain, so those link the prefix's, not CLANG64's.
// shortcut: not on training runs (their CI jobs set up no Rust for rav1e), where the chain links CLANG64's.
const CHAIN_DEPENDENCIES = ["libspng", "openh264", "rav1e"];

// Training needs the whole chain; a plain build honors --only/--exclude (restrict).
async function buildChain(force = settings.force, restrict = false, dependencies: readonly string[] = []) {
    const names = new Set(
        [...dependencies, ...PGO_LIBRARIES].filter((name) => !restrict || shouldBuildLibrary(name)),
    );
    if (names.size === 0) {
        return;
    }
    const saved = {
        exclude: settings.exclude,
        force: settings.force,
        only: settings.only,
        onlyDebug: settings.onlyDebug,
        onlyRelease: settings.onlyRelease,
    };
    Object.assign(settings, {
        exclude: new Set<string>(),
        force,
        only: names,
        onlyDebug: false,
        onlyRelease: true,
    });
    try {
        await buildRepos();
    } finally {
        Object.assign(settings, saved);
    }
}

export async function libsPgo() {
    const profile = settings.libsProfdata,
        realPrefix = settings.prefix,
        genPrefix = `${LIBS_PGO_DIR}/prefix`;

    if (!settings.pgoTraining || existsSync(profile)) {
        if (![...PGO_LIBRARIES].some(shouldBuildLibrary)) {
            return;
        }
        if (!existsSync(profile)) {
            const message = `No library profile for this build (${basename(profile)}). Run with --pgo-train to create one.`;
            if (process.env.CI) {
                throw new Error(message);
            }
            consola.warn(pc.yellow(`${message} Building without it.`));
            return;
        }
        const dependencies = settings.pgoTraining ? [] : CHAIN_DEPENDENCIES;
        await withoutTraining(async () => {
            settings.libsPgo = "use";
            await buildChain(settings.force, true, dependencies);
            settings.libsPgo = null;
        });
        return;
    }

    rmSync(LIBS_PGO_DIR, { force: true, recursive: true });
    mkdirSync(PROFILES_DIR, { recursive: true });

    settings.libsPgo = "gen";
    settings.prefix = genPrefix;
    await buildChain(true);

    // The final profile path is written only once both stages are done: an interrupted run must not leave a half profile there.
    const irProfile = `${LIBS_PGO_DIR}/ir.profdata`;
    await mergeNormalized(irProfile, [], await runTrainers(genPrefix, "ir"), "ir");

    // The final profile doesn't exist yet: the library objects and the trainers apply the IR profile, the trainers' link adds the CS counters.
    settings.libsPgo = "use";
    settings.libsIrProfdata = irProfile;
    settings.prefix = realPrefix;
    await withoutTraining(() => buildChain(true));

    const merged = `${LIBS_PGO_DIR}/merged.profdata`;
    await mergeNormalized(merged, [irProfile], await runTrainers(realPrefix, "cs"), "cs");
    settings.libsIrProfdata = "";
    renameSync(merged, profile);
    removeStaleProfiles(profile, "libs-");

    settings.libsPgo = null;
    configureToolchain(CONSUMER_PROFILE);
}

function hash(parts: string[]): string {
    return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

export async function resolvePgoProfiles() {
    const clang = `${CLANG64}/bin/clang.exe`,
        version = /version (\S+)/.exec(await $`${clang} --version`.noThrow().quiet().text())?.[1] ?? "unknown",
        describe = (library: Library) => `${library.name}@${getPin(library)}`;

    // The profile is trained with CLANG64's clang and our runtimes (llvm-runtimes), and consumed by our own LLVM's clang.
    if (version.split(".")[0] !== LLVM_MAJOR) {
        consola.warn(
            pc.yellow(`CLANG64's clang is ${version}, LLVM is pinned to ${LLVM_MAJOR}: profiles may only partly apply.`),
        );
    }

    // The CI jobs pass the names the pgo-keys job computed (PGO_*_PROFILE), so a clang that updated in between can't change them.
    const named = (variable: string, fallback: string) =>
        `${PROFILES_DIR}/${process.env[variable] || fallback}`;

    settings.libsProfdata = named(
        "PGO_LIBS_PROFILE",
        `libs-${hash([version, ...LIBRARIES.filter((library) => PGO_LIBRARIES.has(library.name)).map(describe)])}.profdata`,
    );

    const llvm = LIBRARIES.find((library) => library.name === "llvm-project")!,
        targets = llvmTargets().join("+"),
        llvmParts = [version, describe(llvm)];
    settings.llvmProfdata = named("PGO_LLVM_PROFILE", `llvm-${targets}-${hash([...llvmParts, targets])}.profdata`);
    for (const target of llvmTargets()) {
        settings.llvmIrProfdata[target] = named(
            `PGO_LLVM_IR_${target.toUpperCase()}_PROFILE`,
            `llvm-ir-${target}-${hash([...llvmParts, target])}.profdata`,
        );
    }
}

// Part of a library's build-state stamp: the profile it was built with, so a new profile (not just a new pin) rebuilds it.
export function pgoStamp(library: Library): string {
    if (library.name === "llvm-project") {
        return llvmPgo() && existsSync(settings.llvmProfdata) ? basename(settings.llvmProfdata) : "";
    }
    const profiled = settings.pgo.has("libs") && PGO_LIBRARIES.has(library.name) && library.profile?.pgo !== false;
    // libsPgo is set while the profile is being trained, before the final file exists.
    return profiled && (settings.libsPgo !== null || existsSync(settings.libsProfdata))
        ? basename(settings.libsProfdata)
        : "";
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

async function runTrainers(prefix: string, stage: "cs" | "ir"): Promise<Map<string, TrainedProfile>> {
    const archives = releaseArchives(`${prefix}/release/lib`, ["Qt6"]),
        include = `${prefix}/release/include`,
        optFlags =
            stage === "ir"
                ? ["-O1", "-fprofile-generate"]
                : [
                      ...marchFlags(CONSUMER_PROFILE),
                      ...releaseOptFlags(true, CONSUMER_PROFILE.fatLto !== false),
                      `-fprofile-use=${settings.libsIrProfdata}`,
                  ],
        linkFlags =
            stage === "ir" ? [] : ["-Wl,--lto-O3", ...THRESHOLD_LTO_LDFLAGS, "-fcs-profile-generate", CS_LINK_NAME_VAR],
        profiles = new Map<string, TrainedProfile>();

    const runs: (Trainer & { base?: string; sub?: string })[] = [];
    for (const trainer of TRAINERS) {
        if (!trainer.prefixes) {
            runs.push(trainer);
            continue;
        }
        for (const sub of trainer.prefixes()) {
            runs.push({ ...trainer, name: `${trainer.name}-${sub}`, base: trainer.name, sub });
        }
    }

    for (const trainer of runs) {
        const { sub } = trainer,
            subArchives = sub ? releaseArchives(`${prefix}/release/${sub}/lib`) : [],
            subIncludes = sub ? [`-I${prefix}/release/${sub}/include`] : [],
            defines = trainer.defines ?? [],
            includes = (trainer.includes ?? []).map((name) => `-I${include}/${name}`),
            libs = (trainer.libs ?? []).map((name) => `-l${name}`),
            cxx = trainer.source.endsWith(".cpp"),
            driver = cxx ? "clang++" : "clang",
            dir = `${LIBS_PGO_DIR}/${stage}/${trainer.name}`,
            rawDir = `${dir}/raw`,
            obj = `${dir}/${trainer.name}.o`,
            exe = `${dir}/${trainer.name}.exe`,
            common = [`--target=${CLANG_WIN_TARGET}`, ...optFlags, "-fopenmp", "-pthread"],
            compile = [
                ...common,
                cxx ? "-std=gnu++23" : "-std=gnu17",
                ...defines,
                ...includes,
                ...subIncludes,
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
                ...libs,
                ...PGO_SYSTEM_LIBS,
                "-Wl,--end-group",
                "-o",
                exe,
            ];

        mkdirSync(rawDir, { recursive: true });
        await $`${driver} ${compile}`;
        await $`${driver} ${link}`;
        const base = trainer.base ?? trainer.name;
        for (const workload of trainer.workloads ?? [{ args: [], name: "all", weight: 1 }]) {
            const workloadDir = `${rawDir}/${workload.name}`,
                key = `${base}-${workload.name}`;
            mkdirSync(workloadDir, { recursive: true });
            const extraArgs = (await trainer.args?.(workload.name, sub)) ?? [];
            await $`${exe} ${[...workload.args, ...extraArgs]}`
                .cwd(dir)
                .env({ ...process.env, LLVM_PROFILE_FILE: `${workloadDir}/%m_%p.profraw` });
            const entry = profiles.get(key) ?? {
                raws: [],
                share: trainer.share ?? 1,
                trainer: base,
                weight: workload.weight,
            };
            const raws = profraws(workloadDir);
            entry.raws.push(...raws);
            profiles.set(key, entry);
        }
    }
    return profiles;
}

async function mergeNormalized(output: string, base: string[], runs: Map<string, TrainedProfile>, stage: "cs" | "ir") {
    const totals = new Map<string, number>(),
        shares = new Map<string, number>();
    for (const { trainer, weight } of runs.values()) {
        shares.set(trainer, (shares.get(trainer) ?? 0) + weight);
    }
    for (const [name, { raws }] of runs) {
        const merged = `${LIBS_PGO_DIR}/${stage}-${name}.profdata`;
        await $`llvm-profdata merge -output=${merged} ${raws}`;
        const summary = await $`llvm-profdata show --detailed-summary ${merged}`.text(),
            csSummary = await $`llvm-profdata show --showcs --detailed-summary ${merged}`.text(),
            total = (text: string) => Number(/^Total count: (\d+)/m.exec(text)?.[1] ?? 0);
        totals.set(name, Math.max(total(summary), total(csSummary)));
        if (!totals.get(name)) {
            throw new Error(`The ${name} trainer recorded no profile counts.`);
        }
    }

    const largest = Math.max(...totals.values()),
        weighted = [...runs].map(([name, { share, trainer, weight }]) => {
            const total = totals.get(name)!,
                value = Math.max(1, Math.round((64 * largest * share * weight) / (shares.get(trainer)! * total)));
            return `--weighted-input=${value},${LIBS_PGO_DIR}/${stage}-${name}.profdata`;
        });
    await $`llvm-profdata merge -output=${output} ${base} ${weighted}`;
}
