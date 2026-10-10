import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
    cargoTools,
    download,
    installRustToolchains,
    type Outcome,
    type Report,
    run,
    uvTools,
    zigRelease,
} from "./util.ts";

export type Family = "arch" | "debian";

// Priority: official repos first; the fallbacks below are only for packages the repos lack.
const PACKAGES: Record<Family, string[]> = {
    arch: [
        "base-devel",
        "curl",
        "ca-certificates",
        "git",
        "github-cli",
        "clang",
        "lld",
        "llvm",
        "lldb",
        "cmake",
        "ninja",
        "meson",
        "pkgconf",
        "nasm",
        "glslang",
        "bison",
        "flex",
        "ffmpeg",
        "imagemagick",
        "upx",
        "nodejs",
        "ruby",
        "jdk-openjdk",
        "7zip",
        "zig",
        "uv",
        "rustup",
        "deno",
    ],
    debian: [
        "build-essential",
        "curl",
        "ca-certificates",
        "git",
        "gh",
        "clang",
        "clang-format",
        "clang-tidy",
        "clangd",
        "lld",
        "llvm",
        "lldb",
        "cmake",
        "ninja-build",
        "meson",
        "pkgconf",
        "nasm",
        "glslang-tools",
        "bison",
        "flex",
        "ffmpeg",
        "imagemagick",
        "upx-ucl",
        "nodejs",
        "ruby",
        "default-jdk",
        "7zip",
        "zig",
        "uv",
        "rustup",
        "deno",
    ],
};

const HOME = homedir(),
    LOCAL_BIN = join(HOME, ".local", "bin"),
    CARGO_BIN = join(HOME, ".cargo", "bin"),
    isRoot = process.getuid?.() === 0;

const shell = async (script: string) => void (await run("sh", ["-c", script]));

const FALLBACKS: Record<string, () => Promise<Outcome>> = {
    async deno() {
        await shell("curl -fsSL https://deno.land/install.sh | sh -s -- -y");
        return "installed";
    },
    async rustup() {
        await shell("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none");
        return "installed";
    },
    async uv() {
        await shell("curl -LsSf https://astral.sh/uv/install.sh | sh");
        return "installed";
    },
    async zig() {
        const release = await zigRelease("x86_64-linux"),
            installed = await run("zig", ["version"]).catch(() => "");
        if (installed.trim() === release.version) {
            return "current";
        }

        const optDir = join(HOME, ".local", "opt", "zig"),
            archive = join(tmpdir(), "zig.tar.xz");
        await download(release.url, archive);
        rmSync(optDir, { force: true, recursive: true });
        mkdirSync(optDir, { recursive: true });
        mkdirSync(LOCAL_BIN, { recursive: true });
        await run("tar", ["-xf", archive, "-C", optDir, "--strip-components=1"]);
        rmSync(archive);
        rmSync(join(LOCAL_BIN, "zig"), { force: true });
        symlinkSync(join(optDir, "zig"), join(LOCAL_BIN, "zig"));
        return "installed";
    },
};

export function detectFamily(): Family {
    const release = readFileSync("/etc/os-release", "utf8"),
        ids = `${/^ID=(.*)$/m.exec(release)?.[1] ?? ""} ${/^ID_LIKE=(.*)$/m.exec(release)?.[1] ?? ""}`;

    if (/debian|ubuntu/.test(ids)) {
        return "debian";
    }
    if (ids.includes("arch")) {
        return "arch";
    }
    throw new Error(`Unsupported distribution: ${ids.trim()}`);
}

/** Runs a package manager command, through sudo unless already root. */
export const privileged = (file: string, args: string[], env?: Record<string, string>) =>
    isRoot
        ? run(file, args, { env })
        : run("sudo", [...(env ? ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)] : []), file, ...args]);

export const APT_ENV = { DEBIAN_FRONTEND: "noninteractive" };

/**
 * Installs what the distribution repositories have, then runs `fallbacks[pkg]` for the rest. The index is refreshed
 * (and, on Arch, the system fully upgraded) first so the availability probe isn't answered from stale or empty lists,
 * and the fallbacks run last because they need curl/flatpak/... from the install step.
 */
export async function installSystemPackages(
    family: Family,
    report: Report,
    packages: string[],
    fallbacks: Record<string, () => Promise<Outcome>>,
) {
    await report.step("package index", async () => {
        if (family === "debian") {
            await privileged("apt-get", ["update", "-qq"], APT_ENV);
        } else {
            await privileged("pacman", ["-Syu", "--noconfirm"]);
        }
    });

    const probe = family === "debian" ? ["apt-cache", "show"] : ["pacman", "-Si"],
        available: string[] = [],
        missing: string[] = [];

    for (const pkg of packages) {
        const found = await run(probe[0]!, [...probe.slice(1), pkg]).then(
            () => true,
            () => false,
        );
        (found ? available : missing).push(pkg);
    }

    await report.step("system packages", async () => {
        if (available.length === 0) {
            return;
        }
        if (family === "debian") {
            await privileged("apt-get", ["install", "-y", "-qq", ...available], APT_ENV);
        } else {
            await privileged("pacman", ["-S", "--needed", "--noconfirm", ...available]);
        }
    });

    for (const pkg of missing) {
        const fallback = fallbacks[pkg];
        if (fallback) {
            await report.step(pkg, fallback);
        } else {
            report.failed.push([pkg, "not available in the distribution repositories"]);
        }
    }
}

export async function installLinux(report: Report) {
    process.env.PATH = [CARGO_BIN, LOCAL_BIN, process.env.PATH].join(":");

    const family = detectFamily();
    await installSystemPackages(family, report, PACKAGES[family], FALLBACKS);

    await report.step("rust", () => installRustToolchains(["stable", "nightly"]));

    await report.step("cargo-binstall", async () => {
        if (!existsSync(join(CARGO_BIN, "cargo-binstall"))) {
            await shell(
                "curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash",
            );
        }
    });
    await cargoTools(report);

    await uvTools(report);

    await report.step("claude", async () => {
        if (!existsSync(join(LOCAL_BIN, "claude"))) {
            await shell("curl -fsSL https://claude.ai/install.sh | bash");
        }
    });
}
