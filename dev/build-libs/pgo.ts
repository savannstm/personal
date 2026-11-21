import consola from "consola";
import $ from "dax";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import pc from "picocolors";

import { FFMPEG_VARIANTS, getPin, LIBRARIES } from "./libraries.ts";
import { latestVersionDir } from "./msvc.ts";
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
    WIN_TAR,
} from "./settings.ts";
import { raw } from "./shell.ts";
import {
    configureToolchain,
    CONSUMER_PROFILE,
    DEBUG_TRAIN_CFLAGS,
    marchFlags,
    RELEASE_NON_LTO_LINKER_FLAGS,
    releaseOptFlags,
    updateEnv,
} from "./toolchain.ts";
import type { CliOptions, Library } from "./types.ts";

const MAGICK_DEFINES = [
    `-DMAGICKCORE_HDRI_ENABLE=${MAGICK_PGO_VARIANT.hdri ? 1 : 0}`,
    `-DMAGICKCORE_QUANTUM_DEPTH=${MAGICK_PGO_VARIANT.depth}`,
    "-DMAGICKCORE_CHANNEL_MASK_DEPTH=32",
];

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

const MAGICK_CODEC_LIBS = ["rav1e", "openh264", "userenv", "dbghelp"];

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

function variantList(variant: string, kind: "decoder" | "demuxer"): Set<string> {
    const match = new RegExp(`--enable-${kind}=(\\S+)`).exec(FFMPEG_VARIANTS[variant]?.codecs ?? "");
    return new Set(match?.[1]?.split(",") ?? []);
}

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

export async function libsPgo(options: CliOptions) {
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

export async function resolvePgoProfiles() {
    const clang = `${CLANG64}/bin/clang.exe`,
        version = /version (\S+)/.exec(await $`${clang} --version`.noThrow().quiet().text())?.[1] ?? "unknown",
        describe = (library: Library) => `${library.name}@${getPin(library)}`;

    settings.libsProfdata = `${PROFILES_DIR}/libs-${hash([
        version,
        ...LIBRARIES.filter((library) => PGO_LIBRARIES.has(library.name)).map(describe),
    ])}.profdata`;
    if (process.env.PGO_LIBS_PROFILE) {
        settings.libsProfdata = `${PROFILES_DIR}/${process.env.PGO_LIBS_PROFILE}`;
    }

    const llvm = LIBRARIES.find((library) => library.name === "llvm-project")!,
        targets = llvmTargets().join("+"),
        llvmParts = [version, describe(llvm)];
    settings.llvmProfdata = `${PROFILES_DIR}/llvm-${targets}-${hash([...llvmParts, targets])}.profdata`;
    for (const target of llvmTargets()) {
        settings.llvmIrProfdata[target] = `${PROFILES_DIR}/llvm-ir-${target}-${hash([...llvmParts, target])}.profdata`;
    }
    if (process.env.PGO_LLVM_PROFILE) {
        settings.llvmProfdata = `${PROFILES_DIR}/${process.env.PGO_LLVM_PROFILE}`;
    }
}

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

async function runTrainers(prefix: string, stage: "cs" | "ir"): Promise<Map<string, TrainedProfile>> {
    const archives = await releaseArchives(`${prefix}/release/lib`, ["Qt6"]),
        include = `${prefix}/release/include`,
        optFlags =
            stage === "ir"
                ? ["-O1", "-fprofile-generate"]
                : [
                      ...marchFlags(CONSUMER_PROFILE),
                      ...releaseOptFlags(true, CONSUMER_PROFILE.fatLto !== false),
                      `-fprofile-use=${settings.libsProfdata}`,
                  ],
        linkFlags = stage === "ir" ? [] : ["-Wl,--lto-O3", "-fcs-profile-generate", CS_LINK_NAME_VAR],
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
            subArchives = sub ? await releaseArchives(`${prefix}/release/${sub}/lib`) : [],
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
            common = ["--target=x86_64-w64-windows-gnu", ...optFlags, "-fopenmp", "-pthread"],
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

        await mkdir(rawDir, { recursive: true });
        await $`${driver} ${compile}`;
        await $`${driver} ${link}`;
        const base = trainer.base ?? trainer.name;
        for (const workload of trainer.workloads ?? [{ args: [], name: "all", weight: 1 }]) {
            const workloadDir = `${rawDir}/${workload.name}`,
                key = `${base}-${workload.name}`;
            await mkdir(workloadDir, { recursive: true });
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
            const raws = await profraws(workloadDir);
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

export async function trainLlvm(path: string, llvmArgs: string, optFlags: string) {
    const targets = llvmTargets(),
        missingIr = targets.filter((target) => !existsSync(settings.llvmIrProfdata[target]!));
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
    await updateEnv(false);
    for (const dir of ["instrument", "cs-instrument", "train", "train-debug", "lld-train"]) {
        await rm(`${LLVM_PGO_DIR}/${dir}`, { force: true, recursive: true });
    }

    const llvmSrc = `${path}/llvm`,
        inst = `${LLVM_PGO_DIR}/instrument`,
        csInst = `${LLVM_PGO_DIR}/cs-instrument`,
        trainDir = `${LLVM_PGO_DIR}/train`,
        debugTrainDir = `${LLVM_PGO_DIR}/train-debug`,
        lldDir = `${LLVM_PGO_DIR}/lld-train`,
        irProfdata = `${LLVM_PGO_DIR}/ir.profdata`,
        profdata = `${CLANG64}/bin/llvm-profdata.exe`,
        withLld = targets.includes("lld");

    const buildInstrumented = async (dir: string, flags: string, instrumentArgs: string[], active: LlvmTarget[]) => {
        await $`cmake -G Ninja -S ${llvmSrc} -B ${dir} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_FLAGS_RELEASE=${flags} -DCMAKE_CXX_FLAGS_RELEASE=${flags} ${instrumentArgs} ${raw(llvmArgs)} -DLLVM_ENABLE_PROJECTS=${active.join(";")} -DLLVM_ENABLE_RUNTIMES= -DLLVM_DISTRIBUTION_COMPONENTS= -DCLANG_DEFAULT_CXX_STDLIB=libc++ -DCLANG_DEFAULT_RTLIB=compiler-rt -DCLANG_DEFAULT_UNWINDLIB=libunwind`.env(
            {
                ...process.env,
                PKG_CONFIG_PATH: CLANG64_PKG_CONFIG,
            },
        );
        await $`ninja ${active}`.cwd(dir);
        if (active.includes("lld")) {
            await $`cp ${dir}/bin/lld.exe ${dir}/bin/ld.lld.exe`;
        }
    };

    const resourceDir = `${CLANG64}/lib/clang/${await latestVersionDir(`${CLANG64}/lib/clang`)}`,
        trainRuntime = `--sysroot=${CLANG64} -resource-dir ${resourceDir} -rtlib=compiler-rt --unwindlib=libunwind -L ${CLANG64}/lib`,
        trainCFlags = `${trainRuntime} -isystem ${resourceDir}/include -isystem ${CLANG64}/include`,
        trainCxxFlags = `${trainRuntime} -stdlib=libc++ -isystem ${CLANG64}/include/c++/v1 -isystem ${resourceDir}/include -isystem ${CLANG64}/include`,
        trainLdFlags = `${trainRuntime} -stdlib=libc++`,
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

    const configureTrain = async (
        dir: string,
        out: string,
        releaseC: string,
        releaseCxx: string,
        tablegen: string[] = [],
    ) => {
        await $`cmake -G Ninja -S ${llvmSrc} -B ${out} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=${`${dir}/bin/clang.exe`} -DCMAKE_CXX_COMPILER=${`${dir}/bin/clang++.exe`} -DLLVM_ENABLE_LIBCXX=ON -DLLVM_ENABLE_PROJECTS=clang -DLLVM_ENABLE_ASSERTIONS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_DOCS=OFF -DLLVM_INCLUDE_UTILS=OFF -DCLANG_INCLUDE_DOCS=OFF -DCLANG_INCLUDE_TESTS=OFF -DLLVM_TARGETS_TO_BUILD=Native -DCMAKE_C_FLAGS=${trainCFlags} -DCMAKE_CXX_FLAGS=${trainCxxFlags} -DCMAKE_C_FLAGS_RELEASE=${releaseC} -DCMAKE_CXX_FLAGS_RELEASE=${releaseCxx} -DCMAKE_EXE_LINKER_FLAGS=${trainLdFlags} -DCMAKE_SHARED_LINKER_FLAGS=${trainLdFlags} -DCMAKE_MODULE_LINKER_FLAGS=${trainLdFlags} ${tablegen}`;
    };

    const train = async (dir: string, rawDir: string, active: LlvmTarget[]): Promise<string[]> => {
        await mkdir(rawDir, { recursive: true });

        if (active.includes("clang")) {
            await rm(trainDir, { force: true, recursive: true });
            await configureTrain(dir, trainDir, `${optFlags} ${trainCFlags}`, `${optFlags} ${trainCxxFlags}`);
        }

        await Promise.all((await profraws(rawDir)).map((file) => rm(file)));

        if (active.includes("clang")) {
            await $`ninja tools/clang/lib/Sema/CMakeFiles/obj.clangSema.dir/Sema.cpp.obj`.cwd(trainDir);

            const cxx23Dir = `${ROOT}/patches/pgo/fixtures/cxx23`;
            await $`${dir}/bin/clang++.exe --target=x86_64-w64-windows-gnu -std=c++23 -O3 -c ${raw(trainCxxFlags)} -I${cxx23Dir} ${cxx23Dir}/train.cpp -o ${trainDir}/cxx23.o`.env(
                clang64Env,
            );

            const cDir = `${ROOT}/patches/pgo/fixtures/c`;
            await $`${dir}/bin/clang.exe --target=x86_64-w64-windows-gnu -O3 -c ${raw(trainCFlags)} ${cDir}/tinyfiledialogs.c -o ${trainDir}/tinyfiledialogs.o`.env(
                clang64Env,
            );

            await rm(debugTrainDir, { force: true, recursive: true });
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
            const semaUnits = ["Sema", "SemaExpr", "SemaDecl", "SemaDeclCXX", "SemaOverload", "SemaTemplate"].map(
                (unit) => `tools/clang/lib/Sema/CMakeFiles/obj.clangSema.dir/${unit}.cpp.obj`,
            );
            await $`ninja ${semaUnits}`.cwd(debugTrainDir);
        }

        if (active.includes("lld")) {
            const lldArchives = await releaseArchives(`${DEV_CLANG}/release/lib`, ["Qt6"]),
                codecLibs = MAGICK_CODEC_LIBS.map((name) => `-l${name}`),
                linkBase = [
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
                    "-ffat-lto-objects",
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
                    ...lldArchives,
                    ...codecLibs,
                    ...PGO_SYSTEM_LIBS,
                    "-Wl,--end-group",
                    "-o",
                    `${lldDir}/release.exe`,
                ],
                debugArgs = [
                    ...linkBase,
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

    for (const target of missingIr) {
        await rm(inst, { force: true, recursive: true });
        await buildInstrumented(inst, optFlags, ["-DLLVM_BUILD_INSTRUMENTED=IR"], [target]);
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

    const csNameDir = `${LLVM_PGO_DIR}/cs-name`;
    await rm(csNameDir, { force: true, recursive: true });
    await mkdir(csNameDir, { recursive: true });
    await $`${CLANG64}/bin/llvm-ar.exe x ${resourceDir}/lib/windows/libclang_rt.profile-x86_64.a InstrProfilingNameVar.c.obj`
        .cwd(csNameDir)
        .env(clang64Env);
    await buildInstrumented(
        csInst,
        optFlags,
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
