import consola from "consola";
import $ from "dax";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import pc from "picocolors";

import { buildCMake, buildMeson, buildRust } from "./builders.ts";
import { getPin, LIBRARIES, shouldBuildLibrary } from "./libraries.ts";
import { TrainingDone } from "./pgo-common.ts";
import { pgoStamp } from "./pgo.ts"; // circular with pgo.ts (it builds the chain), but only used inside functions
import { buildRoot, ROOT, settings, WIN_TAR } from "./settings.ts";
import { configureToolchain, CONSUMER_PROFILE, profileOf, updateEnv } from "./toolchain.ts";
import type { BuildState, Ctx, Library } from "./types.ts";

const BUILD_STATE_FILE = `${ROOT}/build-state.json`;

const BUILDERS = { cmake: buildCMake, meson: buildMeson, rust: buildRust };

export function skipReason(library: Library): null | string {
    if (library.toolchains && !library.toolchains.includes(settings.toolchain)) {
        return `${library.toolchains.join("/")} only`;
    }
    if (settings.toolchain === "clang" && !settings.onlyRelease && profileOf(library).debugOpt) {
        return "debug-optimized dependency, clang uses its CLANG64 package (--only-release builds it)";
    }
    return null;
}

export async function buildRepos() {
    const selected: Library[] = [],
        skipped = new Map<string, string[]>();
    for (const library of LIBRARIES) {
        if (!shouldBuildLibrary(library.name)) {
            continue;
        }
        const reason = skipReason(library);
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

    mkdirSync(settings.reposRoot, { recursive: true });

    const state = loadBuildState();

    try {
        for (const library of selected) {
            console.info(`Building ${library.name}...`);
            await buildLibrary(library, state);
        }
    } catch (error) {
        if (!(error instanceof TrainingDone)) {
            throw error;
        }
        consola.success(pc.green(error.message));
    }

    await stripLibmFromMsvcPkgconfig();
    configureToolchain(CONSUMER_PROFILE);
}

async function stripLibmFromMsvcPkgconfig() {
    if (settings.toolchain !== "msvc") {
        return;
    }
    for (const root of [buildRoot(true), buildRoot(false)]) {
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

function stampOf(library: Library, pin: string, withVariants = true): string {
    return [pin, withVariants && library.variants?.(), pgoStamp(library)].filter(Boolean).join("|");
}

async function buildLibrary(library: Library, state: BuildState) {
    const path = `${settings.reposRoot}/${library.name}`,
        { source } = library,
        git = "git" in source ? source : null;
    let pin = getPin(library);

    let variants = [true, false];
    if (settings.onlyDebug !== settings.onlyRelease) {
        variants = [settings.onlyDebug];
    }
    if (library.releaseOnly) {
        variants = variants.filter((isDebug) => !isDebug);
    }

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
            ),
        )
    ) {
        return;
    }

    if ("archive" in source) {
        const { archive, subdir } = source;
        rmSync(path, { force: true, recursive: true });
        mkdirSync(path, { recursive: true });
        const fileName = archive.split("/").pop()?.split("?")[0] ?? "archive",
            archivePath = `${path}.${fileName.split(".").slice(1).join(".") || "tmp"}`;
        if (!existsSync(archivePath)) {
            await $`curl -fL -o ${`${archivePath}.part`} ${archive}`;
            renameSync(`${archivePath}.part`, archivePath);
        }
        await $`${WIN_TAR} -xf ${archivePath} -C ${path}`;

        await buildVariants(library, `${path}/${subdir}`, variants, state, pin);
        return;
    }

    if (!tracksBranch) {
        await syncGit(path, source);
    }

    await buildVariants(library, path, variants, state, pin);
}

async function buildVariants(library: Library, path: string, variants: boolean[], state: BuildState, pin: string) {
    const msvc = settings.toolchain === "msvc";

    if (existsSync(`${path}/.git`)) {
        await $`git reset --hard`.cwd(path).noThrow();
    }

    configureToolchain(profileOf(library));
    await library.prepare?.({ msvc, path });

    for (const isDebug of variants) {
        const variant = isDebug ? "debug" : "release",
            vkey = `${library.name}:${variant}`,
            root = buildRoot(isDebug);

        const prefixState = state.prefixes[root];
        if (prefixState && prefixState.toolchain !== settings.toolchain) {
            consola.warn(
                pc.yellow(
                    `Prefix "${root}" was built with toolchain "${prefixState.toolchain}" but current toolchain is "${settings.toolchain}". Entries for this prefix will be rebuilt.`,
                ),
            );
            const accepted = await $.confirm(`Clear all cached build state for prefix "${root}" and rebuild?`);
            if (accepted) {
                delete state.prefixes[root];
                saveBuildState(state);
            } else {
                consola.warn(pc.yellow(`Skipping builds for prefix "${root}".`));
                continue;
            }
        }

        if (alreadyBuilt(state, vkey, root, stampOf(library, pin))) {
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
                const subStamp = stampOf(library, pin, false);
                if (alreadyBuilt(state, subKey, root, subStamp)) {
                    consola.info(pc.cyan(`[${library.name}] ${sub} (${variant}) already built, skipping.`));
                    return;
                }
                await build();
                await markBuilt(state, subKey, root, subStamp);
            },
        };

        const build = library.build ?? "cmake";
        await (typeof build === "function" ? build(ctx) : BUILDERS[build](library, ctx));

        await library.finish?.(ctx);
        await markBuilt(state, vkey, root, stampOf(library, pin));
    }
}

function loadBuildState(): BuildState {
    if (!existsSync(BUILD_STATE_FILE)) {
        return { prefixes: {} };
    }
    try {
        return JSON.parse(readFileSync(BUILD_STATE_FILE, "utf8")) as BuildState;
    } catch (error) {
        consola.warn(
            pc.yellow(
                `Ignoring unreadable ${BUILD_STATE_FILE} (${error instanceof Error ? error.message : String(error)}): everything will be rebuilt.`,
            ),
        );
        return { prefixes: {} };
    }
}

function saveBuildState(state: BuildState): void {
    writeFileSync(`${BUILD_STATE_FILE}.tmp`, JSON.stringify(state, null, 4));
    renameSync(`${BUILD_STATE_FILE}.tmp`, BUILD_STATE_FILE);
}

export function alreadyBuilt(state: BuildState, key: string, prefix: string, pin: string): boolean {
    const prefixState = state.prefixes[prefix];
    if (!prefixState || prefixState.toolchain !== settings.toolchain) {
        return false;
    }
    return !settings.force && prefixState.entries[key]?.tag === pin;
}

async function markBuilt(state: BuildState, key: string, prefix: string, pin: string): Promise<void> {
    const { toolchain } = settings;
    state.prefixes[prefix] ??= { entries: {}, toolchain };
    state.prefixes[prefix].toolchain = toolchain;
    state.prefixes[prefix].entries[key] = { tag: pin };
    saveBuildState(state);
}
