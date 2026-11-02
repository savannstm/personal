// `--clear`: removes everything install-tools installs on Windows, except user settings and configs.
// Registered programs go through their own uninstallers; everything else is deleted. Node and ROOT go last, after this
// process exits (Node may be the interpreter running this script).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { MSYS2, POWERSHELL, ROOT } from "./toolchain.ts";
import { isUnderRoot, removalCommand, removePrograms, uninstallEntries } from "./uninstall.ts";
import { log } from "./ui.ts";
import { type Report, run } from "./util.ts";
import {
    type ElevatedStep,
    MACHINE_ENV,
    MACHINE_ENV_KEY,
    psq,
    readUserPath,
    runElevated,
    SEVENZIP_CLASSES,
    SEVENZIP_KEYS,
} from "./windows.ts";

const HOME = homedir(),
    LOCAL = process.env.LOCALAPPDATA ?? join(HOME, "AppData", "Local"),
    APPDATA = process.env.APPDATA ?? join(HOME, "AppData", "Roaming"),
    PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    PROGRAM_DATA = process.env.ProgramData ?? "C:\\ProgramData",
    VS_INSTALLER = join(PROGRAM_FILES_X86, "Microsoft Visual Studio", "Installer"),
    CARGO = join(HOME, ".cargo"),
    PNPM_HOME = join(LOCAL, "pnpm"),
    CLAUDE_BIN = join(HOME, ".local", "bin", "claude.exe"),
    CLAUDE_DATA = join(HOME, ".local", "share", "claude");

// Programs that aren't under ROOT (Steam, Discord, runtimes).
const EXTRA_PROGRAMS = [
    /^Discord$/,
    /^Steam$/,
    // The .NET runtimes that install-tools installs (8, 9, 10), but never an SDK.
    /^Microsoft (?:\.NET|ASP\.NET Core|Windows Desktop Runtime)\b(?!.*SDK).*\b(?:8|9|10)\.0\.\d+/,
];
const NODE = /^Node\.js$/,
    VS_INSTALLER_ENTRY = /^(?:Microsoft )?Visual Studio Installer$/;

const reg = (args: string[]) => run("reg", args, { okCodes: [0, 1] });

async function vsInstances(): Promise<string[]> {
    const vswhere = join(VS_INSTALLER, "vswhere.exe");
    if (!existsSync(vswhere)) {
        return [];
    }
    return (
        await run(vswhere, [
            "-all",
            "-prerelease",
            "-products",
            "Microsoft.VisualStudio.Product.BuildTools",
            "-property",
            "installationPath",
        ])
    )
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

async function confirm(lines: string[], yes: boolean) {
    console.log(["This will remove:", ...lines.map((line) => `  - ${line}`), ""].join("\n"));
    if (yes) {
        return;
    }
    if (!process.stdin.isTTY) {
        throw new Error("--clear needs a terminal to confirm, or --yes.");
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout }),
        answer = await prompt.question("Type YES to continue: ");
    prompt.close();
    if (answer.trim() !== "YES") {
        throw new Error("Cancelled.");
    }
}

/** Removes the user PATH entries `drop` selects, then broadcasts the change like persistPath does. */
async function dropFromUserPath(drop: (entry: string) => boolean) {
    const entries = (await readUserPath()).split(";").filter(Boolean),
        kept = entries.filter((entry) => !drop(entry));
    if (kept.length === entries.length) {
        return;
    }
    await run("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", kept.join(";"), "/f"]);
    await run(POWERSHELL, [
        "-NoProfile",
        "-Command",
        "[Environment]::SetEnvironmentVariable('DEV_TOOLS_BROADCAST','1','User');[Environment]::SetEnvironmentVariable('DEV_TOOLS_BROADCAST',$null,'User')",
    ]);
}

async function elevated(steps: ElevatedStep[]) {
    if (steps.length === 0) {
        return;
    }
    const codes = await runElevated(steps),
        failed = steps.filter(([name]) => !["0", "1605", "3010"].includes(codes.get(name) ?? ""));
    if (failed.length > 0) {
        throw new Error(
            failed
                .map(([name]) => `${name} (exit code ${codes.get(name) ?? "unknown, elevation declined?"})`)
                .join("; "),
        );
    }
}

export async function clearWindows(report: Report, yes: boolean) {
    const entries = await uninstallEntries(),
        programs = entries.filter(
            (entry) =>
                !NODE.test(entry.name) &&
                (isUnderRoot(entry) || EXTRA_PROGRAMS.some((pattern) => pattern.test(entry.name))),
        ),
        node = entries.find((entry) => NODE.test(entry.name)),
        instances = await vsInstances();

    await confirm(
        [
            ...programs.map((entry) => `${entry.name} (uninstaller)`),
            ...instances.map(
                (path) => `Visual Studio Build Tools at ${path} (uninstaller), then the Visual Studio Installer`,
            ),
            ...(node ? ["Node.js (uninstaller, after this script exits)"] : []),
            "Rust (rustup self uninstall; ~/.cargo/config.toml is kept), uv tools/Pythons/cache, pnpm, Claude Code",
            `${ROOT} and its user PATH entries, Explorer menu entries, the Inconsolata Nerd Font, machine environment variables`,
            `${MSYS2} (everything but its home directory)`,
            "(Steam's games are inside its install directory and go with it.)",
        ],
        yes,
    );

    await report.step("uninstall programs", async () => {
        const failures = await removePrograms(programs, runElevated, true);
        if (failures.length > 0) {
            throw new Error(failures.join("; "));
        }
    });

    await report.step("visual studio", async () => {
        const setup = join(VS_INSTALLER, "setup.exe");
        await elevated(
            instances.map((path, index): ElevatedStep => [
                `vs-${index}`,
                setup,
                ["uninstall", "--installPath", `"${path}"`, "--quiet", "--norestart"],
                1,
            ]),
        );
        if ((await vsInstances()).length > 0) {
            throw new Error("a Build Tools instance is still installed");
        }
        // With no instance left, the shared installer and its package cache go too.
        const installer = (await uninstallEntries()).filter((entry) => VS_INSTALLER_ENTRY.test(entry.name));
        const failures = await removePrograms(installer, runElevated, false);
        await elevated(
            [
                join(PROGRAM_FILES_X86, "Microsoft Visual Studio"),
                join(PROGRAM_DATA, "Microsoft", "VisualStudio", "Packages"),
            ]
                .filter(existsSync)
                .map((dir): ElevatedStep => [`rmdir:${dir}`, "cmd.exe", ["/c", "rmdir", "/s", "/q", dir], 1]),
        );
        if (failures.length > 0) {
            throw new Error(failures.join("; "));
        }
    });

    await report.step("machine settings", async () => {
        const present = async (key: string) => (await reg(["query", MACHINE_ENV_KEY, "/v", key])).includes(key);
        const steps: ElevatedStep[] = [];
        for (const [key] of MACHINE_ENV) {
            if (await present(key)) {
                steps.push([`env:${key}`, "reg.exe", ["delete", MACHINE_ENV_KEY, "/v", key, "/f"], 1]);
            }
        }
        for (const key of SEVENZIP_KEYS) {
            steps.push([`7zip:${key}`, "reg.exe", ["delete", `${SEVENZIP_CLASSES}\\${key}`, "/f"], 1]);
        }
        // reg delete exits 1 for a key that isn't there: that is the state we want.
        const codes = await runElevated(steps);
        if (steps.some(([name]) => codes.get(name) === undefined)) {
            throw new Error("elevation declined?");
        }
    });

    await report.step("user settings & registry", async () => {
        const rootPrefix = `${ROOT.toLowerCase()}\\`,
            userBins = [join(CARGO, "bin"), join(HOME, ".local", "bin"), PNPM_HOME].map((dir) => dir.toLowerCase());
        await dropFromUserPath((entry) => {
            const lower = entry.toLowerCase().replace(/\\+$/, "");
            return `${lower}\\`.startsWith(rootPrefix) || userBins.includes(lower);
        });
        for (const name of ["UV_TOOL_BIN_DIR", "PNPM_HOME"]) {
            await reg(["delete", "HKCU\\Environment", "/v", name, "/f"]);
        }

        for (const key of ["*", "Directory", "Directory\\Background", "Drive"]) {
            await reg(["delete", `HKCU\\Software\\Classes\\${key}\\shell\\VSCode`, "/f"]);
        }
        for (const key of ["Directory", "Directory\\Background", "Drive"]) {
            await reg(["delete", `HKCU\\Software\\Classes\\${key}\\shell\\pwsh7`, "/f"]);
        }
        rmSync(join(APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Visual Studio Code.lnk"), {
            force: true,
        });

        const fontsKey = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
        for (const [, name, file] of (await reg(["query", fontsKey])).matchAll(
            /^\s+(Inconsolata\S*NerdFont.*?)\s+REG_SZ\s+(.+?)\s*$/gim,
        )) {
            await reg(["delete", fontsKey, "/v", name!, "/f"]);
            rmSync(file!, { force: true });
        }

        rmSync(PNPM_HOME, { force: true, recursive: true });
        rmSync(CLAUDE_BIN, { force: true });
        rmSync(CLAUDE_DATA, { force: true, recursive: true });
    });

    // These need ROOT (uv) or ~/.cargo (rustup) to still be there.
    await report.step("uv tools, pythons & cache", async () => {
        const uv = join(ROOT, "uv", "uv.exe");
        if (existsSync(uv)) {
            await run(uv, ["tool", "uninstall", "--all"]);
            await run(uv, ["python", "uninstall", "--all"]);
            await run(uv, ["cache", "clean"]);
        }
    });

    await report.step("rust", async () => {
        // rustup removes all of ~/.cargo, including the config that configs/ provides: put it back afterwards.
        const config = join(CARGO, "config.toml"),
            saved = existsSync(config) ? readFileSync(config) : undefined;
        const rustup = join(CARGO, "bin", "rustup.exe");
        if (existsSync(rustup)) {
            await run(rustup, ["self", "uninstall", "-y"]);
        }
        if (saved) {
            mkdirSync(CARGO, { recursive: true });
            writeFileSync(config, saved);
        }
    });

    // MSYS2 has no uninstaller. Its home directory is user data.
    await report.step("msys2", () => {
        if (!existsSync(MSYS2)) {
            return "current";
        }
        for (const entry of readdirSync(MSYS2).filter((name) => name !== "home")) {
            rmSync(join(MSYS2, entry), { force: true, maxRetries: 5, recursive: true, retryDelay: 1000 });
        }
    });

    // Node may be running this very script, and ROOT holds its files: both go once this process has exited.
    await report.step("node & install root", async () => {
        const lines = [`Wait-Process -Id ${process.pid} -ErrorAction Ignore`];
        if (node) {
            const { args, file } = removalCommand(node);
            lines.push(`Start-Process ${psq(file)} -ArgumentList ${args.map(psq).join(",")} -Verb RunAs -Wait`);
        }
        lines.push(`Remove-Item -LiteralPath ${psq(ROOT)} -Recurse -Force -ErrorAction Ignore`);
        spawn(POWERSHELL, ["-NoProfile", "-WindowStyle", "Hidden", "-Command", lines.join("; ")], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        }).unref();
        log(`! Node and ${ROOT} are removed after this script exits${node ? " (one more UAC prompt)" : ""}.`);
    });

    log(
        "! Left alone: WSL and the .NET Framework features, the VC++/DirectX runtimes (shared with other software), " +
            "the Windows SDK, and your user data.",
    );
}
