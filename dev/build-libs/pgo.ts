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
import { basename } from "node:path";
import pc from "picocolors";

import { getPin, LIBRARIES } from "./libraries.ts";
import { buildRepos, profileOf } from "./runner.ts";
import {
    DEV_CLANG,
    LIBS_PGO_DIR,
    LLVM_PGO_DIR,
    llvmPgo,
    magickSuffix,
    type MagickVariant,
    MSYS2_ROOT,
    PGO_TARGETS,
    PROFILES_DIR,
    ROOT,
    settings,
    WIN,
} from "./settings.ts";
import { raw } from "./shell.ts";
import { configureToolchain, CONSUMER_PROFILE, updateEnv } from "./toolchain.ts";
import type { CliOptions, Library } from "./types.ts";

// The ImageMagick variant the magick and lld trainers link; --magick-variants must include it for a training run.
export const MAGICK_PGO_VARIANT: MagickVariant = { depth: 16, hdri: true };

const MAGICK_DEFINES = [
    `-DMAGICKCORE_HDRI_ENABLE=${MAGICK_PGO_VARIANT.hdri ? 1 : 0}`,
    `-DMAGICKCORE_QUANTUM_DEPTH=${MAGICK_PGO_VARIANT.depth}`,
    "-DMAGICKCORE_CHANNEL_MASK_DEPTH=32",
];

// Spell-checking dictionaries for the nuspell trainer: pinned npm tarballs (wooorm/dictionaries), checked against their integrity.
const DICTIONARIES = [
    {
        integrity: "sha512-3NHnE1uq33ZE/CIwaZ6gqxa4BnglHnxeAcTM0GJ7cmtRGcvX9InMK/IqLtYcUMFCUpUNgybH+DzkqdgAo3F1zg==",
        url: "https://registry.npmjs.org/dictionary-en/-/dictionary-en-4.0.0.tgz",
    },
    {
        integrity: "sha512-tigem0CDnNpxEciW6ktwVH3wWB4FYpuvpwA6IR6UlF7bVu2kez6vOejVNyZgBX1TJIjuYTCTuLxzg/YOls2mRQ==",
        url: "https://registry.npmjs.org/dictionary-ru/-/dictionary-ru-3.0.0.tgz",
    },
];

// libheif's codecs that we don't build on clang, linked from CLANG64 as in the real build; userenv/dbghelp are rav1e's
// Rust runtime deps (its .pc Libs.private).
const MAGICK_CODEC_LIBS = ["dav1d", "rav1e", "openh264", "userenv", "dbghelp"];

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
    // The trainer's command-line arguments; may fetch the data they point to.
    args?: () => Promise<string[]>;
}

const TRAINERS: Trainer[] = [
    {
        // ImageMagick plus everything it links, directly or through another library. kvazaar/libde265 are libheif's codecs.
        name: "magick",
        source: "magick.c",
        libraries: [
            "bzip2",
            "brotli",
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
        includes: ["ImageMagick-7", "OpenEXR"],
        defines: [...MAGICK_DEFINES, "-D_LIB", "-D_MT"],
        libs: MAGICK_CODEC_LIBS,
    },
    {
        name: "text",
        source: "text.c",
        libraries: ["harfbuzz", "freetype", "zlib-ng", "bzip2", "libpng"],
        includes: ["harfbuzz", "freetype2"],
        // harfbuzz is built with DirectWrite support.
        libs: ["dwrite"],
        args: async () => ["C:/Windows/Fonts"],
    },
    { name: "quickjs", source: "quickjs.c", libraries: ["quickjs"] },
    {
        // nuspell's ICU comes from CLANG64 on clang.
        name: "nuspell",
        source: "nuspell.cpp",
        libraries: ["nuspell"],
        defines: ["-DNUSPELL_STATIC_DEFINE", "-DU_STATIC_IMPLEMENTATION"],
        libs: ["icuuc", "icudt"],
        args: fetchDictionaries,
    },
    { name: "archive", source: "archive.c", libraries: ["libarchive", "xz"] },
];

// Everything the trainers exercise: what the library pipeline builds with the profile.
export const PGO_LIBRARIES: ReadonlySet<string> = new Set(TRAINERS.flatMap((trainer) => trainer.libraries));

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
        exclude = new RegExp([...otherVariants, ...skip, String.raw`Magick\+\+`, String.raw`\.dll\.a$`, "OpenCL"].join("|"));
    return (await readdir(lib)).filter((file) => file.endsWith(".a") && !exclude.test(file)).map((file) => `${lib}/${file}`);
}

async function fetchDictionaries(): Promise<string[]> {
    const dir = `${LIBS_PGO_DIR}/dictionaries`;
    await mkdir(dir, { recursive: true });
    return Promise.all(
        DICTIONARIES.map(async ({ integrity, url }) => {
            const out = `${dir}/${url.split("/").pop()!.replace(/\.tgz$/, "")}`;
            if (existsSync(`${out}/package/index.aff`)) {
                return `${out}/package/index.aff`;
            }
            const res = await fetch(url);
            if (!res.ok) {
                throw new Error(`${url}: ${res.status} ${res.statusText}`);
            }
            const data = Buffer.from(await res.arrayBuffer()),
                hash = `sha512-${createHash("sha512").update(data).digest("base64")}`;
            if (hash !== integrity) {
                throw new Error(`${url}: integrity mismatch (${hash})`);
            }
            await mkdir(out, { recursive: true });
            await writeFile(`${out}.tgz`, data);
            await $`"C:/Windows/System32/tar.exe" -xzf ${`${out}.tgz`} -C ${out}`;
            return `${out}/package/index.aff`;
        }),
    );
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
            consola.warn(pc.yellow(`No library profile for this build (${basename(profile)}), building without it. Run with --pgo-train to create one.`));
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
    return Promise.all(paths.map(async (path) => `${path}\n${await readFile(`${ROOT}/${path}`, "utf8").catch(() => "")}`));
}

/**
 * Names the profiles after a key of everything they're trained from, so a stale profile is never applied and a missing
 * one gets trained: each pipeline's library pins, configure arguments and source patches, its trainers (or LLVM's
 * training code), the toolchain and builder code that turns all that into compiler flags, and the version of CLANG64's
 * clang, which trains them. (Once our own clang exists it compiles the libraries, but its version follows the LLVM tag.)
 */
export async function resolvePgoProfiles() {
    const clang = WIN ? `${MSYS2_ROOT}/clang64/bin/clang.exe` : "clang",
        // "unknown" (no matching profile) when CLANG64's clang isn't installed yet: only --gen-toolchains resolves before installing it.
        version = /version (\S+)/.exec(await $`${clang} --version`.noThrow().quiet().text())?.[1] ?? "unknown",
        shared = [version, ...(await Promise.all(["toolchain.ts", "builders.ts"].map((file) => readFile(`${ROOT}/${file}`, "utf8"))))],
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

    const libs = LIBRARIES.filter((library) => PGO_LIBRARIES.has(library.name)),
        trainers = await Promise.all(TRAINERS.map((trainer) => readFile(`${ROOT}/patches/pgo/${trainer.source}`, "utf8")));
    settings.libsProfdata = `${PROFILES_DIR}/libs-${hash([
        ...shared,
        ...(await Promise.all(libs.map(describe))).flat(),
        ...trainers,
        JSON.stringify({ DICTIONARIES, MAGICK_CODEC_LIBS, MAGICK_PGO_VARIANT, PGO_SYSTEM_LIBS, TRAINERS }),
        String(libsPgo),
        String(runTrainers),
        String(mergeNormalized),
    ])}.profdata`;

    const llvm = LIBRARIES.find((library) => library.name === "llvm-project")!,
        targets = PGO_TARGETS.filter((target) => target !== "libs" && settings.pgo.has(target)).join("+");
    settings.llvmProfdata = `${PROFILES_DIR}/llvm-${targets}-${hash([
        ...shared,
        // Its args point at the profile itself once that exists.
        ...(await describe(llvm)).map((part) => part.replace(/ -DLLVM_PROFDATA_FILE=\S+/, "")),
        targets,
        String(trainLlvm),
    ])}.profdata`;
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
async function runTrainers(prefix: string, stage: "cs" | "ir"): Promise<Map<string, string[]>> {
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
                      // Without it lld links the archives' machine code instead of their bitcode, and nothing is LTO'd.
                      "-ffat-lto-objects",
                      `-fprofile-use=${settings.libsProfdata}`,
                  ],
        // Context-sensitive instrumentation on the link only: with it on the trainer's own compile as well, the LTO link
        // drops the profile file name variable and the profile runtime can't resolve __llvm_profile_filename.
        linkFlags = stage === "ir" ? [] : ["-Wl,--lto-O3", "-fcs-profile-generate"],
        profiles = new Map<string, string[]>();

    for (const trainer of TRAINERS) {
        const cxx = trainer.source.endsWith(".cpp"),
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
                ...(trainer.libs ?? []).map((name) => `-l${name}`),
                ...PGO_SYSTEM_LIBS,
                "-Wl,--end-group",
                "-o",
                exe,
            ];

        await mkdir(rawDir, { recursive: true });
        await $`${driver} ${compile}`;
        await $`${driver} ${link}`;
        await $`${exe} ${(await trainer.args?.()) ?? []}`
            .cwd(dir)
            .env({ ...process.env, LLVM_PROFILE_FILE: `${rawDir}/%m_%p.profraw` });
        profiles.set(trainer.name, await profraws(rawDir));
    }
    return profiles;
}

/**
 * Merges `base` profiles and each trainer's raw profiles into `output`, weighting the trainers to the same total count.
 * Hot and cold are judged against the whole profile, so without this the long-running trainers' counts would make the
 * code only the short ones exercise look cold.
 */
async function mergeNormalized(output: string, base: string[], trainers: Map<string, string[]>, stage: "cs" | "ir") {
    const totals = new Map<string, number>();
    for (const [name, raws] of trainers) {
        const merged = `${LIBS_PGO_DIR}/${stage}-${name}.profdata`;
        await $`llvm-profdata merge -output=${merged} ${raws}`;
        // The context-sensitive counts have their own summary (--showcs); a trainer's profile holds one kind or the other.
        const summary = await $`llvm-profdata show --detailed-summary ${merged}`.text(),
            csSummary = await $`llvm-profdata show --showcs --detailed-summary ${merged}`.text(),
            total = (text: string) => Number(/^Total count: (\d+)/m.exec(text)?.[1] ?? 0);
        totals.set(merged, Math.max(total(summary), total(csSummary)));
    }

    const largest = Math.max(...totals.values()),
        weighted = [...totals].map(
            ([file, total]) => `--weighted-input=${total > 0 ? Math.max(1, Math.round(largest / total)) : 1},${file}`,
        );
    await $`llvm-profdata merge -output=${output} ${base} ${weighted}`;
}

/**
 * Trains llvm-project's profile before it's built (its prepare step), in two stages from the same source:
 * 1. IR: a clang (and lld) instrumented before inlining compiles part of clang (--pgo clang) and links ImageMagick
 *    (--pgo lld); the counts become the IR profile.
 * 2. Context-sensitive: a full-LTO clang (and lld) built with the IR profile and instrumented after LTO's inlining runs
 *    the same training; its counts are merged with the IR profile.
 * The result is settings.llvmProfdata, which llvm-project's args pass as LLVM_PROFDATA_FILE; LLVM's CMake also passes it to the
 * (LTO) link, where the context-sensitive part applies.
 * Its name carries the key of everything it was trained from (resolvePgoProfiles), so a new LLVM tag or compiler retrains it.
 * `llvmArgs` are llvm-project's release CMake args, `major` its version (CLANG64's resource dir is named after it),
 * `march` its -march/-mtune, which the context-sensitive stage matches since inlining depends on the target.
 */
export async function trainLlvm(path: string, llvmArgs: string, major: string, march: string) {
    // Only the training run writes profiles; other runs use the cached one or build without PGO.
    if (!settings.pgoTraining || !llvmPgo() || existsSync(settings.llvmProfdata)) {
        return;
    }
    if (settings.pgo.has("lld") && !existsSync(`${DEV_CLANG}/release/include/ImageMagick-7`)) {
        throw new Error(`--pgo lld links ImageMagick from ${DEV_CLANG}, which isn't built yet: build the libraries first.`);
    }
    // prepare runs before buildVariants' updateEnv: without this, CFLAGS holds the last library's -fprofile-use, which -fprofile-generate rejects.
    await updateEnv(false);
    for (const dir of ["instrument", "cs-instrument", "train", "lld-train"]) {
        await rm(`${LLVM_PGO_DIR}/${dir}`, { force: true, recursive: true });
    }

    // -O3 without -flto: IR instrumentation happens before LTO anyway; the training file matches the Windows release script.
    const llvmSrc = `${path}/llvm`,
        inst = `${LLVM_PGO_DIR}/instrument`,
        csInst = `${LLVM_PGO_DIR}/cs-instrument`,
        trainDir = `${LLVM_PGO_DIR}/train`,
        lldDir = `${LLVM_PGO_DIR}/lld-train`,
        irProfdata = `${inst}/ir.profdata`,
        instProfdata = `${inst}/bin/llvm-profdata.exe`,
        cflags = "-O3 -march=x86-64-v3 -mtune=generic",
        csCflags = `-O3 -march=${march} -mtune=${march}`,
        withLld = settings.pgo.has("lld"),
        projects = withLld ? "clang;lld" : "clang",
        tools = withLld ? ["clang", "lld"] : ["clang"];

    const buildInstrumented = async (dir: string, flags: string, instrumentArgs: string[], targets: string[]) => {
        await $`cmake -G Ninja -S ${llvmSrc} -B ${dir} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_FLAGS_RELEASE=${flags} -DCMAKE_CXX_FLAGS_RELEASE=${flags} ${instrumentArgs} ${raw(llvmArgs)} -DLLVM_ENABLE_PROJECTS=${projects} -DLLVM_ENABLE_RUNTIMES= -DLLVM_DISTRIBUTION_COMPONENTS= -DCLANG_DEFAULT_CXX_STDLIB=libc++ -DCLANG_DEFAULT_RTLIB=compiler-rt -DCLANG_DEFAULT_UNWINDLIB=libunwind`.env({ ...process.env, PKG_CONFIG_PATH: `${MSYS2_ROOT}/clang64/lib/pkgconfig;${MSYS2_ROOT}/clang64/share/pkgconfig` });
        await $`ninja ${targets}`.cwd(dir);
        if (withLld) {
            // ld.lld is not a ninja target here; the lld binary is what ld.lld symlinks to, and --ld-path needs the ld.lld name.
            await $`cp ${dir}/bin/lld.exe ${dir}/bin/ld.lld.exe`;
        }
    };

    // The instrumented clang lives outside the CLANG64 prefix, so it needs CLANG64's resource dir, libc++ and compiler-rt/libunwind to link.
    // --sysroot: otherwise its MinGW driver takes the CRT from a gcc found on PATH (the CI runner's C:/mingw64) and mixes it with CLANG64's libs.
    const clang64 = `${MSYS2_ROOT}/clang64`,
        resourceDir = `${clang64}/lib/clang/${major}`,
        trainRuntime = `--sysroot=${clang64} -resource-dir ${resourceDir} -rtlib=compiler-rt --unwindlib=libunwind -L ${clang64}/lib`,
        trainCFlags = `${trainRuntime} -isystem ${resourceDir}/include -isystem ${clang64}/include`,
        trainCxxFlags = `${trainRuntime} -stdlib=libc++ -isystem ${clang64}/include/c++/v1 -isystem ${resourceDir}/include -isystem ${clang64}/include`,
        // The instrumented binaries (llvm-profdata.exe included) need CLANG64's DLLs (libc++, libxml2) on PATH, otherwise they exit with STATUS_DLL_NOT_FOUND.
        clang64Env = { ...process.env, PATH: `${clang64}/bin;${process.env.PATH ?? ""}` },
        mainCpp = `${lldDir}/main.cpp`,
        magickDefs = [...MAGICK_DEFINES, "-D_MT"];

    if (withLld) {
        await mkdir(lldDir, { recursive: true });
        await writeFile(
            mainCpp,
            '#include <MagickWand/MagickWand.h>\nint main() {\n    MagickWandGenesis();\n    MagickWand* wand = NewMagickWand();\n    MagickReadImage(wand, "xc:red");\n    MagickWriteImage(wand, "out.png");\n    DestroyMagickWand(wand);\n    MagickWandTerminus();\n}\n',
        );
    }

    /** Runs the training workloads with the instrumented tools in `dir`, returning the raw profiles they wrote to `rawDir`. */
    const train = async (dir: string, rawDir: string): Promise<string[]> => {
        await mkdir(rawDir, { recursive: true });

        if (settings.pgo.has("clang")) {
            await rm(trainDir, { force: true, recursive: true });
            await $`cmake -G Ninja -S ${llvmSrc} -B ${trainDir} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=${`${dir}/bin/clang.exe`} -DCMAKE_CXX_COMPILER=${`${dir}/bin/clang++.exe`} -DLLVM_ENABLE_LIBCXX=ON -DLLVM_ENABLE_PROJECTS=clang -DLLVM_TARGETS_TO_BUILD=Native -DCMAKE_C_FLAGS=${trainCFlags} -DCMAKE_CXX_FLAGS=${trainCxxFlags} -DCMAKE_C_FLAGS_RELEASE=${`${cflags} ${trainCFlags}`} -DCMAKE_CXX_FLAGS_RELEASE=${`${cflags} ${trainCxxFlags}`} -DCMAKE_EXE_LINKER_FLAGS=${`${trainRuntime} -stdlib=libc++`} -DCMAKE_SHARED_LINKER_FLAGS=${`${trainRuntime} -stdlib=libc++`} -DCMAKE_MODULE_LINKER_FLAGS=${`${trainRuntime} -stdlib=libc++`}`;
        }

        // Building the instrumented tools and configuring with them writes profiles that aren't representative; drop them before training.
        await Promise.all((await profraws(rawDir)).map((file) => rm(file)));

        if (settings.pgo.has("clang")) {
            await $`ninja tools/clang/lib/Sema/CMakeFiles/obj.clangSema.dir/Sema.cpp.obj`.cwd(trainDir);
        }

        if (withLld) {
            // lld training (not part of the upstream script): link ImageMagick and its dependency chain with the instrumented ld.lld,
            // driven by the regular clang. Release is a static full-LTO link (the LTO path), debug a non-LTO ASAN/DWARF link against the import libs.
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
                    "-g",
                    "-fsanitize=address",
                    "-D_DLL",
                    ...magickDefs,
                    `-I${DEV_CLANG}/debug/include/ImageMagick-7`,
                    `-L${DEV_CLANG}/debug/lib`,
                    `-lMagickWand-7.${magickSuffix(MAGICK_PGO_VARIANT)}`,
                    "-o",
                    `${lldDir}/debug.exe`,
                ];
            await $`clang++ ${releaseArgs}`.env(clang64Env);
            await $`clang++ ${debugArgs}`.env(clang64Env);
        }

        return profraws(rawDir);
    };

    // 1. IR profile.
    await buildInstrumented(inst, cflags, ["-DLLVM_BUILD_INSTRUMENTED=IR"], [...tools, "llvm-profdata"]);
    await $`${instProfdata} merge -output=${irProfdata} ${await train(inst, `${inst}/profiles`)}`.env(clang64Env);

    // 2. Context-sensitive profile, from a full-LTO build like the final one. One link job: two full-LTO links at once can run out of memory.
    await buildInstrumented(
        csInst,
        csCflags,
        ["-DLLVM_BUILD_INSTRUMENTED=CSIR", `-DLLVM_PROFDATA_FILE=${irProfdata}`, "-DLLVM_ENABLE_LTO=Full", "-DLLVM_PARALLEL_LINK_JOBS=1"],
        tools,
    );
    await mkdir(PROFILES_DIR, { recursive: true });
    await $`${instProfdata} merge -output=${settings.llvmProfdata} ${irProfdata} ${await train(csInst, `${csInst}/csprofiles`)}`.env(clang64Env);
    await removeStaleProfiles(settings.llvmProfdata, "llvm-");
}
