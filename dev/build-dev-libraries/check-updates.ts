// Tag conventions vary wildly across upstreams (v1.2.3, VER-1-2-3, name-1.2.3, bare branch
// names, ...), so tags alone can't be diffed for "is there a newer version". Arch Linux's
// package database normalizes each package to a clean pkgver, so we cross-check against that
// instead. The repository databases (core.db, extra.db) are downloaded once per run from the
// freshest reachable public mirror: archlinux.org itself is never contacted.

import consola from "consola";
import pc from "picocolors";

import { getPin, resolveLibraryName } from "./libraries.ts";

const MIRRORS = [
        "https://mirror.pkgbuild.com",
        "https://geo.mirror.pkgbuild.com",
        "https://ftp.acc.umu.se/mirror/archlinux",
        "https://mirror.osbeck.com/archlinux",
        "https://at.arch.mirror.kescher.at",
        "https://mirror.selfnet.de/archlinux",
        "https://mirrors.dotsrc.org/archlinux",
        "https://mirrors.mit.edu/archlinux",
        "https://mirror.leaseweb.net/archlinux",
        "https://mirror.dogado.de/archlinux",
        "https://archlinux.mirror.liteserver.nl",
        "https://mirrors.xtom.com/archlinux",
        "https://mirror.yandex.ru/archlinux",
        "https://mirrors.tuna.tsinghua.edu.cn/archlinux",
        "https://mirrors.ustc.edu.cn/archlinux",
        "https://ftp.halifax.rwth-aachen.de/archlinux",
    ],
    MIRROR_REPOS = ["core", "extra"],
    HEADERS = { "User-Agent": "build-dev-libraries-check-updates" },
    SYNC_BUCKET_SECONDS = 3600;

/**
 * Reachable mirrors, best first. A fast mirror that lags upstream is useless for an update check, so
 * mirrors are bucketed by how far behind the newest `lastsync` they are, and only then ordered by latency.
 */
async function rankMirrors(): Promise<string[]> {
    const probed = (
        await Promise.all(
            MIRRORS.map(async (mirror) => {
                try {
                    const start = performance.now(),
                        res = await fetch(`${mirror}/lastsync`, { headers: HEADERS, signal: AbortSignal.timeout(6000) }),
                        sync = Number.parseInt(await res.text(), 10);
                    return res.ok && Number.isFinite(sync) ? { latency: performance.now() - start, mirror, sync } : null;
                } catch {
                    return null;
                }
            }),
        )
    ).filter((m) => m !== null);

    const newest = Math.max(...probed.map((m) => m.sync)),
        bucket = (sync: number) => Math.floor((newest - sync) / SYNC_BUCKET_SECONDS);

    return probed.sort((a, b) => bucket(a.sync) - bucket(b.sync) || a.latency - b.latency).map((m) => m.mirror);
}

/** pkgname -> pkgver (epoch and pkgrel stripped, like the package search API reports it) from a repo .db. */
async function loadRepoDb(mirror: string, repo: string): Promise<Map<string, string>> {
    const res = await fetch(`${mirror}/${repo}/os/x86_64/${repo}.db`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body) {
        throw new Error(`${mirror}: ${repo}.db: ${res.status} ${res.statusText}`);
    }

    // The .db is a gzipped tar of `<name>-<ver>-<rel>/desc` entries; only those are read.
    const tar = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()),
        text = new TextDecoder(),
        versions = new Map<string, string>();

    for (let offset = 0; offset + 512 <= tar.length; ) {
        const name = text.decode(tar.subarray(offset, offset + 100)).split("\0", 1)[0]!;
        if (!name) {
            break;
        }

        const size = Number.parseInt(text.decode(tar.subarray(offset + 124, offset + 135)), 8),
            body = offset + 512;

        if (name.endsWith("/desc")) {
            const desc = text.decode(tar.subarray(body, body + size)),
                pkgName = /%NAME%\n(.+)/.exec(desc)?.[1],
                version = /%VERSION%\n(.+)/.exec(desc)?.[1];
            if (pkgName && version) {
                versions.set(pkgName, version.replace(/^\d+:/, "").replace(/-[^-]+$/, ""));
            }
        }

        offset = body + Math.ceil(size / 512) * 512;
    }

    return versions;
}

async function loadMirrorVersions(): Promise<Map<string, string>> {
    const ranked = await rankMirrors();
    if (ranked.length === 0) {
        throw new Error("no Arch mirror is reachable");
    }

    // A mirror can answer `lastsync` and still fail the (much larger) .db download, so fall through the ranking.
    for (const mirror of ranked) {
        try {
            const dbs = await Promise.all(MIRROR_REPOS.map((repo) => loadRepoDb(mirror, repo)));
            consola.info(`Using Arch mirror ${mirror}`);
            return new Map(dbs.flatMap((db) => [...db]));
        } catch (error) {
            consola.warn(pc.yellow(`${error instanceof Error ? error.message : String(error)}, trying the next mirror`));
        }
    }
    throw new Error("could not read the package databases from any Arch mirror");
}

// Best-effort: strip a leading name prefix and turn separator dashes into dots.
// Wrong on names that end in a digit baked into the tag (handled via manual `version` overrides).
function normalizeVersion(raw: string): string {
    return raw.replace(/^\D+/, "").replaceAll("-", ".");
}

function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
    const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

export async function checkLibraryUpdates(libraries: Library[]): Promise<void> {
    const archVersions = await loadMirrorVersions();

    for (const library of libraries) {
        const name = resolveLibraryName(library);
        const pin = getPin(library);

        const pinnedRaw = library.version ?? (library.archiveSubdir ? "" : pin);
        if (!pinnedRaw || !/\d/.test(pinnedRaw)) {
            consola.log(`${pc.dim(name.padEnd(20))} tracking a branch/no version tag, skipped`);
            continue;
        }

        const pinnedVersion = normalizeVersion(pinnedRaw);
        const archPkg = library.archPkg ?? name;
        const archVer = archVersions.get(archPkg);

        if (archVer === undefined) {
            consola.log(`${pc.dim(name.padEnd(20))} no Arch package "${archPkg}" found`);
            continue;
        }

        const cmp = compareVersions(pinnedVersion, archVer);
        const status =
            cmp < 0
                ? pc.yellow(`OUTDATED (Arch has ${archVer})`)
                : cmp > 0
                  ? pc.cyan(`ahead of Arch (${archVer})`)
                  : pc.green("up to date");

        consola.log(`${name.padEnd(20)} pinned=${pinnedVersion.padEnd(12)} arch=${archVer.padEnd(12)} ${status}`);
    }
}
