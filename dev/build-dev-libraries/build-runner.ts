import consola from "consola";
import $ from "dax";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import pc from "picocolors";

import { BUILD_STATE_FILE, buildRoot, DBG_ROOT, REL_ROOT, REPOS_ROOT, WIN } from "./config.ts";
import { buildCMake, buildMeson, customBuild, posthook, prehook } from "./hooks.ts";
import { getPin, LIBRARIES, resolveLibraryName, shouldBuildLibrary } from "./libraries.ts";
import { configureToolchain, updateEnv } from "./toolchain.ts";

const TOOLCHAIN_PROFILES: Record<string, ToolchainProfile> = {
    "double-conversion": { asan: false, debugOpt: true, fastmath: false, rtti: false },
    ffmpeg: { asan: true, debugOpt: false, fastmath: false, rtti: false },
    highway: { asan: false, debugOpt: true, fastmath: false, rtti: false },
    icu: { asan: false, debugOpt: true, fastmath: true, rtti: true },
    imagemagick: { asan: true, debugOpt: false, fastmath: false, rtti: false },
    imath: { asan: false, debugOpt: true, fastmath: false, rtti: false },
    libheif: { asan: false, debugOpt: true, fastmath: true, rtti: true },
    libjxl: { asan: false, debugOpt: true, fastmath: false, rtti: false },
    libraw: { asan: false, debugOpt: true, fastmath: false, rtti: false },
    nuspell: { asan: false, debugOpt: true, fastmath: true, rtti: false },
    openexr: { asan: false, debugOpt: true, fastmath: false, rtti: false },
    projectm: { asan: false, debugOpt: false, fastmath: false, rtti: false },
    qt5: { asan: true, debugOpt: false, fastmath: true, rtti: true },
    "quickjs-ng": { asan: false, debugOpt: true, fastmath: false, rtti: false },
};

export async function buildRepos(options: CliOptions) {
    const selected = LIBRARIES.map((library) => ({
        ...library,
        name: resolveLibraryName(library),
    })).filter((lib) => shouldBuildLibrary(lib.name, options));

    if (selected.length === 0) {
        consola.warn("No libraries matched the given filters.");
        process.exit(0);
    }

    if (!existsSync(REPOS_ROOT)) {
        await $`mkdir -p ${REPOS_ROOT}`;
    }

    if (WIN) {
        await $`mv C:/msys64/usr/bin/link.exe C:/msys64/usr/bin/!link.exe`.noThrow();
    }

    const state = await loadBuildState();

    for (const library of selected) {
        console.info(`Building ${library.name}...`);
        await invokeRepoBuild(library, options, state);
    }

    if (WIN && options.toolchain === "msvc") {
        await $`sd -s -- "-lm" "" $(rg -l -- "-lm" ${`${DBG_ROOT}/lib/pkgconfig`})`.noThrow().timeout(1000);
        await $`sd -s -- "-lm" "" $(rg -l -- "-lm" ${`${REL_ROOT}/lib/pkgconfig`})`.noThrow().timeout(1000);
    }

    await configureToolchain(options, { asan: false, debugOpt: false, fastmath: true, rtti: true });
}

async function buildVariants(
    library: Library,
    path: string,
    variants: boolean[],
    state: BuildState,
    pin: string,
    options: CliOptions,
) {
    if (existsSync(`${path}/.git`)) {
        await $`git reset --hard`.cwd(path).noThrow();
    }

    await configureToolchain(options, TOOLCHAIN_PROFILES[library.name!]);
    await prehook(library.name!, path);

    for (const isDebug of variants) {
        const vkey = `${library.name}:${isDebug ? "debug" : "release"}`;
        const prefix = buildRoot(isDebug);

        const prefixState = state.prefixes[prefix];
        if (prefixState && prefixState.toolchain !== options.toolchain) {
            consola.warn(
                pc.yellow(
                    `Prefix "${prefix}" was built with toolchain "${prefixState.toolchain}" but current toolchain is "${options.toolchain}". Entries for this prefix will be rebuilt.`,
                ),
            );
            const accepted = await $.confirm(`Clear all cached build state for prefix "${prefix}" and rebuild?`);
            if (accepted) {
                delete state.prefixes[prefix];
                await saveBuildState(state);
            } else {
                consola.warn(pc.yellow(`Skipping builds for prefix "${prefix}".`));
                continue;
            }
        }

        if (alreadyBuilt(state, vkey, prefix, pin, options)) {
            consola.info(
                pc.cyan(`[${library.name!}] Already built at ${pin} (${isDebug ? "debug" : "release"}), skipping.`),
            );
            continue;
        }

        await updateEnv(isDebug);

        if (!library.archiveSubdir) {
            await $`git clean -fdx`.cwd(path).noThrow();
        }

        switch (library.build) {
            case "Custom":
                await customBuild(library.name!, path, isDebug);
                break;
            case "Meson":
                await buildMeson(library.name!, path, isDebug);
                break;
            default:
                await buildCMake(library.name!, path, library.sourceSubdir ?? "", isDebug);
        }

        await markBuilt(state, vkey, prefix, pin, options.toolchain);
    }

    await posthook(library.name!, path, options);
}

async function loadBuildState(): Promise<BuildState> {
    if (!existsSync(BUILD_STATE_FILE)) {
        return {
            prefixes: {},
        };
    }
    try {
        const raw = await readFile(BUILD_STATE_FILE, "utf8");
        const parsed: BuildState = JSON.parse(raw) as BuildState;
        return parsed;
    } catch {
        return { prefixes: {} };
    }
}

async function saveBuildState(state: BuildState): Promise<void> {
    await writeFile(BUILD_STATE_FILE, JSON.stringify(state, null, 4));
}

function alreadyBuilt(state: BuildState, key: string, prefix: string, pin: string, options: CliOptions): boolean {
    const prefixState = state.prefixes[prefix];
    if (!prefixState) {
        return false;
    }
    if (prefixState.toolchain !== options.toolchain) {
        return false;
    }
    const entry = prefixState.entries[key];
    return !options.force && entry?.tag === pin;
}

async function markBuilt(
    state: BuildState,
    key: string,
    prefix: string,
    pin: string,
    toolchain: Toolchain,
): Promise<void> {
    state.prefixes[prefix] ??= { entries: {}, toolchain };
    state.prefixes[prefix].toolchain = toolchain;
    state.prefixes[prefix].entries[key] = { tag: pin };
    await saveBuildState(state);
}

async function invokeRepoBuild(library: Library, options: CliOptions, state: BuildState) {
    const path = `${REPOS_ROOT}/${library.name}`,
        pin = getPin(library);

    const variants = options.onlyDebug === options.onlyRelease ? [true, false] : options.onlyDebug ? [true] : [false];

    if (
        variants.every((isDebug) =>
            alreadyBuilt(state, `${library.name}:${isDebug ? "debug" : "release"}`, buildRoot(isDebug), pin, options),
        )
    ) {
        return;
    }

    if (library.archiveSubdir) {
        if (existsSync(path)) {
            await $`rm -rf ${path}`;
        }

        await $`mkdir -p ${path}`;
        const fileName = library.url.split("/").pop()?.split("?")[0] ?? "archive",
            archivePath = `${path}.${fileName.split(".").slice(1).join(".") || "tmp"}`;
        if (!existsSync(archivePath)) {
            await $`curl -L -o ${archivePath} ${library.url}`;
        }
        if (WIN) {
            await $`"C:/Windows/System32/tar.exe" -xf ${archivePath} -C ${path}`;
        } else {
            await $`unzip -o ${archivePath} -d ${path}`;
        }

        const buildPath = `${path}/${library.archiveSubdir}`;
        await buildVariants(library, buildPath, variants, state, pin, options);
        return;
    }

    if (!existsSync(path)) {
        try {
            await $`git clone --branch ${pin} --depth 1 ${library.url} ${path}`;
        } catch {
            consola.warn(pc.yellow(`dump http transport: falling back to full clone`));
            await $`git clone --branch ${pin} ${library.url} ${path}`;
        }
    } else {
        await $`git fetch --tags --quiet`.cwd(path);
        await $`git checkout ${pin} --force`.cwd(path);
    }

    await buildVariants(library, path, variants, state, pin, options);
}
