import consola from "consola";
import $ from "dax";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import pc from "picocolors";

import { buildCMake, buildMeson, buildRust } from "./builders.ts";
import { getPin, LIBRARIES, shouldBuildLibrary } from "./libraries.ts";
import { BUILD_STATE_FILE, buildRoot, llvmPgo, MSYS2_ROOT, settings, WIN_TAR } from "./settings.ts";
import { configureToolchain, CONSUMER_PROFILE, profileOf, updateEnv } from "./toolchain.ts";
import type { BuildState, CliOptions, Ctx, Library, Toolchain } from "./types.ts";

const BUILDERS = { cmake: buildCMake, meson: buildMeson, rust: buildRust };

export function skipReason(library: Library, options: CliOptions): null | string {
    if (library.toolchains && !library.toolchains.includes(options.toolchain)) {
        return `${library.toolchains.join("/")} only`;
    }
    if (options.toolchain === "clang" && !options.onlyRelease && profileOf(library).debugOpt) {
        return "debug-optimized dependency, clang uses its CLANG64 package (--only-release builds it)";
    }
    return null;
}

export async function buildRepos(options: CliOptions) {
    const selected: Library[] = [],
        skipped = new Map<string, string[]>();
    for (const library of LIBRARIES) {
        if (!shouldBuildLibrary(library.name, options)) {
            continue;
        }
        const reason = skipReason(library, options);
        if (reason) {
            const names = skipped.get(reason) ?? [];
            names.push(library.name);
            skipped.set(reason, names);
        } else {
            selected.push(library);
        }
    }
    for (const [reason, names] of skipped) {
        consola.info(pc.dim(`Not built (${reason}): ${names.join(", ")}`));
    }

    if (selected.length === 0) {
        consola.warn("No libraries matched the given filters.");
        process.exit(0);
    }

    await mkdir(settings.reposRoot, { recursive: true });
    await hideMsysLinkExe();

    const state = await loadBuildState();

    for (const library of selected) {
        console.info(`Building ${library.name}...`);
        await buildLibrary(library, options, state);
    }

    await stripLibmFromMsvcPkgconfig(options.toolchain);
    await configureToolchain(options, CONSUMER_PROFILE);
}

async function hideMsysLinkExe() {
    await $`mv ${MSYS2_ROOT}/usr/bin/link.exe ${MSYS2_ROOT}/usr/bin/!link.exe`.noThrow();
}

async function stripLibmFromMsvcPkgconfig(toolchain: Toolchain) {
    if (toolchain !== "msvc") {
        return;
    }
    for (const root of [buildRoot(true), buildRoot(false)]) {
        // \b after "m" keeps -lmimalloc and friends intact; a \b before "-" would never match after a space.
        await $`sd -- ${String.raw`-lm\b`} "" $(rg -l -- "-lm" ${`${root}/lib/pkgconfig`})`.noThrow().timeout(1000);
    }
}

const BRANCH_TAGS = new Set(["main", "master", "devel"]);

async function syncGit(path: string, { git, tag }: { git: string; tag: string }) {
    if (!existsSync(path)) {
        try {
            await $`git clone --branch ${tag} --depth 1 ${git} ${path}`;
        } catch {
            consola.warn(pc.yellow("Shallow clone failed, retrying with a full clone"));
            await $`git clone --branch ${tag} ${git} ${path}`;
        }
        return;
    }
    if (BRANCH_TAGS.has(tag)) {
        // Patches from the previous run are still in the tree and could block the pull.
        await $`git reset --hard`.cwd(path);
        await $`git pull`.cwd(path);
    } else {
        await $`git fetch --depth=1 origin tag ${tag}`.cwd(path);
    }
    await $`git checkout ${tag} --force`.cwd(path);
}

// What the build state compares against: a library that builds several variants also records which ones.
function stampOf(library: Library, pin: string): string {
    return library.variants ? `${pin}|${library.variants()}` : pin;
}

async function buildLibrary(library: Library, options: CliOptions, state: BuildState) {
    const path = `${settings.reposRoot}/${library.name}`,
        { source } = library,
        git = "git" in source ? source : null;
    let pin = getPin(library);

    let variants = [true, false];
    if (options.onlyDebug !== options.onlyRelease) {
        variants = [options.onlyDebug];
    }
    if (library.releaseOnly) {
        variants = variants.filter((isDebug) => !isDebug);
    }

    // A branch moves: update it first so the build state is keyed on the commit, not the branch name.
    const tracksBranch = git !== null && BRANCH_TAGS.has(git.tag);
    if (git && tracksBranch) {
        await syncGit(path, git);
        pin = `${git.tag}@${(await $`git rev-parse HEAD`.cwd(path).text()).trim()}`;
    }

    if (
        variants.every((isDebug) =>
            alreadyBuilt(
                state,
                `${library.name}:${isDebug ? "debug" : "release"}`,
                buildRoot(isDebug),
                stampOf(library, pin),
                options,
            ),
        )
    ) {
        return;
    }

    if ("archive" in source) {
        const { archive, subdir } = source;
        await rm(path, { force: true, recursive: true });
        await mkdir(path, { recursive: true });
        const fileName = archive.split("/").pop()?.split("?")[0] ?? "archive",
            archivePath = `${path}.${fileName.split(".").slice(1).join(".") || "tmp"}`;
        if (!existsSync(archivePath)) {
            // -f: an HTTP error must not be saved as the archive; the rename keeps an interrupted download out of the cache.
            await $`curl -fL -o ${`${archivePath}.part`} ${archive}`;
            await rename(`${archivePath}.part`, archivePath);
        }
        await $`${WIN_TAR} -xf ${archivePath} -C ${path}`;

        await buildVariants(library, `${path}/${subdir}`, variants, state, pin, options);
        return;
    }

    if (!tracksBranch) {
        await syncGit(path, source);
    }

    await buildVariants(library, path, variants, state, pin, options);
}

async function buildVariants(
    library: Library,
    path: string,
    variants: boolean[],
    state: BuildState,
    pin: string,
    options: CliOptions,
) {
    const msvc = options.toolchain === "msvc";

    if (existsSync(`${path}/.git`)) {
        await $`git reset --hard`.cwd(path).noThrow();
    }

    await configureToolchain(options, profileOf(library));
    const trainsLlvm =
        library.name === "llvm-project" &&
        settings.pgoTraining &&
        llvmPgo() &&
        (settings.pgoIrOnly || !existsSync(settings.llvmProfdata));
    await library.prepare?.({ msvc, path });
    if (trainsLlvm) {
        consola.success(pc.green("LLVM profile trained; skipping the build."));
        process.exit(0);
    }

    for (const isDebug of variants) {
        const variant = isDebug ? "debug" : "release",
            vkey = `${library.name}:${variant}`,
            root = buildRoot(isDebug);

        const prefixState = state.prefixes[root];
        if (prefixState && prefixState.toolchain !== options.toolchain) {
            consola.warn(
                pc.yellow(
                    `Prefix "${root}" was built with toolchain "${prefixState.toolchain}" but current toolchain is "${options.toolchain}". Entries for this prefix will be rebuilt.`,
                ),
            );
            const accepted = await $.confirm(`Clear all cached build state for prefix "${root}" and rebuild?`);
            if (accepted) {
                delete state.prefixes[root];
                await saveBuildState(state);
            } else {
                consola.warn(pc.yellow(`Skipping builds for prefix "${root}".`));
                continue;
            }
        }

        if (alreadyBuilt(state, vkey, root, stampOf(library, pin), options)) {
            consola.info(pc.cyan(`[${library.name}] Already built at ${pin} (${variant}), skipping.`));
            continue;
        }

        await updateEnv(isDebug);

        if ("git" in library.source) {
            await $`git clean -fdx`.cwd(path).noThrow();
        }

        const ctx: Ctx = {
            isDebug,
            msvc,
            path,
            root,
            step: async (sub, build) => {
                const subKey = `${vkey}:${sub}`;
                if (alreadyBuilt(state, subKey, root, pin, options)) {
                    consola.info(pc.cyan(`[${library.name}] ${sub} (${variant}) already built, skipping.`));
                    return;
                }
                await build();
                await markBuilt(state, subKey, root, pin, options.toolchain);
            },
        };

        const build = library.build ?? "cmake";
        await (typeof build === "function" ? build(ctx) : BUILDERS[build](library, ctx));

        await library.finish?.(ctx);
        await markBuilt(state, vkey, root, stampOf(library, pin), options.toolchain);
    }
}

async function loadBuildState(): Promise<BuildState> {
    if (!existsSync(BUILD_STATE_FILE)) {
        return { prefixes: {} };
    }
    try {
        return JSON.parse(await readFile(BUILD_STATE_FILE, "utf8")) as BuildState;
    } catch (error) {
        consola.warn(
            pc.yellow(
                `Ignoring unreadable ${BUILD_STATE_FILE} (${error instanceof Error ? error.message : String(error)}): everything will be rebuilt.`,
            ),
        );
        return { prefixes: {} };
    }
}

async function saveBuildState(state: BuildState): Promise<void> {
    // Write-then-rename: a kill mid-write must not leave a truncated state file.
    await writeFile(`${BUILD_STATE_FILE}.tmp`, JSON.stringify(state, null, 4));
    await rename(`${BUILD_STATE_FILE}.tmp`, BUILD_STATE_FILE);
}

export function alreadyBuilt(state: BuildState, key: string, prefix: string, pin: string, options: CliOptions): boolean {
    const prefixState = state.prefixes[prefix];
    if (!prefixState || prefixState.toolchain !== options.toolchain) {
        return false;
    }
    return !options.force && prefixState.entries[key]?.tag === pin;
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
