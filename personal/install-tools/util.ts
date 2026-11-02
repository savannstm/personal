import { execFile } from "node:child_process";
import console from "node:console";
import { createWriteStream, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { result, stage, track, transfer } from "./ui.ts";

const execFileAsync = promisify(execFile);

const elapsed = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;

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
    const headers: Record<string, string> = { "User-Agent": "install-tools" };
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

export async function download(url: string, dest: string): Promise<string> {
    stage("download");
    const response = await get(url),
        body = Readable.fromWeb(response.body!),
        received = transfer(Number(response.headers.get("content-length")) || 0);
    body.on("data", (chunk: Uint8Array) => received(chunk.length));
    await pipeline(body, createWriteStream(dest));
    return response.url;
}

export async function redirectTarget(url: string): Promise<string> {
    const response = await fetch(url, { headers: headersFor(url), method: "HEAD", redirect: "manual" });
    return response.headers.get("location") ?? url;
}

let ghEnabled = false;

export async function enableGh(): Promise<void> {
    ghEnabled = true;
    if (!process.env.GITHUB_TOKEN) {
        const token = (await run("gh", ["auth", "token"], { okCodes: [0, 1] }).catch(() => "")).trim();
        if (token) {
            process.env.GITHUB_TOKEN = token;
        }
    }
}

interface GithubRelease {
    tag_name: string;
    assets: { browser_download_url: string; name: string; updated_at: string }[];
}

async function githubApi<T>(endpoint: string): Promise<T> {
    if (ghEnabled) {
        try {
            return JSON.parse(await run("gh", ["api", endpoint])) as T;
        } catch {
            // gh missing from PATH or API error: fall back to the plain request below.
        }
    }
    return getJson<T>(`https://api.github.com/${endpoint}`);
}

export async function githubRelease(repo: string, assetPattern: RegExp, tag?: string): Promise<Release> {
    const release = await githubApi<GithubRelease>(`repos/${repo}/releases/${tag ? `tags/${tag}` : "latest"}`);
    const asset = release.assets.find((a) => assetPattern.test(a.name));
    if (!asset) {
        throw new Error(`${repo}: no release asset matches ${assetPattern}`);
    }
    return { url: asset.browser_download_url, version: tag ? asset.updated_at : release.tag_name };
}

export async function githubReleaseMatching(
    repo: string,
    tagPattern: RegExp,
    assetName: (tag: string) => string,
): Promise<Release> {
    const releases = await githubApi<GithubRelease[]>(`repos/${repo}/releases?per_page=100`),
        release = releases
            .filter((r) => tagPattern.test(r.tag_name))
            .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
    const asset = release?.assets.find((a) => a.name === assetName(release.tag_name));
    if (!release || !asset) {
        throw new Error(`${repo}: no release matches ${tagPattern} with the expected asset`);
    }
    return { url: asset.browser_download_url, version: release.tag_name };
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
        const started = Date.now();
        try {
            const current = (await track(name, async () => fn())) === "current";
            (current ? this.current : this.installed).push(name);
            result(current ? "current" : "done", name, current ? "" : `(${elapsed(started)})`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.failed.push([name, message]);
            result("failed", name, message);
        }
    }
}

const GIT_CONFIG: [string, string][] = [
    ["user.name", "savannstm"],
    ["user.email", "savannstm@gmail.com"],
    // Commit LF only (CRLF is converted on commit), never rewrite line endings on checkout.
    ["core.autocrlf", "input"],
    ["core.eol", "lf"],
];

export async function configureGit(git: string): Promise<void> {
    for (const [key, value] of GIT_CONFIG) {
        await run(git, ["config", "--global", key, value]);
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
    "cargo-fuzz",
    "cargo-semver-checks",
    "neocmakelsp",
    "sccache",
    "cargo-nextest",
    "cargo-deny",
    "cargo-expand",
    "bacon",
    "cargo-llvm-cov",
    "cargo-hack",
    "cargo-cache",
    "typos-cli",
    "taplo-cli",
    "hyperfine",
];

export async function cargoTools(report: Report, binstallArgs: string[] = []): Promise<void> {
    await report.step("cargo tools", async () => {
        await run("cargo", ["binstall", "-y", ...binstallArgs, ...CARGO_CRATES]);
    });
}

export async function uvTools(report: Report, env: Record<string, string> = {}): Promise<void> {
    await report.step("uv:python", async () => {
        await run("uv", ["python", "install", "3.14"], { env });
    });
    await report.step("uv:litellm", async () => {
        await run("uv", ["tool", "install", "litellm"], { env });
        await run("uv", ["tool", "upgrade", "--all"], { env });
    });
}

export async function installRustToolchains(toolchains: string[], nightly = "nightly"): Promise<void> {
    const toolchainsDir = join(process.env["RUSTUP_HOME"] ?? join(homedir(), ".rustup"), "toolchains");
    if (existsSync(toolchainsDir)) {
        for (const toolchain of readdirSync(toolchainsDir)) {
            const rustlib = join(toolchainsDir, toolchain, "lib", "rustlib");
            for (const file of existsSync(rustlib) ? readdirSync(rustlib) : []) {
                if (file.startsWith("manifest-rust-analyzer-preview-")) rmSync(join(rustlib, file));
            }
            // rustup's components list still names rust-analyzer-preview; with its manifest gone, `rustup update` fails reading it.
            const components = join(rustlib, "components");
            if (existsSync(components)) {
                const text = readFileSync(components, "utf8");
                if (text.includes("rust-analyzer-preview-")) {
                    const kept = text.split("\n").filter((line) => !line.startsWith("rust-analyzer-preview-"));
                    writeFileSync(components, kept.join("\n"));
                    for (const exe of ["rust-analyzer", "rust-analyzer.exe"]) {
                        rmSync(join(toolchainsDir, toolchain, "bin", exe), { force: true });
                    }
                }
            }
            rmSync(join(toolchainsDir, toolchain, "share", "doc", "rust-analyzer"), { recursive: true, force: true });
        }
    }
    await run("rustup", [
        "toolchain",
        "install",
        ...toolchains,
        "--profile",
        "minimal",
        "--allow-downgrade",
        ...["clippy", "rustfmt", "rust-src", "rust-analyzer"].flatMap((c) => ["-c", c]),
    ]);
    await run("rustup", ["default", nightly]);
    await run("rustup", ["component", "add", "miri", "--toolchain", nightly]);
    await run("rustup", ["target", "add", "armv8r-none-eabihf", "--toolchain", nightly]);
}
