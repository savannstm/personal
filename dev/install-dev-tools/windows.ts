import console from "node:console";
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import process from "node:process";

import type { Report } from "./util.ts";

import {
    cargoTools,
    compareVersions,
    download,
    getJson,
    getText,
    githubRelease,
    installRustToolchains,
    type Outcome,
    pool,
    redirectTarget,
    type Release,
    run,
    uvTools,
    zigRelease,
} from "./util.ts";

const ROOT = "C:\\PATH",
    BIN = join(ROOT, "bin"),
    TMP = join(ROOT, ".tmp"),
    VERSIONS = join(ROOT, ".versions.json"),
    MSYS2 = "C:\\msys64",
    CARGO_BIN = join(homedir(), ".cargo", "bin"),
    TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
    PWSH = join(ROOT, "pwsh", "pwsh.exe");

// Shared with the personal tools installer (personal/install-personal-tools.ts).
export { BIN, PWSH, ROOT, TMP };

const MSYS2_BASE_PACKAGES = ["bison", "flex", "file", "autoconf", "automake", "make", "pkgconf", "python"],
    MSYS2_MINGW_PACKAGES = [
        "toolchain",
        "clang",
        "lld",
        "llvm",
        "lldb",
        "llvm-openmp",
        "clang-tools-extra",
        "libunwind",
        "cmake",
        "ninja",
        "meson",
        "nasm",
    ],
    VS_COMPONENTS = [
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "Microsoft.VisualStudio.Component.Windows11SDK.28000", // 10.0.28000.2526
        "Microsoft.VisualStudio.Component.VC.ATL",
        "Microsoft.VisualStudio.Component.VC.ATLMFC",
        "Microsoft.VisualStudio.Component.VC.ASAN",
    ],
    // Windows optional features: .NET 3.5 (covers 2.0/3.0) and the 4.x advanced services + ASP.NET 4.x
    NETFX3_FEATURES = ["NetFx3"],
    NETFX4_FEATURES = ["NetFx4-AdvSrvs", "NetFx4Extended-ASPNET45"],
    // Silent installers run elevated: [step name, url, args]. aka.ms links always resolve to the latest patch.
    RUNTIME_INSTALLERS: [string, string, string[]][] = [
        [
            "vcredist-aio",
            "https://github.com/abbodi1406/vcredist/releases/latest/download/VisualCppRedist_AIO_x86_x64.exe",
            ["/ai"],
        ],
        // Offline June 2010 redist (legacy d3dx9/xinput/MDX). Unpacked to DXSETUP.exe before the elevated run, because
        // dxwebsetup /Q fails with -9 ("Sections are not initialized") when run silent and hidden.
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

// ---------------------------------------------------------------------------------------------
// Fetched archives: C:\PATH\<name>\ plus symlinks to the exes in C:\PATH\bin
// ---------------------------------------------------------------------------------------------

export interface LinkSpec {
    name: string;
    /** Directory with the exes, relative to the tool root (default "bin"), or computed from it. */
    bin?: ((root: string) => string) | string;
    /** link name -> exe path relative to `bin`. Default: every *.exe in `bin`. */
    links?: Record<string, string>;
    /** Put the real bin dir on PATH instead of symlinking (for tools that locate files via their own path). */
    onPath?: boolean;
}

export interface Archive extends LinkSpec {
    resolve: () => Promise<Release>;
    extract?: (file: string, dest: string) => Promise<void>;
}

/** Real bin dirs that must be on the user PATH because symlinks don't work for them. */
export const pathDirs = new Set<string>();

export const readVersions = (): Record<string, string> =>
    existsSync(VERSIONS) ? (JSON.parse(readFileSync(VERSIONS, "utf8")) as Record<string, string>) : {};

export function setVersion(name: string, version: string) {
    writeFileSync(VERSIONS, JSON.stringify({ ...readVersions(), [name]: version }, null, 2));
}

function findDir(root: string, file: string): string {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase() === file) {
            return entry.parentPath;
        }
    }
    throw new Error(`${file} not found under ${root}`);
}

function link({ bin = "bin", links, name, onPath }: LinkSpec) {
    const root = join(ROOT, name),
        binDir = typeof bin === "function" ? bin(root) : join(root, bin);

    if (onPath) {
        pathDirs.add(binDir);
        // Drop symlinks from earlier runs that linked this tool: BIN precedes pathDirs on PATH and would shadow it.
        // Only links pointing into binDir: a same-named exe of another tool must survive (Krita ships its own ffmpeg.exe).
        const prefix = `${binDir.toLowerCase()}\\`;
        for (const entry of readdirSync(BIN, { withFileTypes: true })) {
            const linkPath = join(BIN, entry.name);
            if (
                entry.isSymbolicLink() &&
                readlinkSync(linkPath)
                    .replace(/^\\\\\?\\/, "")
                    .toLowerCase()
                    .startsWith(prefix)
            ) {
                rmSync(linkPath);
            }
        }
        return;
    }

    const entries =
        links ??
        Object.fromEntries(
            readdirSync(binDir)
                .filter((f) => f.toLowerCase().endsWith(".exe"))
                .map((f) => [f, f]),
        );

    for (const [linkName, exe] of Object.entries(entries)) {
        const linkPath = join(BIN, linkName);
        rmSync(linkPath, { force: true });
        try {
            symlinkSync(join(binDir, exe), linkPath, "file");
        } catch (error) {
            if ((error as { code?: string }).code !== "EPERM") {
                throw error;
            }
            // No symlink privilege (Developer Mode off, not elevated): fall back to PATH for this tool.
            pathDirs.add(binDir);
            return;
        }
    }
}

const extractTar = async (file: string, dest: string) => void (await run(TAR, ["-xf", file, "-C", dest]));
const extractSfx = async (file: string, dest: string) => void (await run(file, ["-y", `-o${dest}`]));
const extractMsi = async (file: string, dest: string) =>
    void (await run("msiexec.exe", ["/a", file, "/qn", `TARGETDIR=${dest}`]));

export async function installArchive(spec: Archive): Promise<Outcome> {
    const release = await spec.resolve(),
        root = join(ROOT, spec.name);

    if (readVersions()[spec.name] === release.version && existsSync(root)) {
        link(spec);
        return "current";
    }

    const work = join(TMP, spec.name),
        out = join(work, "x");
    rmSync(work, { force: true, recursive: true });
    mkdirSync(out, { recursive: true });

    const file = join(work, `download${extname(new URL(release.url).pathname)}`);
    await download(release.url, file);
    await (spec.extract ?? extractTar)(file, out);

    // Archives wrapped in a single top-level directory get that directory stripped.
    const entries = readdirSync(out, { withFileTypes: true }),
        source = entries.length === 1 && entries[0]!.isDirectory() ? join(out, entries[0]!.name) : out;

    rmSync(root, { force: true, recursive: true });
    renameSync(source, root);
    rmSync(work, { force: true, recursive: true });

    setVersion(spec.name, release.version);
    link(spec);
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

async function nodeRelease(): Promise<Release> {
    const releases = await getJson<{ lts: false | string; version: string }[]>("https://nodejs.org/dist/index.json"),
        version = releases.find((r) => r.lts)?.version;

    if (!version) {
        throw new Error("node: no LTS release found");
    }
    return { url: `https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`, version };
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

// `primary` also exposes the build as plain magick.exe.
const magick = (quantum: string, primary = false): Pick<Archive, "bin" | "links" | "resolve"> => ({
    bin: ".",
    links: {
        [`magick-${quantum.toLowerCase().replace("-", "")}.exe`]: "magick.exe",
        ...(primary && { "magick.exe": "magick.exe" }),
    },
    resolve: () =>
        githubRelease("ImageMagick/ImageMagick", new RegExp(`^ImageMagick-.*-portable-${quantum}-x64\\.7z$`)),
});

const ARCHIVES: Archive[] = [
    {
        name: "llvm",
        resolve: () => githubRelease("llvm/llvm-project", /^clang\+llvm-.*-x86_64-pc-windows-msvc\.tar\.xz$/),
    },
    { name: "cmake", resolve: () => githubRelease("Kitware/CMake", /^cmake-.*-windows-x86_64\.zip$/) },
    { bin: ".", name: "ninja", resolve: () => githubRelease("ninja-build/ninja", /^ninja-win\.zip$/) },
    { bin: ".", name: "zig", resolve: () => zigRelease("x86_64-windows") },
    { bin: ".", name: "upx", resolve: () => githubRelease("upx/upx", /-win64\.zip$/) },
    { bin: ".", name: "nasm", resolve: nasmRelease },
    {
        name: "glslang",
        resolve: () => githubRelease("KhronosGroup/glslang", /^glslang-main-windows-x86_64-release\.zip$/, "main-tot"),
    },
    {
        // win_bison finds data/m4sugar relative to its real path, so a symlink in BIN breaks it.
        bin: ".",
        name: "winflexbison",
        onPath: true,
        resolve: () => githubRelease("lexxmark/winflexbison", /^win_flex_bison-.*\.zip$/),
    },
    { name: "magick-q8", ...magick("Q8") },
    { name: "magick-q16hdri", ...magick("Q16-HDRI", true) },
    { name: "ffmpeg", resolve: () => githubRelease("GyanD/codexffmpeg", /^ffmpeg-.*-full_build\.7z$/) },
    { bin: ".", links: { "node.exe": "node.exe" }, name: "node", resolve: nodeRelease },
    { name: "java", onPath: true, resolve: javaRelease },
    {
        name: "ruby",
        onPath: true,
        resolve: () => githubRelease("oneclick/rubyinstaller2", /^rubyinstaller-[\d.-]+-x64\.7z$/),
    },
    {
        bin: "cmd",
        extract: extractSfx,
        name: "git",
        resolve: () => githubRelease("git-for-windows/git", /^PortableGit-.*-64-bit\.7z\.exe$/),
    },
    { name: "gh", resolve: () => githubRelease("cli/cli", /_windows_amd64\.zip$/) },
    // x96dbg.exe (launcher/picker) sits in the root and finds x32/x64 relative to itself, so it goes on PATH instead of being symlinked.
    { bin: ".", name: "x64dbg", onPath: true, resolve: () => githubRelease("x64dbg/x64dbg", /^snapshot_.*\.zip$/) },
    // Needs the JDK installed above. Only the launcher scripts are exposed.
    {
        bin: ".",
        name: "ghidra",
        onPath: true,
        resolve: () => githubRelease("NationalSecurityAgency/ghidra", /^ghidra_.*_PUBLIC_.*\.zip$/),
    },
    // Standalone injector CLI; the x64dbg plugin is copied into x64dbg after both are installed (see installWindows).
    {
        bin: ".",
        name: "scyllahide",
        resolve: () => githubRelease("x64dbg/ScyllaHide", /^ScyllaHide_.*\.zip$/),
    },
    // The release ships Qt 5 and Qt 6 builds with identical exe names: only Qt 6 is linked into BIN.
    { bin: ".", name: "linguist", resolve: () => githubRelease("thurask/Qt-Linguist", /^linguist_6\..*\.zip$/) },
    {
        bin: ".",
        links: {},
        name: "linguist5",
        resolve: () => githubRelease("thurask/Qt-Linguist", /^linguist_5\..*\.zip$/),
    },
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
        onPath: true, // 7z.exe loads 7z.dll from its own directory, which a symlink in BIN doesn't provide
        resolve: () => githubRelease("ip7z/7zip", /^7z\d+-x64\.msi$/),
    },
    {
        bin: (root) => findDir(root, "pkgconf.exe"),
        extract: extractMsi,
        name: "pkgconf",
        resolve: () => githubRelease("pkgconf/pkgconf", /^pkgconf-x64-.*\.msi$/),
    },
];

// PowerShell 7 is installed first; every later PowerShell invocation goes through PWSH.
const PWSH_ARCHIVE: Archive = {
    bin: ".",
    name: "pwsh",
    onPath: true,
    resolve: () => githubRelease("PowerShell/PowerShell", /^PowerShell-[\d.]+-win-x64\.zip$/),
};

const UV: Archive = {
    bin: ".",
    name: "uv",
    resolve: () => githubRelease("astral-sh/uv", /^uv-x86_64-pc-windows-msvc\.zip$/),
};

// ---------------------------------------------------------------------------------------------
// User environment (registry)
// ---------------------------------------------------------------------------------------------

async function readUserPath(): Promise<string> {
    const output = await run("reg", ["query", "HKCU\\Environment", "/v", "Path"], { okCodes: [0, 1] });
    return /\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(output)?.[1]?.trim() ?? "";
}

/** Appends `dirs` to the user PATH, keeping REG_EXPAND_SZ (which `setx` would truncate and flatten). */
export async function persistPath(dirs: string[]) {
    const entries = (await readUserPath()).split(";").filter(Boolean),
        binKey = BIN.toLowerCase(),
        // BIN is pinned first so its symlinks beat the real tool dirs further down (Krita's ffmpeg.exe, ...).
        next = [BIN, ...entries.filter((e) => e.toLowerCase() !== binKey)],
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
    await run(PWSH, [
        "-NoProfile",
        "-Command",
        "[Environment]::SetEnvironmentVariable('DEV_TOOLS_BROADCAST','1','User');[Environment]::SetEnvironmentVariable('DEV_TOOLS_BROADCAST',$null,'User')",
    ]);
}

// ---------------------------------------------------------------------------------------------
// Config files: configs/ in this repo is the source of truth, so every run overwrites the installed copies
// ---------------------------------------------------------------------------------------------

const APPDATA = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    // repo file -> destination
    CONFIG_FILES: [string, string][] = [
        ["alacritty.toml", join(APPDATA, "alacritty", "alacritty.toml")],
        ["github_dark.toml", join(APPDATA, "alacritty", "github_dark.toml")],
        ["config.toml", join(homedir(), ".cargo", "config.toml")],
        [".wslconfig", join(homedir(), ".wslconfig")],
        ["CLAUDE.md", join(homedir(), ".claude", "CLAUDE.md")],
    ];

function copyConfigs(): Outcome {
    // Entry point is dev/install-dev-tools/index.ts, so the repo root is two levels above its directory.
    const configs = join(dirname(process.argv[1]!), "..", "..", "configs");
    for (const [name, target] of CONFIG_FILES) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(configs, name), target);
    }
    return "installed";
}

// ---------------------------------------------------------------------------------------------
// Explorer context menus: the portable 7-Zip / PowerShell 7 copies register nothing themselves
// ---------------------------------------------------------------------------------------------

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

/** Per-user (HKCU) registration, idempotent, no elevation. Classic menu; Windows 11 shows it under "Show more options". */
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

/**
 * 7-Zip's shell extension, registered machine-wide like its installer does (one UAC prompt, only when the DLL path changes).
 * The same keys under HKCU instantiate fine through COM, but the shell never loads the handler from there.
 */
async function register7zipMenu(): Promise<Outcome> {
    const dll = join(findDir(join(ROOT, "7zip"), "7-zip.dll"), "7-zip.dll"),
        clsid = "{23170F69-40C1-278A-1000-000100020000}",
        classes = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes",
        regFile = join(TMP, "7zip-menu.reg"),
        handler = (key: string, kind: string) => `[${classes}\\${key}\\shellex\\${kind}\\7-Zip]\r\n@="${clsid}"`;

    if (readVersions()["7zip-menu"] === dll) {
        return "current";
    }

    writeFileSync(
        regFile,
        [
            "REGEDIT4",
            `[${classes}\\CLSID\\${clsid}]\r\n@="7-Zip Shell Extension"`,
            `[${classes}\\CLSID\\${clsid}\\InprocServer32]\r\n@="${dll.replaceAll("\\", "\\\\")}"\r\n"ThreadingModel"="Apartment"`,
            ...["*", "Directory", "Folder", "Drive"].map((key) => handler(key, "ContextMenuHandlers")),
            ...["Directory", "Drive"].map((key) => handler(key, "DragDropHandlers")),
            "",
        ].join("\r\n\r\n"),
    );

    const codes = await runElevated([["7zip-menu", "reg.exe", ["import", regFile], 1]]);
    if (codes.get("7zip-menu") !== "0") {
        throw new Error(`reg import exit code ${codes.get("7zip-menu") ?? "unknown (elevation declined?)"}`);
    }

    setVersion("7zip-menu", dll);
    return "installed";
}

// ---------------------------------------------------------------------------------------------
// Runtimes, Windows features, MSVC Build Tools + WSL: the only parts that need elevation, under a single UAC prompt
// ---------------------------------------------------------------------------------------------

export const REBOOT_REQUIRED = 3010,
    ALREADY_INSTALLED = 1638; // Burn bundles (.NET runtimes) when a newer/same version is present

const psq = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** [name, file, args, attempts] */
export type ElevatedStep = [string, string, string[], number];

/** Runs `steps` in order under one UAC prompt. Returns each step's last exit code by name (missing if elevation was declined). */
export async function runElevated(steps: ElevatedStep[]): Promise<Map<string, string>> {
    const resultsFile = join(TMP, "elevated.txt"),
        scriptFile = join(TMP, "elevated.ps1"),
        succeeded = [0, REBOOT_REQUIRED, ALREADY_INSTALLED].join(",");

    writeFileSync(
        scriptFile,
        [
            `$results = ${psq(resultsFile)}`,
            // A step whose process fails to start leaves $p null: record -1 instead of an empty (= success) code.
            ...steps.map(
                ([name, file, args, attempts]) =>
                    `$p = $null; for ($i = 0; $i -lt ${attempts}; $i++) { $p = Start-Process -FilePath ${psq(file)} -ArgumentList @(${args
                        .map(psq)
                        .join(
                            ",",
                        )}) -Wait -PassThru -WindowStyle Hidden; if (@(${succeeded}) -contains $p.ExitCode) { break }; Start-Sleep 5 }; Add-Content $results "${name}=$(if ($p) { $p.ExitCode } else { -1 })"`,
            ),
        ].join("\r\n"),
    );
    rmSync(resultsFile, { force: true });

    await run(PWSH, [
        "-NoProfile",
        "-Command",
        `Start-Process ${psq(PWSH)} -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psq(
            scriptFile,
        )}`,
    ]);

    return new Map(
        (existsSync(resultsFile) ? readFileSync(resultsFile, "utf8") : "")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => line.split("=") as [string, string]),
    );
}

async function elevatedJobs(report: Report) {
    const installer = join(TMP, "vs_BuildTools.exe"),
        vswhere = join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft Visual Studio", "Installer", "vswhere.exe");

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
        await download("https://aka.ms/vs/stable/vs_BuildTools.exe", installer);

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
                    await run(PWSH, ["-NoProfile", "-Command", `(Get-Item ${psq(installer)}).VersionInfo.FileVersion`])
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

        if (!wslInstalled) {
            steps.push(["wsl", "wsl.exe", ["--install", "--no-distribution"], 1]);
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
                console.log(`${name}: reboot required to finish`);
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

// ---------------------------------------------------------------------------------------------
// MSYS2: only the toolchains meant to be used inside MSYS2 environments
// ---------------------------------------------------------------------------------------------

async function installMsys2(): Promise<Outcome> {
    const bash = join(MSYS2, "usr", "bin", "bash.exe"),
        shell = (command: string) => run(bash, ["-lc", command], { env: { CHERE_INVOKING: "1", MSYSTEM: "MSYS" } });

    let outcome: Outcome = "current";

    if (!existsSync(bash)) {
        const sfx = join(TMP, "msys2.sfx.exe");
        await download(
            "https://github.com/msys2/msys2-installer/releases/latest/download/msys2-base-x86_64-latest.sfx.exe",
            sfx,
        );
        await run(sfx, ["-y", "-oC:\\"]);
        await shell("exit"); // first run initialises the keyring and /etc
        outcome = "installed";
    }

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

    const packages = [
        ...MSYS2_BASE_PACKAGES,
        ...["mingw-w64-ucrt-x86_64-", "mingw-w64-clang-x86_64-"].flatMap((prefix) =>
            MSYS2_MINGW_PACKAGES.map((p) => `${prefix}${p}`),
        ),
    ];
    await pacman(`--needed -S ${packages.join(" ")}`);

    return outcome;
}

// ---------------------------------------------------------------------------------------------
// Rust, cargo tools, uv tools, Claude Code
// ---------------------------------------------------------------------------------------------

async function installRustup(): Promise<Outcome> {
    if (existsSync(join(CARGO_BIN, "rustup.exe"))) {
        await run("rustup", ["self", "update"]);
    } else {
        const initializer = join(TMP, "rustup-init.exe");
        await download("https://win.rustup.rs/x86_64", initializer);
        await run(initializer, ["-y", "--default-toolchain", "none", "--profile", "minimal"]);
    }

    await installRustToolchains([
        "stable",
        "nightly",
        "stable-x86_64-pc-windows-gnullvm",
        "nightly-x86_64-pc-windows-gnullvm",
    ]);
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

    await run(PWSH, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm https://claude.ai/install.ps1 | iex",
    ]);
    return "installed";
}

// ---------------------------------------------------------------------------------------------

export async function installWindows(report: Report) {
    mkdirSync(BIN, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    process.env.PATH = [BIN, CARGO_BIN, process.env.PATH].join(";");

    // Everything below that shells out to PowerShell needs pwsh, so it goes first.
    await report.step("pwsh", () => installArchive(PWSH_ARCHIVE));

    const elevated = elevatedJobs(report);

    await Promise.all([
        elevated,
        pool(ARCHIVES, 4, (archive) => report.step(archive.name, () => installArchive(archive))),
        report.step("msys2", installMsys2),
        report.step("claude", installClaude),
        (async () => {
            await report.step("rustup", installRustup);
            await report.step("cargo-binstall", installBinstall);
            await elevated; // compiling fallbacks need the MSVC linker
            await cargoTools(report);
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

    // The bootstrap script puts Deno in place before this script ever runs.
    if (existsSync(join(ROOT, "deno", "deno.exe"))) {
        link({ bin: ".", name: "deno" });
    }

    await report.step("configs", copyConfigs);
    await report.step("context menus", registerContextMenus);
    await report.step("7-zip context menu", register7zipMenu);

    await report.step("user PATH", async () => {
        await persistPath([BIN, ...pathDirs]);
    });

    rmSync(TMP, { force: true, recursive: true });
}
