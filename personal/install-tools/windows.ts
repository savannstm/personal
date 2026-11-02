import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import process from "node:process";

import type { Report } from "./util.ts";

import {
    type Bin,
    BIN,
    binDir,
    CLANG64_BIN,
    cppTool,
    findDir,
    MSYS2,
    MSYS2_BASE_PACKAGES,
    MSYS2_MINGW_PACKAGES,
    NODE_DIR,
    POWERSHELL,
    ROOT,
    type Toolchain,
} from "./toolchain.ts";

import {
    cargoTools,
    configureGit,
    compareVersions,
    download,
    enableGh,
    getJson,
    getText,
    githubRelease,
    githubReleaseMatching,
    installRustToolchains,
    type Outcome,
    pool,
    redirectTarget,
    type Release,
    run,
    uvTools,
    zigRelease,
} from "./util.ts";
import { inTask, log, plan, progress, stage, track } from "./ui.ts";

const TMP = join(ROOT, ".tmp"),
    VERSIONS = join(ROOT, ".versions.json"),
    CARGO_BIN = join(homedir(), ".cargo", "bin"),
    TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
    PWSH = join(ROOT, "pwsh", "pwsh.exe"),
    MACHINE_ENV_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    MACHINE_ENV: [string, string][] = [["CARGO_BUILD_BUILD_DIR", join(homedir(), "cargo-build").replaceAll("\\", "/")]];

export { MACHINE_ENV, MACHINE_ENV_KEY, POWERSHELL, ROOT, TMP };

const VS_COMPONENTS = [
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "Microsoft.VisualStudio.Component.Windows11SDK.28000",
        "Microsoft.VisualStudio.Component.VC.ATL",
        "Microsoft.VisualStudio.Component.VC.ATLMFC",
        "Microsoft.VisualStudio.Component.VC.ASAN",
    ],
    NETFX3_FEATURES = ["NetFx3"],
    NETFX4_FEATURES = ["NetFx4-AdvSrvs", "NetFx4Extended-ASPNET45"],
    RUNTIME_INSTALLERS: [string, string, string[]][] = [
        [
            "vcredist-aio",
            "https://github.com/abbodi1406/vcredist/releases/latest/download/VisualCppRedist_AIO_x86_x64.exe",
            ["/ai"],
        ],
        [
            "directx",
            "https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe",
            ["/silent"],
        ],
        ...["8.0", "9.0", "10.0"].flatMap((version) =>
            ["dotnet-runtime", "aspnetcore-runtime", "windowsdesktop-runtime"].map(
                (kind): [string, string, string[]] => [
                    `${kind}-${version}`,
                    `https://aka.ms/dotnet/${version}/${kind}-win-x64.exe`,
                    ["/install", "/quiet", "/norestart"],
                ],
            ),
        ),
    ];

export interface Archive {
    name: string;
    /** Directory with the exes, relative to the tool root (default "bin"), or computed from it. */
    bin?: Bin;
    /** Keep the bin dir off PATH: for a build whose exes clash with another archive's, and for the C/C++ tools set-env.ts adds. */
    noPath?: boolean;
    /** Keep the bin dir off PATH and expose each of its exes as a `.cmd` shim in BIN, for apps that ship their own DLLs. */
    shim?: boolean;
    /** Also packaged in CLANG64, so a clang-only run skips this archive. */
    clang64?: boolean;
    resolve: () => Promise<Release>;
    extract?: (file: string, dest: string) => Promise<void>;
    /** Post-install hook, run on every invocation (fresh install or already current), so it must be idempotent. */
    after?: (root: string) => Promise<void>;
}

// The elevated process and the main one both touch this file, so a read can land on a half-written (or externally
// mangled) copy: treat unparsable content as empty (versions are only skip-hints) instead of crashing.
export const readVersions = (): Record<string, string> => {
    if (!existsSync(VERSIONS)) {
        return {};
    }
    try {
        return JSON.parse(readFileSync(VERSIONS, "utf8").replace(/^﻿/, "").replace(/\0+$/, "")) as Record<
            string,
            string
        >;
    } catch {
        return {};
    }
};

export function setVersion(name: string, version: string) {
    // Write to a temp file and rename so readers never see a truncated file.
    const temp = `${VERSIONS}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...readVersions(), [name]: version }, null, 2));
    renameSync(temp, VERSIONS);
}

const archiveBin = ({ bin, name }: Archive) => binDir(name, bin);
const onPath = (spec: Archive) => !spec.noPath && !spec.shim;

function exposeArchive(spec: Archive) {
    const dir = archiveBin(spec);
    if (!dir) {
        return;
    }
    if (spec.shim) {
        for (const file of readdirSync(dir, { withFileTypes: true })) {
            if (file.isFile() && /\.exe$/i.test(file.name)) {
                writeFileSync(
                    join(BIN, `${basename(file.name, extname(file.name))}.cmd`),
                    `@"${join(dir, file.name)}" %*\r\n`,
                );
            }
        }
    } else if (onPath(spec)) {
        process.env.PATH = [dir, process.env.PATH].join(";");
    }
}

const extractTar = async (file: string, dest: string) => void (await run(TAR, ["-xf", file, "-C", dest]));
const extractSfx = async (file: string, dest: string) => void (await run(file, ["-y", `-o${dest}`]));
const extractMsi = async (file: string, dest: string) =>
    void (await run("msiexec.exe", ["/a", file, "/qn", `TARGETDIR=${dest}`]));

export async function installArchive(spec: Archive): Promise<Outcome> {
    plan(["resolve", "download", "extract", "install"]);
    const release = await spec.resolve(),
        root = join(ROOT, spec.name);

    if (readVersions()[spec.name] === release.version && existsSync(root)) {
        exposeArchive(spec);
        await spec.after?.(root);
        return "current";
    }

    const work = join(TMP, spec.name),
        out = join(work, "x");
    rmSync(work, { force: true, recursive: true });
    mkdirSync(out, { recursive: true });

    const file = join(work, `download${extname(new URL(release.url).pathname)}`);
    await download(release.url, file);
    stage("extract");
    await (spec.extract ?? extractTar)(file, out);
    stage("install");

    // Archives wrapped in a single top-level directory get that directory stripped.
    const entries = readdirSync(out, { withFileTypes: true }),
        source = entries.length === 1 && entries[0]!.isDirectory() ? join(out, entries[0]!.name) : out;

    rmSync(root, { force: true, recursive: true });
    renameSync(source, root);
    rmSync(work, { force: true, recursive: true });

    setVersion(spec.name, release.version);
    exposeArchive(spec);
    await spec.after?.(root);
    return "installed";
}

async function nasmRelease(): Promise<Release> {
    const base = "https://www.nasm.us/pub/nasm/releasebuilds/",
        version = [...(await getText(base)).matchAll(/href="(\d+(?:\.\d+)+)\/"/g)]
            .map((m) => m[1]!)
            .sort(compareVersions)
            .at(-1);

    if (!version) {
        throw new Error("nasm: no release found");
    }
    return { url: `${base}${version}/win64/nasm-${version}-win64.zip`, version };
}

async function nodeInstaller(report: Report): Promise<{ step: ElevatedStep; version: string } | undefined> {
    const releases = await getJson<{ lts: false | string; version: string }[]>("https://nodejs.org/dist/index.json"),
        version = releases.find((r) => !r.lts)?.version;

    if (!version) {
        throw new Error("node: no current release found");
    }
    if (readVersions().node === version && existsSync(join(NODE_DIR, "node.exe"))) {
        report.current.push("node");
        return undefined;
    }

    const msi = join(TMP, `node-${version}-x64.msi`);
    await download(`https://nodejs.org/dist/${version}/node-${version}-x64.msi`, msi);
    // Restart Manager would close every process holding node.exe, this script included. Disabled, locked files are
    // replaced on the next reboot instead (3010, which the step already reports as a reboot-required notice).
    return {
        step: [
            "node",
            "msiexec.exe",
            ["/i", msi, "/qn", `INSTALLDIR=${NODE_DIR}`, "MSIRESTARTMANAGERCONTROL=Disable"],
            1,
        ],
        version,
    };
}

async function javaRelease(): Promise<Release> {
    const { most_recent_lts } = await getJson<{ most_recent_lts: number }>(
            "https://api.adoptium.net/v3/info/available_releases",
        ),
        [latest] = await getJson<{ binary: { package: { link: string } }; release_name: string }[]>(
            `https://api.adoptium.net/v3/assets/latest/${most_recent_lts}/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse`,
        );

    if (!latest) {
        throw new Error("java: no Temurin build found");
    }
    return { url: latest.binary.package.link, version: latest.release_name };
}

const magick = (quantum: string): Pick<Archive, "bin" | "resolve"> => ({
    bin: ".",
    resolve: () =>
        githubRelease("ImageMagick/ImageMagick", new RegExp(`^ImageMagick-.*-portable-${quantum}-x64\\.7z$`)),
});

const ARCHIVES: Archive[] = [
    {
        name: "llvm",
        noPath: true,
        clang64: true,
        resolve: () => githubRelease("llvm/llvm-project", /^clang\+llvm-.*-x86_64-pc-windows-msvc\.tar\.xz$/),
    },
    { ...cppTool("cmake"), resolve: () => githubRelease("Kitware/CMake", /^cmake-.*-windows-x86_64\.zip$/) },
    {
        ...cppTool("meson"),
        extract: extractMsi,
        resolve: () => githubRelease("mesonbuild/meson", /^meson-[\d.]+-64\.msi$/),
    },
    { ...cppTool("ninja"), resolve: () => githubRelease("ninja-build/ninja", /^ninja-win\.zip$/) },
    { ...cppTool("nasm"), resolve: nasmRelease },
    {
        ...cppTool("pkgconf"),
        extract: extractMsi,
        resolve: () => githubRelease("pkgconf/pkgconf", /^pkgconf-x64-.*\.msi$/),
    },
    { ...cppTool("zig"), resolve: () => zigRelease("x86_64-windows") },
    { ...cppTool("upx"), resolve: () => githubRelease("upx/upx", /-win64\.zip$/) },
    {
        bin: ".",
        name: "actionlint",
        resolve: () => githubRelease("rhysd/actionlint", /^actionlint_[\d.]+_windows_amd64\.zip$/),
    },
    {
        ...cppTool("glslang"),
        resolve: () => githubRelease("KhronosGroup/glslang", /^glslang-main-windows-x86_64-release\.zip$/, "main-tot"),
    },
    { ...cppTool("winflexbison"), resolve: () => githubRelease("lexxmark/winflexbison", /^win_flex_bison-.*\.zip$/) },
    { name: "magick-q8", noPath: true, ...magick("Q8") },
    { name: "magick-q16hdri", ...magick("Q16-HDRI") },
    { name: "ffmpeg", resolve: () => githubRelease("GyanD/codexffmpeg", /^ffmpeg-.*-full_build\.7z$/) },
    { name: "java", shim: true, resolve: javaRelease },
    {
        name: "ruby",
        resolve: () => githubRelease("oneclick/rubyinstaller2", /^rubyinstaller-[\d.-]+-x64\.7z$/),
    },
    {
        bin: ".",
        name: "pwsh",
        resolve: () => githubRelease("PowerShell/PowerShell", /^PowerShell-[\d.]+-win-x64\.zip$/),
    },
    {
        bin: "perl/bin",
        name: "perl",
        shim: true,
        resolve: () =>
            githubRelease("StrawberryPerl/Perl-Dist-Strawberry", /^strawberry-perl-[\d.]+-64bit-portable\.zip$/),
    },
    { bin: ".", name: "x64dbg", resolve: () => githubRelease("x64dbg/x64dbg", /^snapshot_.*\.zip$/) },
    {
        bin: ".",
        name: "ghidra",
        resolve: () => githubRelease("NationalSecurityAgency/ghidra", /^ghidra_.*_PUBLIC_.*\.zip$/),
    },
    {
        bin: ".",
        name: "scyllahide",
        resolve: () => githubRelease("x64dbg/ScyllaHide", /^ScyllaHide_.*\.zip$/),
    },
    { bin: ".", name: "linguist", resolve: () => githubRelease("thurask/Qt-Linguist", /^linguist_6\..*\.zip$/) },
    {
        bin: (root) => findDir(root, "alacritty.exe"),
        extract: extractMsi,
        name: "alacritty",
        resolve: () => githubRelease("alacritty/alacritty", /^Alacritty-v[\d.]+-installer\.msi$/),
    },
    {
        bin: ".",
        name: "zellij",
        resolve: () => githubRelease("zellij-org/zellij", /^zellij-x86_64-pc-windows-msvc\.zip$/),
    },
    {
        bin: (root) => findDir(root, "7z.exe"),
        extract: extractMsi,
        name: "7zip",
        resolve: () => githubRelease("ip7z/7zip", /^7z\d+-x64\.msi$/),
    },
];

const GH_ARCHIVE: Archive = {
    name: "gh",
    resolve: async () => {
        const tag = (await redirectTarget("https://github.com/cli/cli/releases/latest")).split("/").at(-1)!;
        return {
            url: `https://github.com/cli/cli/releases/download/${tag}/gh_${tag.slice(1)}_windows_amd64.zip`,
            version: tag,
        };
    },
};

// Installed right after chromium, before gh.
const GIT_ARCHIVE: Archive = {
    after: (root) => configureGit(join(root, "cmd", "git.exe")),
    bin: "cmd",
    extract: extractSfx,
    name: "git",
    resolve: () => githubRelease("git-for-windows/git", /^PortableGit-.*-64-bit\.7z\.exe$/),
};

const UV: Archive = {
    bin: ".",
    name: "uv",
    resolve: () => githubRelease("astral-sh/uv", /^uv-x86_64-pc-windows-msvc\.zip$/),
};

export async function readUserPath(): Promise<string> {
    const output = await run("reg", ["query", "HKCU\\Environment", "/v", "Path"], { okCodes: [0, 1] });
    return /\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(output)?.[1]?.trim() ?? "";
}

export async function persistPath(dirs: string[]) {
    const entries = (await readUserPath()).split(";").filter(Boolean),
        rootPrefix = `${ROOT.toLowerCase()}\\`,
        binKey = BIN.toLowerCase(),
        // BIN is pinned first: the app shims (shim archives) live there, and should win over the tool dirs.
        next = [BIN, ...entries.filter((e) => !e.toLowerCase().startsWith(rootPrefix) && e.toLowerCase() !== binKey)],
        known = new Set(next.map((e) => e.toLowerCase()));

    for (const dir of dirs) {
        if (!known.has(dir.toLowerCase())) {
            known.add(dir.toLowerCase());
            next.push(dir);
        }
    }

    await run("reg", ["add", "HKCU\\Environment", "/v", "UV_TOOL_BIN_DIR", "/t", "REG_SZ", "/d", BIN, "/f"]);

    if (next.join(";") === entries.join(";")) {
        return;
    }

    await run("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next.join(";"), "/f"]);

    // Setting any user variable through .NET broadcasts WM_SETTINGCHANGE, so new shells pick the change up.
    await run(POWERSHELL, [
        "-NoProfile",
        "-Command",
        "[Environment]::SetEnvironmentVariable('DEV_TOOLS_BROADCAST','1','User');[Environment]::SetEnvironmentVariable('DEV_TOOLS_BROADCAST',$null,'User')",
    ]);
}

const APPDATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    CONFIG_FILES: [string, string][] = [
        ["alacritty.toml", join(APPDATA, "alacritty", "alacritty.toml")],
        ["github_dark.toml", join(APPDATA, "alacritty", "github_dark.toml")],
        ["config.toml", join(homedir(), ".cargo", "config.toml")],
        [".wslconfig", join(homedir(), ".wslconfig")],
        ["CLAUDE.md", join(homedir(), ".claude", "CLAUDE.md")],
    ];

function copyConfigs(): Outcome {
    // Entry point is personal/install-tools/index.ts, so the repo root is two levels above its directory.
    const configs = join(dirname(process.argv[1]!), "..", "..", "configs");
    for (const [name, target] of CONFIG_FILES) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(configs, name), target);
    }
    return "installed";
}

export const regSet = (key: string, data: string, name?: string) =>
    run("reg", [
        "add",
        `HKCU\\Software\\Classes\\${key}`,
        ...(name ? ["/v", name] : ["/ve"]),
        "/t",
        "REG_SZ",
        "/d",
        data,
        "/f",
    ]);

async function registerContextMenus() {
    // %V! + -RemoveWorkingDirectoryTrailingCharacter is what the MSI uses so drive roots ("C:\") survive quoting.
    const pwshCommand = `"${PWSH}" -NoExit -RemoveWorkingDirectoryTrailingCharacter -WorkingDirectory "%V!"`;

    await Promise.all(
        ["Directory", "Directory\\Background", "Drive"].flatMap((key) => [
            regSet(`${key}\\shell\\pwsh7`, "Open in PowerShell 7"),
            regSet(`${key}\\shell\\pwsh7`, PWSH, "Icon"),
            regSet(`${key}\\shell\\pwsh7\\command`, pwshCommand),
        ]),
    );
}

const SEVENZIP_CLASSES = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes",
    SEVENZIP_CLSID = "{23170F69-40C1-278A-1000-000100020000}";

export const SEVENZIP_KEYS = [
    `CLSID\\${SEVENZIP_CLSID}`,
    ...["*", "Directory", "Folder", "Drive"].map((key) => `${key}\\shellex\\ContextMenuHandlers\\7-Zip`),
    ...["Directory", "Drive"].map((key) => `${key}\\shellex\\DragDropHandlers\\7-Zip`),
];
export { SEVENZIP_CLASSES };

async function register7zipMenu(): Promise<Outcome> {
    const dll = join(findDir(join(ROOT, "7zip"), "7-zip.dll"), "7-zip.dll"),
        classes = SEVENZIP_CLASSES,
        clsid = SEVENZIP_CLSID,
        // Plain `reg add` steps rather than an imported .reg file: a file in a user-writable folder could be swapped
        // before the elevated import.
        add = (key: string, data: string, name?: string): ElevatedStep => [
            `7zip-menu:${key}:${name ?? ""}`,
            "reg.exe",
            ["add", `${classes}\\${key}`, ...(name ? ["/v", name] : ["/ve"]), "/t", "REG_SZ", "/d", data, "/f"],
            1,
        ],
        handler = (key: string, kind: string) => add(`${key}\\shellex\\${kind}\\7-Zip`, clsid);

    if (readVersions()["7zip-menu"] === dll) {
        return "current";
    }

    const steps = [
            add(`CLSID\\${clsid}`, "7-Zip Shell Extension"),
            add(`CLSID\\${clsid}\\InprocServer32`, dll),
            add(`CLSID\\${clsid}\\InprocServer32`, "Apartment", "ThreadingModel"),
            ...["*", "Directory", "Folder", "Drive"].map((key) => handler(key, "ContextMenuHandlers")),
            ...["Directory", "Drive"].map((key) => handler(key, "DragDropHandlers")),
        ],
        codes = await runElevated(steps),
        failed = steps.find(([name]) => codes.get(name) !== "0");
    if (failed) {
        throw new Error(`reg add exit code ${codes.get(failed[0]) ?? "unknown (elevation declined?)"}`);
    }

    setVersion("7zip-menu", dll);
    return "installed";
}

export const REBOOT_REQUIRED = 3010,
    ALREADY_INSTALLED = 1638; // Burn bundles (.NET runtimes) when a newer/same version is present

export const psq = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** [name, file, args, attempts] */
export type ElevatedStep = [string, string, string[], number];

let elevatedRuns = 0,
    elevatedQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `steps` in order under one UAC prompt. Returns each step's last exit code by name (missing if elevation was declined).
 * Batches from the dev and personal installers are queued: two Windows Installer runs at once fail with error 1618.
 */
export function runElevated(steps: ElevatedStep[]): Promise<Map<string, string>> {
    const queued = elevatedQueue.then(() => runElevatedNow(steps));
    elevatedQueue = queued.catch(() => undefined);
    return queued;
}

async function runElevatedNow(steps: ElevatedStep[]): Promise<Map<string, string>> {
    // Unique per call so queued batches never share a script or results file.
    const id = elevatedRuns++,
        resultsFile = join(TMP, `elevated-${id}.txt`),
        scriptFile = join(TMP, `elevated-${id}.ps1`),
        succeeded = [0, REBOOT_REQUIRED, ALREADY_INSTALLED].join(",");

    const script = [
        `$results = ${psq(resultsFile)}`,
        // A step whose process fails to start leaves $p null: record -1 instead of an empty (= success) code.
        ...steps.map(
            ([name, file, args, attempts]) =>
                // PowerShell 5.1 rejects an empty -ArgumentList, so it is only passed when there are arguments.
                `$p = $null; for ($i = 0; $i -lt ${attempts}; $i++) { $p = Start-Process -FilePath ${psq(file)}${
                    args.length > 0 ? ` -ArgumentList @(${args.map(psq).join(",")})` : ""
                } -Wait -PassThru -WindowStyle Hidden; if (@(${succeeded}) -contains $p.ExitCode) { break }; Start-Sleep 5 }; Add-Content $results "${name}=$(if ($p) { $p.ExitCode } else { -1 })"`,
        ),
    ].join("\r\n");

    writeFileSync(scriptFile, script);
    rmSync(resultsFile, { force: true });
    // TMP is writable by any process of this user, so the elevated side runs the script only if it still hashes to
    // what was written here, and executes the bytes it hashed (no re-read of the file between check and use).
    const hash = createHash("sha256").update(script, "utf8").digest("hex"),
        verified = `$b = [IO.File]::ReadAllBytes(${psq(scriptFile)}); if (([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)) -replace '-', '') -ne ${psq(hash)}) { exit 99 }; Invoke-Expression ([Text.Encoding]::UTF8.GetString($b))`;

    // Each finished step appends a line to the results file, which makes it the progress signal for the opaque elevated process.
    await inTask("elevated install", async () => {
        stage("install");
        const poll = setInterval(() => {
            const finished = existsSync(resultsFile)
                ? readFileSync(resultsFile, "utf8").split(/\r?\n/).filter(Boolean).length
                : 0;
            progress(finished, steps.length, `${finished}/${steps.length} ${steps[finished]?.[0] ?? ""}`.trimEnd());
        }, 500);
        try {
            await run(POWERSHELL, [
                "-NoProfile",
                "-Command",
                `Start-Process ${psq(POWERSHELL)} -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',${psq(`"${verified}"`)}`,
            ]);
        } finally {
            clearInterval(poll);
        }
    });

    return new Map(
        (existsSync(resultsFile) ? readFileSync(resultsFile, "utf8") : "")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => line.split("=") as [string, string]),
    );
}

const VS_INSTANCES = "C:\\ProgramData\\Microsoft\\VisualStudio\\Packages\\_Instances";

/**
 * Registered Visual Studio instances whose install directory no longer exists (deleted by hand or a rolled-back install).
 * vswhere doesn't list them, but the installer still finds the registration and the install then fails with exit code 8004
 * ("Pre-check verification failed: TargetDirCheck"), so the registration has to go first.
 */
function staleVsInstances(): string[] {
    if (!existsSync(VS_INSTANCES)) {
        return [];
    }

    return readdirSync(VS_INSTANCES)
        .map((id) => join(VS_INSTANCES, id))
        .filter((dir) => {
            try {
                const { installationPath } = JSON.parse(
                    readFileSync(join(dir, "state.json"), "utf8").replace(/^\uFEFF/, ""),
                ) as {
                    installationPath?: string;
                };
                return installationPath !== undefined && !existsSync(installationPath);
            } catch {
                return false;
            }
        });
}

async function msvcSteps(report: Report): Promise<ElevatedStep[]> {
    const installer = join(TMP, "vs_BuildTools.exe"),
        vswhere = join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
        steps: ElevatedStep[] = [];

    await download("https://aka.ms/vs/stable/vs_BuildTools.exe", installer);

    // Must precede the msvc steps: see staleVsInstances.
    for (const dir of staleVsInstances()) {
        steps.push([`msvc-stale-instance-${dir.split("\\").at(-1)}`, "cmd.exe", ["/c", "rmdir", "/s", "/q", dir], 1]);
    }

    const vsQuery = async (property: string, requires: string[] = []) =>
            existsSync(vswhere)
                ? (
                      await run(vswhere, [
                          "-latest",
                          "-products",
                          "*",
                          ...(requires.length > 0 ? ["-requires", ...requires] : []),
                          "-property",
                          property,
                      ])
                  ).trim()
                : "",
        installPath = await vsQuery("installationPath"),
        quiet = ["--quiet", "--wait", "--norestart", "--nocache"],
        components = VS_COMPONENTS.flatMap((c) => ["--add", c]);

    if (installPath) {
        const quotedPath = `"${installPath}"`,
            // The bootstrapper's file version is the latest release's build number.
            latest = (
                await run(POWERSHELL, [
                    "-NoProfile",
                    "-Command",
                    `(Get-Item ${psq(installer)}).VersionInfo.FileVersion`,
                ])
            ).trim(),
            outdated = (await vsQuery("installationVersion")) !== latest,
            incomplete = !(await vsQuery("installationPath", VS_COMPONENTS));

        if (outdated) {
            steps.push(["msvc-update", installer, ["update", "--installPath", quotedPath, ...quiet], 1]);
        }
        if (incomplete) {
            steps.push(["msvc", installer, ["modify", "--installPath", quotedPath, ...components, ...quiet], 1]);
        }
        if (!outdated && !incomplete) {
            report.current.push("msvc");
        }
    } else {
        steps.push(["msvc", installer, [...components, ...quiet], 1]);
    }

    return steps;
}

// `toolchains` only skips work: without "msvc" the Visual Studio Build Tools are left out.
async function elevatedJobs(report: Report, toolchains: Toolchain[]) {
    plan(["prepare", "download", "install"]);

    // [name, file, args, attempts]. Runtime installers are retried: dxwebsetup fails sporadically with -9.
    const steps: ElevatedStep[] = [],
        // Recorded in .versions.json once a step succeeds, so later runs skip it until the upstream version changes.
        stamps = new Map<string, string>(),
        versions = readVersions();

    let codes = new Map<string, string>();

    try {
        const wslInstalled = await run("wsl.exe", ["--status"]).then(
            () => true,
            () => false,
        );
        // Runtimes and Windows features first, so a failed download only drops its own step.
        const dism = (features: string[]) => [
            "/Online",
            "/Enable-Feature",
            ...features.map((f) => `/FeatureName:${f}`),
            "/All",
            "/NoRestart",
        ];
        for (const [name, features] of [
            ["netfx3", NETFX3_FEATURES],
            ["netfx4-extras", NETFX4_FEATURES],
        ] as const) {
            if (versions[name]) {
                report.current.push(name);
            } else {
                steps.push([name, "dism.exe", dism(features), 1]);
                stamps.set(name, "enabled");
            }
        }

        const fetched = await pool(RUNTIME_INSTALLERS, 4, async ([name, url, args]) => {
            const version = await redirectTarget(url);
            if (versions[name] === version) {
                return undefined;
            }

            let file = join(TMP, `${name}.exe`);
            await download(url, file);
            if (name === "directx") {
                const dir = join(TMP, "directx");
                await run(file, ["/Q", `/T:${dir}`]);
                file = join(dir, "DXSETUP.exe");
            }
            stamps.set(name, version);
            return [name, file, args, 3] as [string, string, string[], number];
        });
        for (const [index, result] of fetched.entries()) {
            if (result.status === "fulfilled") {
                if (result.value) {
                    steps.push(result.value);
                } else {
                    report.current.push(RUNTIME_INSTALLERS[index]![0]);
                }
            } else {
                const reason = result.reason as unknown;
                report.failed.push([
                    RUNTIME_INSTALLERS[index]![0],
                    reason instanceof Error ? reason.message : String(reason),
                ]);
            }
        }

        // Node is its own step, so a failed lookup only drops that step, not the msvc/wsl ones below.
        const node = await nodeInstaller(report).catch((error: unknown) => {
            report.failed.push(["node", error instanceof Error ? error.message : String(error)]);
            return undefined;
        });
        if (node) {
            steps.push(node.step);
            stamps.set("node", node.version);
        }

        if (toolchains.includes("msvc")) {
            steps.push(...(await msvcSteps(report)));
        }

        if (!wslInstalled) {
            steps.push(["wsl", "wsl.exe", ["--install", "--no-distribution"], 1]);
        }

        // Machine-wide (system) variables; setx /M also broadcasts the change. Only the ones that differ cause a step.
        const machineEnv = async (key: string) =>
            /\sREG_(?:EXPAND_)?SZ\s+(.*)/i
                .exec(await run("reg", ["query", MACHINE_ENV_KEY, "/v", key], { okCodes: [0, 1] }))?.[1]
                ?.trim();
        for (const [key, value] of MACHINE_ENV) {
            if ((await machineEnv(key)) !== value) {
                steps.push([`env:${key}`, "setx.exe", [key, value, "/M"], 1]);
            }
        }
        if (steps.length === 0) {
            return; // nothing to do, so no UAC prompt either
        }

        codes = await runElevated(steps);
    } catch (error) {
        report.failed.push(["msvc/wsl", error instanceof Error ? error.message : String(error)]);
        return;
    }

    for (const [name] of steps) {
        await report.step(name, () => {
            const code = Number(codes.get(name));
            if (code === REBOOT_REQUIRED) {
                log(`! ${name}: reboot required to finish`);
            } else if (code !== 0 && code !== ALREADY_INSTALLED) {
                throw new Error(`exit code ${codes.get(name) ?? "unknown (elevation declined?)"}`);
            }

            const stamp = stamps.get(name);
            if (stamp) {
                setVersion(name, stamp);
            }
        });
    }
}

async function installMsys2(): Promise<Outcome> {
    const bash = join(MSYS2, "usr", "bin", "bash.exe"),
        shell = (command: string) => run(bash, ["-lc", command], { env: { CHERE_INVOKING: "1", MSYSTEM: "MSYS" } });

    let outcome: Outcome = "current";

    plan(["download", "extract", "update", "packages"]);
    if (!existsSync(bash)) {
        const sfx = join(TMP, "msys2.sfx.exe");
        await download(
            "https://github.com/msys2/msys2-installer/releases/latest/download/msys2-base-x86_64-latest.sfx.exe",
            sfx,
        );
        stage("extract");
        await run(sfx, ["-y", `-o${dirname(MSYS2)}`]); // the archive's top-level directory is msys64
        await shell("exit"); // first run initialises the keyring and /etc
        outcome = "installed";
    }
    stage("update");

    // Mirror misses (404s, timeouts) abort pacman; rerunning picks up where it left off. This also covers
    // the first -Syuu updating pacman itself and bailing out early.
    const pacman = async (args: string) => {
        for (let attempt = 1; ; attempt++) {
            try {
                return await shell(`pacman --noconfirm ${args}`);
            } catch (error) {
                if (attempt === 4) {
                    throw error;
                }
            }
        }
    };

    await pacman("-Syuu");
    await pacman("-Syuu");

    const packages = [...MSYS2_BASE_PACKAGES, ...MSYS2_MINGW_PACKAGES.map((p) => `mingw-w64-clang-x86_64-${p}`)];
    stage("packages");
    await pacman(`--needed -S ${packages.join(" ")}`);

    return outcome;
}

// ---------------------------------------------------------------------------------------------
// Rust, cargo tools, uv tools, Claude Code
// ---------------------------------------------------------------------------------------------

const GNULLVM = "-x86_64-pc-windows-gnullvm";

async function installRustup(toolchains: Toolchain[]): Promise<Outcome> {
    plan(["rustup", "toolchains"]);
    if (existsSync(join(CARGO_BIN, "rustup.exe"))) {
        await run("rustup", ["self", "update"]);
    } else {
        const initializer = join(TMP, "rustup-init.exe");
        await download("https://win.rustup.rs/x86_64", initializer);
        await run(initializer, ["-y", "--default-toolchain", "none", "--profile", "minimal"]);
    }

    stage("toolchains");
    // msvc: the MSVC-host toolchains; clang: gnullvm (alone, there is no MSVC linker on that machine). Both: msvc is the default.
    const variants = toolchains.map((toolchain) => (toolchain === "clang" ? GNULLVM : ""));
    await installRustToolchains(
        variants.flatMap((suffix) => [`stable${suffix}`, `nightly${suffix}`]),
        `nightly${variants.includes("") ? "" : GNULLVM}`,
    );
    return "installed";
}

async function installBinstall(): Promise<Outcome> {
    if (existsSync(join(CARGO_BIN, "cargo-binstall.exe"))) {
        return "current";
    }

    const release = await githubRelease(
            "cargo-bins/cargo-binstall",
            /^cargo-binstall-x86_64-pc-windows-msvc\.(?:full\.)?zip$/,
        ),
        work = join(TMP, "binstall");

    mkdirSync(work, { recursive: true });
    const archive = join(work, "binstall.zip");
    await download(release.url, archive);
    await run(TAR, ["-xf", archive, "-C", work]);
    copyFileSync(join(work, "cargo-binstall.exe"), join(CARGO_BIN, "cargo-binstall.exe"));
    return "installed";
}

async function installClaude(): Promise<Outcome> {
    if (existsSync(join(homedir(), ".local", "bin", "claude.exe"))) {
        return "current"; // self-updating
    }

    await run(POWERSHELL, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm https://claude.ai/install.ps1 | iex",
    ]);
    return "installed";
}

// pnpm's installer verifies the npm signature, then runs `pnpm setup --force`: PNPM_HOME and the user PATH, so it is the default.
// Old Ruby versions for building legacy projects: side by side in C:\PATH\<name>, deliberately not on PATH
// (the current Ruby is the `ruby` archive). Pinned URLs, so the URL doubles as the version stamp. Newer branches follow below.
const OLD_RUBIES: [string, string][] = [
    [
        "ruby-1.8.7",
        "https://github.com/oneclick/rubyinstaller/releases/download/ruby-1.8.7-p374/rubyinstaller-1.8.7-p374.exe",
    ],
    [
        "ruby-1.9.3",
        "https://github.com/oneclick/rubyinstaller/releases/download/ruby-1.9.3-p551/rubyinstaller-1.9.3-p551.exe",
    ],
    [
        "ruby-2.7.8",
        "https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-2.7.8-1/rubyinstaller-2.7.8-1-x64.exe",
    ],
];

// Newest release of each Ruby branch, side by side the same way. Each branch dir is updated in place as new patches ship.
const RUBY_BRANCHES = ["3.3", "3.4", "4.0"];

const rubyBranch = (branch: string): Promise<Release> =>
    githubReleaseMatching(
        "oneclick/rubyinstaller2",
        new RegExp(`^RubyInstaller-${branch.replaceAll(".", "\\.")}\\.\\d+-\\d+$`),
        (tag) => `${tag.replace("RubyInstaller-", "rubyinstaller-")}-x64.exe`,
    );

// [dir name, resolves the release to install]
const RUBIES: [string, () => Promise<Release>][] = [
    ...OLD_RUBIES.map(([name, url]): [string, () => Promise<Release>] => [name, async () => ({ url, version: url })]),
    ...RUBY_BRANCHES.map((branch): [string, () => Promise<Release>] => [`ruby-${branch}`, () => rubyBranch(branch)]),
];

/** Inno Setup installer run silently into its own dir: per-user (no UAC), no file associations, no PATH changes (empty /TASKS). */
async function installRuby(name: string, { url, version }: Release): Promise<Outcome> {
    const dir = join(ROOT, name);
    if (readVersions()[name] === version && existsSync(dir)) {
        return "current";
    }

    plan(["download", "install"]);
    const file = join(TMP, `${name}.exe`);
    await download(url, file);
    stage("install");
    await run(file, [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/SP-",
        "/CURRENTUSER",
        `/DIR=${dir}`,
        "/TASKS=",
    ]);
    if (!existsSync(join(dir, "bin", "ruby.exe"))) {
        throw new Error(`${name}: installer finished but bin\\ruby.exe is missing`);
    }
    setVersion(name, version);
    return "installed";
}

async function installPnpm(): Promise<Outcome> {
    const { version } = await getJson<{ version: string }>("https://registry.npmjs.org/pnpm/latest"),
        home = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "pnpm");

    if (readVersions().pnpm === version && existsSync(home)) {
        return "current";
    }

    await run(
        POWERSHELL,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://get.pnpm.io/install.ps1 | iex"],
        { env: { PNPM_VERSION: version } },
    );
    setVersion("pnpm", version);
    return "installed";
}

const NPM_PACKAGES = ["@caveman-ai/cli", "@colbymchenry/codegraph"];

/** Global npm CLIs, pinned to `@latest` so reruns upgrade them. Runs npm's CLI with the bundled node.exe, since npm.cmd can't be spawned without a shell. */
async function npmTools(report: Report): Promise<void> {
    for (const pkg of NPM_PACKAGES) {
        await report.step(`npm:${pkg}`, async () => {
            await run("npm", ["install", "-g", `${pkg}@latest`]);
        });
    }
}

/**
 * Per-user install (no elevation): copies into the user's Fonts folder and registers each file under HKCU,
 * which is where Windows looks for per-user fonts at logon. Version-stamped, since the copies can be locked by apps.
 */
async function installNerdFont(): Promise<Outcome> {
    const release = await githubRelease("ryanoasis/nerd-fonts", /^Inconsolata\.zip$/),
        fonts = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Microsoft", "Windows", "Fonts");

    if (readVersions()["inconsolata-nerd-font"] === release.version && existsSync(fonts)) {
        return "current";
    }

    const work = join(TMP, "inconsolata-nerd-font");
    rmSync(work, { force: true, recursive: true });
    mkdirSync(work, { recursive: true });
    const archive = join(work, "Inconsolata.zip");
    await download(release.url, archive);
    await run(TAR, ["-xf", archive, "-C", work]);

    mkdirSync(fonts, { recursive: true });
    for (const file of readdirSync(work).filter((name) => name.endsWith(".ttf"))) {
        const target = join(fonts, file);
        copyFileSync(join(work, file), target);
        await run("reg", [
            "add",
            "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
            "/v",
            `${basename(file, ".ttf")} (TrueType)`,
            "/t",
            "REG_SZ",
            "/d",
            target,
            "/f",
        ]);
    }

    rmSync(work, { force: true, recursive: true });
    setVersion("inconsolata-nerd-font", release.version);
    return "installed";
}

// ---------------------------------------------------------------------------------------------

/** The personal-only Windows pieces (see personal.ts), passed in so this file stays free of a circular import. */
export interface Personal {
    archives: Archive[];
    chromium: Archive;
    /** Install dirs of the silent-installer programs, put on PATH once present. */
    programDirs: string[];
    installPrograms: (report: Report) => Promise<void>;
    registerVscode: () => Promise<void>;
}

export async function installWindows(report: Report, personal: Personal, toolchains: Toolchain[]) {
    mkdirSync(BIN, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    const clangOnly = !toolchains.includes("msvc");
    // clang only: cargo's source fallbacks (gnullvm host) link with CLANG64's clang; msvc leaves CLANG64 untouched.
    process.env.PATH = [BIN, CARGO_BIN, ...(clangOnly ? [CLANG64_BIN] : []), process.env.PATH].join(";");

    // Fixed order: chromium, git, gh. The first two resolve through the anonymous GitHub API (GITHUB_TOKEN is honored if set);
    // gh resolves through the "latest" redirect and then serves every later release lookup.
    await report.step(personal.chromium.name, () => installArchive(personal.chromium));
    await report.step(GIT_ARCHIVE.name, () => installArchive(GIT_ARCHIVE));
    await report.step(GH_ARCHIVE.name, () => installArchive(GH_ARCHIVE));
    await enableGh().catch(() => undefined);

    const elevated = track("runtimes & msvc", () => elevatedJobs(report, toolchains));
    // clang takes everything flagged clang64 from CLANG64 instead.
    const archives = [...ARCHIVES, ...personal.archives].filter((archive) => !clangOnly || !archive.clang64);

    await Promise.all([
        elevated,
        pool(archives, 4, (archive) => report.step(archive.name, () => installArchive(archive))),
        personal.installPrograms(report),
        pool(RUBIES, 2, ([name, resolve]) => report.step(name, async () => installRuby(name, await resolve()))),
        ...(toolchains.includes("clang") ? [report.step("msys2", installMsys2)] : []),
        report.step("claude", installClaude),
        report.step("pnpm", installPnpm),
        (async () => {
            await elevated; // Node.js comes from the elevated MSI
            await npmTools(report);
        })(),
        report.step("inconsolata nerd font", installNerdFont),
        (async () => {
            await report.step("rustup", () => installRustup(toolchains));
            await report.step("cargo-binstall", installBinstall);
            if (toolchains.includes("msvc")) {
                await elevated; // compiling fallbacks need the MSVC linker
            }
            // Prebuilt binaries are MSVC builds: on the gnullvm host binstall would otherwise compile everything.
            await cargoTools(report, clangOnly ? ["--targets", "x86_64-pc-windows-msvc"] : []);
        })(),
        (async () => {
            await report.step("uv", () => installArchive(UV));
            await uvTools(report, { UV_TOOL_BIN_DIR: BIN });
        })(),
    ]);

    // Re-run every time: reinstalling x64dbg wipes its plugins dir. Ships x32/x64 plugins + hook DLLs + ini.
    await report.step("scyllahide x64dbg plugin", () => {
        const source = join(ROOT, "scyllahide", "x64dbg"),
            target = join(ROOT, "x64dbg");
        if (!existsSync(source) || !existsSync(target)) {
            throw new Error("scyllahide or x64dbg not installed");
        }
        cpSync(source, target, { force: false, recursive: true }); // keep the user's edited scylla_hide.ini
        return "current";
    });

    await report.step("configs", copyConfigs);
    await report.step("context menus", registerContextMenus);
    await report.step("7-zip context menu", register7zipMenu);
    await report.step("vscode integration", personal.registerVscode);

    // Declaration order, not install-completion order, decides clashes (GyanD's ffmpeg.exe over Krita's).
    const toolDirs = [personal.chromium, GIT_ARCHIVE, GH_ARCHIVE, UV, ...archives]
        .filter(onPath)
        .map(archiveBin)
        .filter((dir): dir is string => dir !== undefined);

    await report.step("user PATH", async () => {
        await persistPath([
            BIN,
            ...toolDirs,
            join(APPDATA, "npm"),
            ...personal.programDirs.filter((dir) => existsSync(dir)),
        ]);
    });

    rmSync(TMP, { force: true, recursive: true });
}
