// Tag conventions vary wildly across upstreams (v1.2.3, VER-1-2-3, name-1.2.3, bare branch
// names, ...), so tags alone can't be diffed for "is there a newer version". Arch Linux's
// package database normalizes each package to a clean pkgver, so we cross-check against that
// instead: https://archlinux.org/packages/search/json/?name=<pkg>

import consola from "consola";
import pc from "picocolors";

import { getPin, resolveLibraryName } from "./libraries.ts";

interface ArchSearchResult {
    pkgname: string;
    pkgver: string;
}

async function fetchArchVersion(pkgName: string): Promise<null | string> {
    const res = await fetch(`https://archlinux.org/packages/search/json/?name=${encodeURIComponent(pkgName)}`, {
        headers: { "User-Agent": "build-dev-libraries-check-updates" },
    });
    if (!res.ok) {
        return null;
    }

    const { results } = (await res.json()) as { results: ArchSearchResult[] };
    return results.find((r) => r.pkgname === pkgName)?.pkgver ?? null;
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
        const archVersion = await fetchArchVersion(archPkg);

        if (archVersion === null) {
            consola.log(`${pc.dim(name.padEnd(20))} no Arch package "${archPkg}" found`);
            continue;
        }

        const cmp = compareVersions(pinnedVersion, archVersion);
        const status =
            cmp < 0
                ? pc.yellow(`OUTDATED (Arch has ${archVersion})`)
                : cmp > 0
                  ? pc.cyan(`ahead of Arch (${archVersion})`)
                  : pc.green("up to date");

        consola.log(`${name.padEnd(20)} pinned=${pinnedVersion.padEnd(12)} arch=${archVersion.padEnd(12)} ${status}`);
    }
}
