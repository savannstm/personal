import { execFile } from "node:child_process";
import console from "node:console";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Release {
    url: string;
    version: string;
}

export type Outcome = "current" | "installed";

interface ExecError extends Error {
    code?: number | string;
    stdout?: string;
    stderr?: string;
}

export interface RunOptions {
    env?: Record<string, string>;
    okCodes?: number[];
}

export async function run(file: string, args: string[], { env, okCodes = [0] }: RunOptions = {}): Promise<string> {
    try {
        const { stdout } = await execFileAsync(file, args, {
            env: env ? { ...process.env, ...env } : process.env,
            maxBuffer: 1 << 28,
            windowsHide: true,
        });
        return stdout;
    } catch (error) {
        const { code, message, stderr, stdout } = error as ExecError;
        if (typeof code === "number" && okCodes.includes(code)) {
            return stdout ?? "";
        }
        const tail = (stderr || stdout || message || "").trim().slice(-2000);
        throw new Error(`${file} ${args.join(" ")} failed (${code}): ${tail}`);
    }
}

function headersFor(url: string): Record<string, string> {
    const headers: Record<string, string> = { "User-Agent": "install-dev-tools" };
    const token = process.env.GITHUB_TOKEN;
    if (token && /^https:\/\/(api\.)?github\.com\//.test(url)) {
        headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}

async function get(url: string): Promise<Response> {
    const response = await fetch(url, { headers: headersFor(url) });
    if (!response.ok) {
        throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
    }
    return response;
}

export async function getJson<T>(url: string): Promise<T> {
    return (await (await get(url)).json()) as T;
}

export async function getText(url: string): Promise<string> {
    return (await get(url)).text();
}

/** Downloads `url` to `dest`. Returns the final URL after redirects. */
export async function download(url: string, dest: string): Promise<string> {
    const response = await get(url);
    await pipeline(Readable.fromWeb(response.body!), createWriteStream(dest));
    return response.url;
}

/** First redirect target of `url` (versioned for aka.ms / GitHub "latest" links), or `url` itself if it doesn't redirect. */
export async function redirectTarget(url: string): Promise<string> {
    const response = await fetch(url, { headers: headersFor(url), method: "HEAD", redirect: "manual" });
    return response.headers.get("location") ?? url;
}

interface GithubRelease {
    tag_name: string;
    assets: { browser_download_url: string; name: string; updated_at: string }[];
}

/**
 * Latest GitHub release asset matching `assetPattern`. With a fixed `tag` (rolling releases),
 * the version is the asset's update time since the tag never changes.
 */
export async function githubRelease(repo: string, assetPattern: RegExp, tag?: string): Promise<Release> {
    const release = await getJson<GithubRelease>(
        `https://api.github.com/repos/${repo}/releases/${tag ? `tags/${tag}` : "latest"}`,
    );
    const asset = release.assets.find((a) => assetPattern.test(a.name));
    if (!asset) {
        throw new Error(`${repo}: no release asset matches ${assetPattern}`);
    }
    return { url: asset.browser_download_url, version: tag ? asset.updated_at : release.tag_name };
}

export function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

export type Zig = Record<string, Record<string, { tarball: string } | string>>;

/** Latest stable Zig release for `target` (e.g. "x86_64-windows"). */
export async function zigRelease(target: string): Promise<Release> {
    const index = await getJson<Zig>("https://ziglang.org/download/index.json");
    const version = Object.keys(index)
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        .sort(compareVersions)
        .at(-1);
    const entry = version && index[version]?.[target];
    if (!version || typeof entry !== "object") {
        throw new Error(`No stable Zig release for ${target}`);
    }
    return { url: entry.tarball, version };
}

/** Runs `fn` over `items` with at most `limit` in flight. Never rejects; failures come back as results. */
export async function pool<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    const results = Array<PromiseSettledResult<R>>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            try {
                results[index] = { status: "fulfilled", value: await fn(items[index]!) };
            } catch (reason) {
                results[index] = { reason, status: "rejected" };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export class Report {
    current: string[] = [];
    failed: [string, string][] = [];
    installed: string[] = [];

    print(): void {
        console.log(`installed/updated (${this.installed.length}): ${this.installed.join(", ") || "-"}`);
        console.log(`up to date (${this.current.length}): ${this.current.join(", ") || "-"}`);
        for (const [name, message] of this.failed) {
            console.error(`FAILED ${name}: ${message}`);
        }
        process.exitCode = this.failed.length > 0 ? 1 : 0;
    }

    /** Runs a named step, recording its outcome. Never throws. */
    async step(name: string, fn: () => Outcome | Promise<Outcome | void> | void): Promise<void> {
        console.log(`[start] ${name}`);
        try {
            const current = (await fn()) === "current";
            (current ? this.current : this.installed).push(name);
            console.log(`[${current ? "up to date" : "done"}] ${name}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.failed.push([name, message]);
            console.error(`[error] ${name}: ${message}`);
        }
    }
}

const CARGO_CRATES = [
    "cargo-binstall",
    "cargo-update",
    "ripgrep",
    "sd",
    "fd-find",
    "tokei",
    "cargo-c",
    "wasm-pack",
    "cargo-machete",
    "cargo-clean-all",
    "cargo-msrv",
    "cbindgen",
    "cargo-sort",
    "cargo-sort-derives",
    "cargo-about",
];

/** cargo-binstall is idempotent: it installs missing crates and moves outdated ones to the latest version. */
export async function cargoTools(report: Report): Promise<void> {
    for (const crate of CARGO_CRATES) {
        await report.step(`cargo:${crate}`, async () => {
            await run("cargo", ["binstall", "-y", crate]);
        });
    }
}

export async function uvTools(report: Report, env: Record<string, string> = {}): Promise<void> {
    await report.step("uv:python", async () => {
        await run("uv", ["python", "install"], { env });
    });
    await report.step("uv:meson", async () => {
        await run("uv", ["tool", "install", "meson"], { env });
        await run("uv", ["tool", "upgrade", "--all"], { env });
    });
}

/** Installs (or updates) the given rustup toolchains with the usual components; nightly stays the default. */
export async function installRustToolchains(toolchains: string[]): Promise<void> {
    await run("rustup", [
        "toolchain",
        "install",
        ...toolchains,
        "--profile",
        "minimal",
        "--allow-downgrade",
        ...["clippy", "rustfmt", "rust-src", "rust-analyzer"].flatMap((c) => ["-c", c]),
    ]);
    await run("rustup", ["default", "nightly"]);
}
