import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
    cargoTools,
    configureGit,
    download,
    enableGh,
    getJson,
    githubRelease,
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
        "unzip",
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
        "lua",
        "npm",
        "fltk",
        "glfw",
        "glaze",
        "libgit2",
        "libarchive",
        "nuspell",
        "quickjs",
        "mimalloc",
        "libpulse",
        "alsa-lib",
        "yyjson",
        "qt6-base",
        "qt6-svg",
        "qt6-tools",
        "qt6-wayland",
        "mesa",
        "glu",
        "freeglut",
        "libglvnd",
        "libx11",
        "libxcursor",
        "libxfixes",
        "libxft",
        "libxinerama",
        "libxkbcommon",
        "libxkbcommon-x11",
        "libxcb",
        "libxext",
        "libxi",
        "libxrandr",
        "libxrender",
        "libxss",
        "libxtst",
        "libxxf86vm",
        "xorg-server-xvfb",
        "weston",
    ],
    debian: [
        "build-essential",
        "curl",
        "unzip",
        "ca-certificates",
        "git",
        "gh",
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
        "ruby-full",
        "default-jdk",
        "7zip",
        "zig",
        "uv",
        "rustup",
        "lua5.4",
        "libjxl-dev",
        "libjxl-tools",
        "libwebp-dev",
        "webp",
        "libheif-dev",
        "libheif-examples",
        "libfltk1.4-dev",
        "libglfw3-dev",
        "libglaze-dev",
        "libgtest-dev",
        "libgmock-dev",
        "libgit2-dev",
        "libarchive-dev",
        "libmagickcore-dev",
        "libmagickwand-dev",
        "libmagick++-dev",
        "libnuspell-dev",
        "libqjs-dev",
        "libmimalloc-dev",
        "libpulse-dev",
        "libasound2-dev",
        "libyyjson-dev",
        "qt6-base-dev",
        "qt6-base-dev-tools",
        "qt6-l10n-tools",
        "qt6-svg-dev",
        "qt6-tools-dev",
        "qt6-tools-dev-tools",
        "qt6-wayland-dev",
        "libavcodec-dev",
        "libavfilter-dev",
        "libavutil-dev",
        "libswresample-dev",
        "libswscale-dev",
        "libssl-dev",
        "libffi-dev",
        "libncurses-dev",
        "libreadline-dev",
        "zlib1g-dev",
        "liblzma-dev",
        "libyaml-dev",
        "libunwind-dev",
        "libgdbm-dev",
        "libkrb5-dev",
        "libtool",
        "autoconf",
        "automake",
        "freeglut3-dev",
        "libgl1-mesa-dev",
        "libglu1-mesa-dev",
        "mesa-common-dev",
        "libegl-dev",
        "libx11-dev",
        "libxcursor-dev",
        "libxfixes-dev",
        "libxft-dev",
        "libxinerama-dev",
        "libxkbcommon-dev",
        "libxkbcommon-x11-dev",
        "libxcb-xkb-dev",
        "libxext-dev",
        "libxi-dev",
        "libxrandr-dev",
        "libxrender-dev",
        "libxss-dev",
        "libxtst-dev",
        "libxxf86vm-dev",
        "xvfb",
        "weston",
        "clang-23",
        "clangd-23",
        "lld-23",
        "lldb-23",
        "libomp-23-dev",
        "llvm-23",
        "clang-tools-23",
        "clang-tidy-23",
        "clang-format-23",
    ],
};

// Installed first, in this order (the package manager takes them in argument order).
const PRIORITY_PACKAGES: Record<Family, string[]> = {
    arch: ["ungoogled-chromium", "git", "github-cli"],
    debian: ["git", "gh"],
};

const PERSONAL_PACKAGES: Record<Family, string[]> = {
    arch: [
        "flameshot",
        "krita",
        "obs-studio",
        "qbittorrent",
        "smplayer",
        "steam",
        "discord",
        "imhex",
        "tenacity",
        "alacritty",
        "inkscape",
        "libreoffice-fresh",
        "feh",
        "fish",
        "btop",
        "fastfetch",
        "nano",
        "wget",
    ],
    debian: [
        "chromium", // Debian has no ungoogled-chromium
        "flameshot",
        "krita",
        "qbittorrent",
        "smplayer",
        "imhex",
        "code",
        "alacritty",
        "inkscape",
        "libreoffice",
        "feh",
        "fish",
        "btop",
        "fastfetch",
        "nano",
        "wget",
    ],
};

const HOME = homedir(),
    LOCAL_BIN = join(HOME, ".local", "bin"),
    CARGO_BIN = join(HOME, ".cargo", "bin"),
    ZIG_DIR = join(HOME, ".local", "opt", "zig"),
    NERD_FONT_DIR = join(HOME, ".local", "share", "fonts", "InconsolataNerdFont"),
    FNM_DIR = join(HOME, ".local", "share", "fnm"),
    isRoot = process.getuid?.() === 0;

const shell = async (script: string) => void (await run("sh", ["-c", script]));

const FALLBACKS: Record<string, () => Promise<Outcome>> = {
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

        const archive = join(tmpdir(), "zig.tar.xz");
        await download(release.url, archive);
        rmSync(ZIG_DIR, { force: true, recursive: true });
        mkdirSync(ZIG_DIR, { recursive: true });
        await run("tar", ["-xf", archive, "-C", ZIG_DIR, "--strip-components=1"]);
        rmSync(archive);
        return "installed";
    },
    // Both vendor packages add their own apt repository, so later runs find them through apt and keep them updated.
    async "cloudflare-warp"() {
        const keyring = "/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg";
        await privileged("sh", [
            "-c",
            `curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor -o ${keyring} && echo "deb [signed-by=${keyring}] https://pkg.cloudflareclient.com/ $(. /etc/os-release && echo $VERSION_CODENAME) main" > /etc/apt/sources.list.d/cloudflare-client.list`,
        ]);
        await privileged("apt-get", ["update", "-qq"], APT_ENV);
        await privileged("apt-get", ["install", "-y", "-qq", "cloudflare-warp"], APT_ENV);
        return "installed";
    },
    async code() {
        const file = join(tmpdir(), "code.deb");
        await download("https://update.code.visualstudio.com/latest/linux-deb-x64/stable", file);
        await privileged("apt-get", ["install", "-y", "-qq", file], APT_ENV);
        rmSync(file);
        return "installed";
    },
};

/** WSL's kernel reports "microsoft" in /proc/version. */
const isWsl = () => /microsoft/i.test(readFileSync("/proc/version", "utf8"));

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
const privileged = (file: string, args: string[], env?: Record<string, string>) =>
    isRoot
        ? run(file, args, { env })
        : run("sudo", [...(env ? ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)] : []), file, ...args]);

const APT_ENV = { DEBIAN_FRONTEND: "noninteractive" };

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

/** Adds apt.llvm.org's trixie suite for LLVM 22, which Debian's own repo lacks. Debian 13 only; skipped if any source already points there. */
async function llvmRepo(): Promise<Outcome> {
    const sources = "/etc/apt/sources.list.d",
        keyring = "/usr/share/keyrings/llvm-archive-keyring.gpg";
    if (readdirSync(sources).some((file) => readFileSync(join(sources, file), "utf8").includes("apt.llvm.org"))) {
        return "current";
    }

    // gpg isn't in a minimal Debian install, and the key import below needs it.
    await privileged("apt-get", ["update", "-qq"], APT_ENV);
    await privileged("apt-get", ["install", "-y", "-qq", "gnupg"], APT_ENV);
    await privileged("sh", [
        "-c",
        `curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --yes --dearmor -o ${keyring} && printf 'Types: deb\\nURIs: https://apt.llvm.org/trixie/\\nSuites: llvm-toolchain-trixie-23\\nComponents: main\\nSigned-By: ${keyring}\\n' > ${sources}/llvm.sources`,
    ]);
    return "installed";
}

/**
 * Unversioned names for the LLVM 23 tools (clang, lld, clang-tidy, ...), and cc/c++ as clang. Priority 230 wins over any
 * other registered version. Versioned names are skipped: the packages already provide those.
 */
async function llvmAlternatives(): Promise<void> {
    const bin = "/usr/lib/llvm-23/bin",
        tools = readdirSync(bin).filter(
            (name) => !name.includes("-23") && (statSync(join(bin, name)).mode & 0o111) !== 0,
        );

    const commands = [
        ...tools.map((name) => `update-alternatives --install /usr/bin/${name} ${name} ${bin}/${name} 230`),
        "update-alternatives --install /usr/bin/cc cc /usr/bin/clang 230",
        "update-alternatives --install /usr/bin/c++ c++ /usr/bin/clang++ 230",
        "update-alternatives --set cc /usr/bin/clang",
        "update-alternatives --set c++ /usr/bin/clang++",
    ];
    await privileged("sh", ["-c", commands.join(" && ")]);
}

const NPM_PACKAGES = ["@caveman-ai/cli", "@colbymchenry/codegraph", "corepack"];

/** pnpm through Corepack (installed by NPM_PACKAGES): `enable` writes the pnpm shim into LOCAL_BIN, `install -g` caches the latest pnpm as the default. */
async function installPnpm(): Promise<void> {
    mkdirSync(LOCAL_BIN, { recursive: true });
    await run("corepack", ["enable", "--install-directory", LOCAL_BIN, "pnpm"]);
    await run("corepack", ["install", "-g", "pnpm@latest"]);
}

/**
 * Node.js through fnm, so global npm installs stay user-owned. The install script puts fnm in LOCAL_BIN and skips the
 * shell rc edit (PATH comes from `linkNodeBin`, and fnm can't configure fish, the user's shell). `fnm default` points
 * aliases/default at the latest stable (no pre-release tag, not LTS), which `linkNodeBin` reads.
 */
async function installNode(): Promise<void> {
    await shell(`curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "${LOCAL_BIN}" --skip-shell`);
    const releases = await getJson<{ version: string }[]>("https://nodejs.org/dist/index.json"),
        { version } = releases.find((release) => !release.version.includes("-"))!;
    if (!existsSync(join(FNM_DIR, "node-versions", version))) {
        await run("fnm", ["install", version], { env: { FNM_DIR } });
    }
    await run("fnm", ["default", version], { env: { FNM_DIR } });
}

/** Symlinks the default Node.js bin dir (node, npm, npx and global CLIs) into LOCAL_BIN, which is on PATH. Rerun after global installs. */
async function linkNodeBin(): Promise<void> {
    const bin = join(FNM_DIR, "aliases", "default", "bin");

    mkdirSync(LOCAL_BIN, { recursive: true });
    for (const name of readdirSync(bin)) {
        rmSync(join(LOCAL_BIN, name), { force: true });
        symlinkSync(join(bin, name), join(LOCAL_BIN, name));
    }
}

/** Global npm CLIs, pinned to `@latest` so reruns upgrade them. Arch's system npm has a root-owned prefix; Debian's fnm npm doesn't need root. */
async function npmTools(report: Report, family: Family): Promise<void> {
    const install = family === "debian" ? run : privileged;
    for (const pkg of NPM_PACKAGES) {
        await report.step(`npm:${pkg}`, async () => {
            await install("npm", ["install", "-g", `${pkg}@latest`]);
        });
    }
}

/** Bootstraps paru from its AUR snapshot. makepkg refuses root, so this runs as the user; paru calls sudo for pacman itself. */
async function installParu(): Promise<Outcome> {
    if (existsSync("/usr/bin/paru")) {
        return "current";
    }

    const dir = join(tmpdir(), "paru-bin");
    rmSync(dir, { force: true, recursive: true });
    await run("git", ["clone", "--depth", "1", "https://aur.archlinux.org/paru-bin.git", dir]);
    await run("sh", ["-c", `cd "${dir}" && makepkg -si --noconfirm`]);
    rmSync(dir, { force: true, recursive: true });
    return "installed";
}

/**
 * Per-user install into ~/.local/share/fonts. Reinstalled on every run (no version stamp on Linux, and the archive is small),
 * so the directory always mirrors the latest release, then fc-cache rebuilds the index so the fonts work without a re-login.
 */
async function installNerdFont(): Promise<Outcome> {
    const release = await githubRelease("ryanoasis/nerd-fonts", /^Inconsolata\.tar\.xz$/),
        archive = join(tmpdir(), "Inconsolata.tar.xz");

    await download(release.url, archive);
    rmSync(NERD_FONT_DIR, { force: true, recursive: true });
    mkdirSync(NERD_FONT_DIR, { recursive: true });
    await run("tar", ["-xf", archive, "-C", NERD_FONT_DIR]);
    rmSync(archive);
    await run("fc-cache", ["-f", NERD_FONT_DIR]);
    return "installed";
}

export async function installLinux(report: Report) {
    process.env.PATH = [CARGO_BIN, LOCAL_BIN, ZIG_DIR, process.env.PATH].join(":");

    const family = detectFamily(),
        // Personal tools (GUI apps, browser, VS Code, terminal font) stay off WSL, where the GUI apps run on Windows.
        personal = !isWsl();
    if (family === "debian") {
        await report.step("llvm apt repo", llvmRepo);
    }
    await installSystemPackages(
        family,
        report,
        [
            ...new Set([
                ...PRIORITY_PACKAGES[family],
                ...PACKAGES[family],
                ...(personal ? PERSONAL_PACKAGES[family] : []),
            ]),
        ],
        FALLBACKS,
    );
    await enableGh();
    if (family === "debian") {
        await report.step("llvm alternatives", llvmAlternatives);
    }
    await report.step("git config", () => configureGit("git"));
    if (personal) {
        await report.step("inconsolata nerd font", installNerdFont);
    }

    if (family === "arch") {
        await report.step("paru", installParu);
        // --skipreview: paru's PKGBUILD review prompt can't be answered here (stdin is a pipe).
        await report.step("visual-studio-code-bin", () =>
            run("paru", ["-S", "--needed", "--noconfirm", "--skipreview", "visual-studio-code-bin"]).then(() => {}),
        );
    }

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

    if (family === "debian") {
        await report.step("node", async () => {
            await installNode();
            await linkNodeBin();
        });
    }
    await npmTools(report, family);
    if (family === "debian") {
        // npm globals land in the fnm bin dir, so they need linking too.
        await report.step("node bin", linkNodeBin);
    }

    await report.step("pnpm", installPnpm);

    await report.step("claude", async () => {
        if (!existsSync(join(LOCAL_BIN, "claude"))) {
            await shell("curl -fsSL https://claude.ai/install.sh | bash");
        }
    });
}
