// Installs/updates personal GUI tools. Same layout and conventions as dev/install-dev-tools (on Windows run that first: needs pwsh).
// Usage: deno run -A personal/install-personal-tools.ts
import console from "node:console";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
    APT_ENV,
    detectFamily,
    type Family,
    installSystemPackages,
    privileged,
} from "../dev/install-dev-tools/linux.ts";
import {
    compareVersions,
    download,
    getJson,
    getText,
    githubRelease,
    type Outcome,
    pool,
    redirectTarget,
    type Release,
    Report,
    run,
} from "../dev/install-dev-tools/util.ts";
import {
    ALREADY_INSTALLED,
    type Archive,
    BIN,
    type ElevatedStep,
    installArchive,
    pathDirs,
    persistPath,
    PWSH,
    readVersions,
    REBOOT_REQUIRED,
    regSet,
    ROOT,
    runElevated,
    setVersion,
    TMP,
} from "../dev/install-dev-tools/windows.ts";

const PROGRAM_FILES = process.env.ProgramFiles ?? "C:\\Program Files",
    PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] ??
        "C:\\Program Files (x86)";

const unversioned = async (url: string): Promise<Release> => ({
        url,
        version: "latest",
    }),
    redirected = async (url: string): Promise<Release> => {
        const target = await redirectTarget(url);
        return { url: target, version: target };
    };

async function kritaRelease(): Promise<Release> {
    const base = "https://download.kde.org/stable/krita/",
        version = [...(await getText(base)).matchAll(/href="(\d+(?:\.\d+)+)\/"/g)]
            .map((m) => m[1]!)
            .sort(compareVersions)
            .at(-1);

    if (!version) {
        throw new Error("krita: no release found");
    }
    return { url: `${base}${version}/krita-x64-${version}.zip`, version };
}

async function faststoneRelease(): Promise<Release> {
    const file = /DN\/(FSViewer\d+\.zip)/.exec(
        await getText("https://www.faststone.org/FSViewerDownload.htm"),
    )?.[1];

    if (!file) {
        throw new Error("faststone: portable zip link not found");
    }
    return { url: `https://www.faststonesoft.net/DN/${file}`, version: file };
}

async function sourceforgeRelease(project: string): Promise<Release> {
    const { release } = await getJson<{ release: { filename: string } }>(
            `https://sourceforge.net/projects/${project}/best_release.json`,
        ),
        version = release.filename.split("/")[1]!;

    return {
        url: `https://sourceforge.net/projects/${project}/files${release.filename}/download`,
        version,
    };
}

const ARCHIVES: Archive[] = [
    {
        bin: ".",
        name: "ungoogled-chromium",
        onPath: true,
        resolve: () =>
            githubRelease(
                "ungoogled-software/ungoogled-chromium-windows",
                /_windows_x64\.zip$/,
            ),
    },
    {
        name: "vscode",
        onPath: true, // bin\code.cmd locates Code.exe relative to itself
        resolve: () =>
            redirected(
                "https://update.code.visualstudio.com/latest/win32-x64-archive/stable",
            ),
    },
    {
        name: "flameshot",
        onPath: true,
        resolve: () => githubRelease("flameshot-org/flameshot", /^flameshot-[\d.]+-win64\.zip$/),
    },
    {
        bin: ".",
        name: "screentogif", // single self-contained exe, safe to symlink
        resolve: () =>
            githubRelease(
                "NickeManarin/ScreenToGif",
                /^ScreenToGif\.[\d.]+\.Portable\.x64\.zip$/,
            ),
    },
    { name: "krita", onPath: true, resolve: kritaRelease },
    {
        bin: "bin/64bit",
        name: "obs-studio",
        onPath: true,
        resolve: () =>
            githubRelease(
                "obsproject/obs-studio",
                /^OBS-Studio-[\d.]+-Windows-x64\.zip$/,
            ),
    },
    { bin: ".", name: "faststone", onPath: true, resolve: faststoneRelease },
    {
        bin: ".",
        name: "mpc-be",
        onPath: true,
        resolve: () => githubRelease("Aleksoid1978/MPC-BE", /^MPC-BE\.[\d.]+\.x64\.7z$/),
    },
    {
        bin: ".",
        links: { "DiskInfo64.exe": "DiskInfo64.exe" },
        name: "crystaldiskinfo",
        onPath: true,
        resolve: () => sourceforgeRelease("crystaldiskinfo"),
    },
    {
        bin: ".",
        name: "crystaldiskmark",
        onPath: true,
        resolve: () => sourceforgeRelease("crystaldiskmark"),
    },
    {
        bin: ".",
        name: "ayugram",
        onPath: true,
        resolve: () => githubRelease("AyuGram/AyuGramDesktop", /^AyuGram\.zip$/),
    },
    {
        bin: ".",
        // Single self-contained exe: "extraction" is just placing it in the tool dir.
        extract: async (file, dest) => void copyFileSync(file, join(dest, "koboldcpp.exe")),
        name: "koboldcpp",
        resolve: () => githubRelease("LostRuins/koboldcpp", /^koboldcpp\.exe$/),
    },
    {
        bin: ".",
        name: "imhex",
        onPath: true,
        resolve: () =>
            githubRelease(
                "WerWolv/ImHex",
                /^imhex-[\d.]+-Windows-Portable-x86_64\.zip$/,
            ),
    },
];

interface Installer {
    name: string;
    args: string[];
    resolve: () => Promise<Release>;
    /** Install dirs to put on PATH once present. */
    dirs?: string[];
    msi?: boolean;
    elevate?: false;
}

async function tenacityRelease(): Promise<Release> {
    const release = await getJson<
            {
                assets: { browser_download_url: string; name: string }[];
                tag_name: string;
            }
        >(
            "https://codeberg.org/api/v1/repos/tenacityteam/tenacity/releases/latest",
        ),
        asset = release.assets.find((a) => /^tenacity-win-[\d.]+-x86_64\.exe$/.test(a.name));

    if (!asset) {
        throw new Error("tenacity: no x86_64 installer in the latest release");
    }
    return { url: asset.browser_download_url, version: release.tag_name };
}

// FileZilla Server's download link is signed and expires after ~1h, and the site blocks scripted access to the page that
// issues it. So it's opt-in: paste a fresh link from a browser into FILEZILLA_SERVER_URL for the run that should install/update it.
const FILEZILLA_URL = process.env.FILEZILLA_SERVER_URL,
    FILEZILLA: Installer[] = FILEZILLA_URL
        ? [
            {
                args: ["/S"],
                dirs: [join(PROGRAM_FILES, "FileZilla Server")],
                name: "filezilla-server",
                resolve: async () => {
                    const version = /FileZilla_Server_([\d.]+)_win64/.exec(FILEZILLA_URL)
                        ?.[1];
                    if (!version) {
                        throw new Error(
                            "FILEZILLA_SERVER_URL doesn't look like a FileZilla_Server_<version>_win64 link",
                        );
                    }
                    return { url: FILEZILLA_URL, version };
                },
            },
        ]
        : [];

const INSTALLERS: Installer[] = [
    ...FILEZILLA,
    {
        args: ["/S"],
        dirs: [join(PROGRAM_FILES, "qBittorrent")],
        name: "qbittorrent",
        resolve: () =>
            githubRelease(
                "qbittorrent/qBittorrent",
                /^qbittorrent_[\d.]+_x64_setup\.exe$/,
            ),
    },
    {
        args: ["/S"],
        dirs: [join(PROGRAM_FILES_X86, "Steam")],
        name: "steam", // self-updating
        resolve: () =>
            unversioned(
                "https://cdn.cloudflare.steamstatic.com/client/installer/SteamSetup.exe",
            ),
    },
    {
        args: [],
        dirs: [join(PROGRAM_FILES, "Cloudflare", "Cloudflare WARP")],
        msi: true,
        name: "cloudflare-warp",
        resolve: () =>
            redirected(
                "https://downloads.cloudflareclient.com/v1/download/windows/ga",
            ),
    },
    {
        args: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], // Inno Setup
        dirs: [join(PROGRAM_FILES, "Tenacity")],
        name: "tenacity",
        resolve: tenacityRelease,
    },
    {
        args: [],
        elevate: false, // per-user install into %LOCALAPPDATA%; self-updating
        name: "discord",
        resolve: () =>
            unversioned(
                "https://discord.com/api/downloads/distributions/app/installers/latest?channel=stable&platform=win&arch=x64",
            ),
    },
];

async function installPrograms(report: Report) {
    const versions = readVersions(),
        fetched = await pool(INSTALLERS, 4, async (spec) => {
            console.log(`[start] ${spec.name} (download)`);
            const release = await spec.resolve();
            if (versions[spec.name] === release.version) {
                console.log(`[up to date] ${spec.name}`);
                return undefined;
            }
            const file = join(TMP, `${spec.name}${spec.msi ? ".msi" : ".exe"}`);
            await download(release.url, file);
            console.log(`[downloaded] ${spec.name}`);
            return { file, release, spec };
        }),
        pending = [];

    for (const [index, result] of fetched.entries()) {
        const name = INSTALLERS[index]!.name;
        if (result.status === "rejected") {
            const reason = result.reason as unknown;
            const message = reason instanceof Error ? reason.message : String(reason);
            report.failed.push([name, message]);
            console.error(`[error] ${name}: ${message}`);
        } else if (result.value) {
            pending.push(result.value);
        } else {
            report.current.push(name);
        }
    }

    const elevated = pending.filter(({ spec }) => spec.elevate !== false),
        steps = elevated.map(({ file, spec }): ElevatedStep =>
            spec.msi
                ? [spec.name, "msiexec.exe", ["/i", file, "/qn", "/norestart"], 1]
                : [spec.name, file, spec.args, 1]
        );
    let codes = new Map<string, string>(),
        elevationError: unknown;

    if (steps.length > 0) {
        console.log(
            `[start] elevated install: ${steps.map(([name]) => name).join(", ")}`,
        );
        try {
            codes = await runElevated(steps);
        } catch (error) {
            elevationError = error;
        }
    }

    for (const { file, release, spec } of pending) {
        await report.step(spec.name, async () => {
            if (spec.elevate === false) {
                await run(file, spec.args);
            } else if (elevationError) {
                throw elevationError;
            } else if (
                ![0, ALREADY_INSTALLED, REBOOT_REQUIRED].includes(
                    Number(codes.get(spec.name)),
                )
            ) {
                throw new Error(
                    `exit code ${codes.get(spec.name) ?? "unknown (elevation declined?)"}`,
                );
            }
            setVersion(spec.name, release.version);
        });
    }
}

async function registerVscodeMenu() {
    const exe = join(ROOT, "vscode", "Code.exe");

    if (!existsSync(exe)) {
        throw new Error("Code.exe missing");
    }

    await Promise.all(
        (
            [
                ["*", "%1"],
                ["Directory", "%V"],
                ["Directory\\Background", "%V"],
                ["Drive", "%V"],
            ] as const
        ).flatMap(([key, arg]) => [
            regSet(`${key}\\shell\\VSCode`, "Open with Code"),
            regSet(`${key}\\shell\\VSCode`, exe, "Icon"),
            regSet(`${key}\\shell\\VSCode\\command`, `"${exe}" "${arg}"`),
        ]),
    );
}

async function installPersonalWindows(report: Report) {
    if (!existsSync(PWSH)) {
        report.failed.push([
            "pwsh",
            `${PWSH} not found: run dev/install-dev-tools first`,
        ]);
        return;
    }

    mkdirSync(BIN, { recursive: true });
    mkdirSync(TMP, { recursive: true });

    await Promise.all([
        pool(
            ARCHIVES,
            4,
            (archive) => report.step(archive.name, () => installArchive(archive)),
        ),
        installPrograms(report),
    ]);

    for (const dir of INSTALLERS.flatMap((spec) => spec.dirs ?? [])) {
        if (existsSync(dir)) {
            pathDirs.add(dir);
        }
    }

    await report.step("vscode context menu", registerVscodeMenu);
    await report.step("user PATH", async () => {
        await persistPath([BIN, ...pathDirs]);
    });

    rmSync(TMP, { force: true, recursive: true });
}

const LINUX_PACKAGES: Record<Family, string[]> = {
    arch: [
        "flameshot",
        "krita",
        "obs-studio",
        "qbittorrent",
        "smplayer",
        "steam", // multilib
        "discord",
        "imhex",
        "tenacity",
        "code", // Code - OSS: Microsoft's build is AUR-only
        "ungoogled-chromium",
    ],
    debian: [
        "flameshot",
        "krita",
        "obs-studio",
        "qbittorrent",
        "smplayer",
        "steam-installer", // non-free / multiverse
        "discord",
        "imhex",
        "tenacity",
        "code",
        "ungoogled-chromium",
        "cloudflare-warp",
    ],
};

const LINUX_FALLBACKS: Record<string, () => Promise<Outcome>> = {
    // Both vendor packages add their own apt repository, so later runs find them through apt and keep them updated.
    async "cloudflare-warp"() {
        const keyring = "/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg";
        await privileged("sh", [
            "-c",
            `curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor -o ${keyring} && echo "deb [signed-by=${keyring}] https://pkg.cloudflareclient.com/ $(. /etc/os-release && echo $VERSION_CODENAME) main" > /etc/apt/sources.list.d/cloudflare-client.list`,
        ]);
        await privileged("apt-get", ["update", "-qq"], APT_ENV);
        await privileged(
            "apt-get",
            ["install", "-y", "-qq", "cloudflare-warp"],
            APT_ENV,
        );
        return "installed";
    },
    async code() {
        const file = join(tmpdir(), "code.deb");
        await download(
            "https://update.code.visualstudio.com/latest/linux-deb-x64/stable",
            file,
        );
        await privileged("apt-get", ["install", "-y", "-qq", file], APT_ENV);
        rmSync(file);
        return "installed";
    },
};

async function installPersonalLinux(report: Report) {
    const family = detectFamily();
    await installSystemPackages(
        family,
        report,
        LINUX_PACKAGES[family],
        LINUX_FALLBACKS,
    );
}

const report = new Report();

await (process.platform === "win32" ? installPersonalWindows(report) : installPersonalLinux(report));

report.print();
