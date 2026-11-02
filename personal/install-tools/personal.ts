// Personal GUI tools for Windows: portable archives plus silent installers. Plugged into installWindows (windows.ts).
import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { log, plan, result, track } from "./ui.ts";
import {
    compareVersions,
    download,
    getJson,
    getText,
    githubRelease,
    pool,
    redirectTarget,
    type Release,
    type Report,
    run,
} from "./util.ts";
import {
    ALREADY_INSTALLED,
    type Archive,
    type ElevatedStep,
    type Personal,
    POWERSHELL,
    readVersions,
    REBOOT_REQUIRED,
    regSet,
    ROOT,
    runElevated,
    setVersion,
    TMP,
} from "./windows.ts";

const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

// Every program but Steam installs into ROOT\<name> (NSIS: /D=, Inno Setup: /DIR=, MSI: INSTALLFOLDER=).
const installDir = (name: string) => join(ROOT, name);

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
    const file = /DN\/(FSViewer\d+\.zip)/.exec(await getText("https://www.faststone.org/FSViewerDownload.htm"))?.[1];

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

// Installed first (before git and gh), see installWindows.
const CHROMIUM: Archive = {
    bin: ".",
    name: "ungoogled-chromium",
    shim: true,
    resolve: () => githubRelease("ungoogled-software/ungoogled-chromium-windows", /_windows_x64\.zip$/),
};

const ARCHIVES: Archive[] = [
    {
        name: "vscode",
        resolve: () => redirected("https://update.code.visualstudio.com/latest/win32-x64-archive/stable"),
    },
    {
        name: "flameshot",
        shim: true,
        resolve: () => githubRelease("flameshot-org/flameshot", /^flameshot-[\d.]+-win64\.zip$/),
    },
    {
        bin: ".",
        name: "screentogif",
        resolve: () => githubRelease("NickeManarin/ScreenToGif", /^ScreenToGif\.[\d.]+\.Portable\.x64\.zip$/),
    },
    { name: "krita", shim: true, resolve: kritaRelease },
    {
        bin: "bin/64bit",
        name: "obs-studio",
        shim: true,
        resolve: () => githubRelease("obsproject/obs-studio", /^OBS-Studio-[\d.]+-Windows-x64\.zip$/),
    },
    { bin: ".", name: "faststone", shim: true, resolve: faststoneRelease },
    {
        bin: ".",
        name: "mpc-be",
        shim: true,
        resolve: () => githubRelease("Aleksoid1978/MPC-BE", /^MPC-BE\.[\d.]+\.x64\.7z$/),
    },
    {
        bin: ".",
        name: "crystaldiskinfo",
        resolve: () => sourceforgeRelease("crystaldiskinfo"),
    },
    {
        bin: ".",
        name: "crystaldiskmark",
        resolve: () => sourceforgeRelease("crystaldiskmark"),
    },
    {
        bin: ".",
        name: "ayugram",
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
        shim: true,
        resolve: () => githubRelease("WerWolv/ImHex", /^imhex-[\d.]+-Windows-Portable-x86_64\.zip$/),
    },
];

interface Installer {
    name: string;
    args: string[];
    resolve: () => Promise<Release>;
    /** Install dir, put on PATH once present. Absent for installers that can't be relocated. */
    dir?: string;
    msi?: boolean;
    elevate?: false;
}

async function tenacityRelease(): Promise<Release> {
    const release = await getJson<{
            assets: { browser_download_url: string; name: string }[];
            tag_name: string;
        }>("https://codeberg.org/api/v1/repos/tenacityteam/tenacity/releases/latest"),
        asset = release.assets.find((a) => /^tenacity-win-[\d.]+-x86_64\.exe$/.test(a.name));

    if (!asset) {
        throw new Error("tenacity: no x86_64 installer in the latest release");
    }
    return { url: asset.browser_download_url, version: release.tag_name };
}

const INSTALLERS: Installer[] = [
    {
        args: ["/S", `/D=${installDir("qbittorrent")}`],
        dir: installDir("qbittorrent"),
        name: "qbittorrent",
        resolve: () => githubRelease("qbittorrent/qBittorrent", /^qbittorrent_[\d.]+_x64_setup\.exe$/),
    },
    {
        args: ["/S"],
        dir: join(PROGRAM_FILES_X86, "Steam"), // default location: it holds the games. Self-updating
        name: "steam",
        resolve: () => unversioned("https://cdn.cloudflare.steamstatic.com/client/installer/SteamSetup.exe"),
    },
    {
        args: [`INSTALLFOLDER=${installDir("cloudflare-warp")}`], // its MSI's install directory property
        dir: installDir("cloudflare-warp"),
        msi: true,
        name: "cloudflare-warp",
        resolve: () => redirected("https://downloads.cloudflareclient.com/v1/download/windows/ga"),
    },
    {
        args: ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", `/DIR=${installDir("tenacity")}`], // Inno Setup
        dir: installDir("tenacity"),
        name: "tenacity",
        resolve: tenacityRelease,
    },
    {
        args: [],
        elevate: false, // per-user install into %LOCALAPPDATA% (Squirrel has no directory option, so it can't move); self-updating
        name: "discord",
        resolve: () =>
            unversioned(
                "https://discord.com/api/downloads/distributions/app/installers/latest?channel=stable&platform=win&arch=x64",
            ),
    },
];

async function installPrograms(report: Report) {
    const versions = readVersions(),
        fetched = await pool(INSTALLERS, 4, (spec) =>
            track(spec.name, async () => {
                plan(["resolve", "download"]);
                const release = await spec.resolve();
                if (versions[spec.name] === release.version) {
                    result("current", spec.name);
                    return undefined;
                }
                const file = join(TMP, `${spec.name}${spec.msi ? ".msi" : ".exe"}`);
                await download(release.url, file);
                log(`↓ ${spec.name} downloaded`);
                return { file, release, spec };
            }),
        ),
        pending = [];

    for (const [index, outcome] of fetched.entries()) {
        const name = INSTALLERS[index]!.name;
        if (outcome.status === "rejected") {
            const reason = outcome.reason as unknown;
            const message = reason instanceof Error ? reason.message : String(reason);
            report.failed.push([name, message]);
            result("failed", name, message);
        } else if (outcome.value) {
            pending.push(outcome.value);
        } else {
            report.current.push(name);
        }
    }

    const elevated = pending.filter(({ spec }) => spec.elevate !== false),
        steps = elevated.map(({ file, spec }): ElevatedStep =>
            spec.msi
                ? [spec.name, "msiexec.exe", ["/i", file, "/qn", "/norestart", ...spec.args], 1]
                : [spec.name, file, spec.args, 1],
        );
    let codes = new Map<string, string>(),
        elevationError: unknown;

    if (steps.length > 0) {
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
            } else if (![0, ALREADY_INSTALLED, REBOOT_REQUIRED].includes(Number(codes.get(spec.name)))) {
                throw new Error(`exit code ${codes.get(spec.name) ?? "unknown (elevation declined?)"}`);
            }
            setVersion(spec.name, release.version);
        });
    }
}

// The portable archive has no installer, so nothing else adds a Start menu entry for it.
async function registerVscode() {
    const exe = join(ROOT, "vscode", "Code.exe"),
        appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
        shortcut = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Visual Studio Code.lnk");

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

    // Paths go through the environment so PowerShell gets them verbatim, with no quoting.
    await run(
        POWERSHELL,
        [
            "-NoProfile",
            "-Command",
            "$link = (New-Object -ComObject WScript.Shell).CreateShortcut($env:SHORTCUT); $link.TargetPath = $env:TARGET; $link.Save()",
        ],
        { env: { SHORTCUT: shortcut, TARGET: exe } },
    );
}

export const PERSONAL_WINDOWS: Personal = {
    archives: ARCHIVES,
    chromium: CHROMIUM,
    installPrograms,
    programDirs: INSTALLERS.flatMap((spec) => spec.dir ?? []),
    registerVscode,
};
