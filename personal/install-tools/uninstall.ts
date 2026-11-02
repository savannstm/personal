// Removing programs through their own registered uninstallers (the "Apps & features" entries).
import { rmSync } from "node:fs";
import { dirname } from "node:path";

import { POWERSHELL, ROOT } from "./toolchain.ts";
import { run } from "./util.ts";
import type { ElevatedStep } from "./windows.ts";

export interface UninstallEntry {
    command: string | null;
    icon: string | null;
    key: string;
    location: string | null;
    msi: boolean;
    name: string;
    quiet: string | null;
    /** Registered under HKCU: removable without elevation. */
    user: boolean;
}

const ENTRIES_SCRIPT = `
$roots = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$entries = @(Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object {
    [pscustomobject]@{
        command = $_.UninstallString; icon = $_.DisplayIcon; key = $_.PSChildName; location = $_.InstallLocation
        msi = [bool]$_.WindowsInstaller; name = $_.DisplayName; quiet = $_.QuietUninstallString
        user = $_.PSPath -like '*HKEY_CURRENT_USER*'
    }
})
ConvertTo-Json -InputObject $entries -Compress
`;

export async function uninstallEntries(): Promise<UninstallEntry[]> {
    const json = (await run(POWERSHELL, ["-NoProfile", "-Command", ENTRIES_SCRIPT])).trim();
    return json ? (JSON.parse(json) as UninstallEntry[]) : [];
}

export function isUnderRoot(entry: UninstallEntry): boolean {
    const root = `${ROOT.toLowerCase()}\\`;
    return [entry.location, entry.icon, entry.command, entry.quiet].some((value) =>
        value?.toLowerCase().includes(root),
    );
}

const GUID = /\{[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}\}/i;

function split(command: string): [string, string[]] {
    const match = /^\s*(?:"([^"]+)"|(\S+?\.exe))\s*(.*)$/i.exec(command);
    if (!match) {
        throw new Error(`cannot parse uninstall command: ${command}`);
    }
    const args = (match[3]!.match(/"[^"]*"|\S+/g) ?? []).map((arg) => arg.replace(/^"|"$/g, ""));
    return [match[1] ?? match[2]!, args];
}

/** The silent uninstall command for an entry, plus the directory its uninstaller leaves behind (NSIS). */
export function removalCommand(entry: UninstallEntry): { args: string[]; file: string; leftover?: string } {
    const command = entry.command ?? "";
    if (entry.msi || /msiexec/i.test(command)) {
        return { args: ["/x", GUID.exec(command)?.[0] ?? entry.key, "/qn", "/norestart"], file: "msiexec.exe" };
    }
    if (entry.quiet) {
        const [file, args] = split(entry.quiet);
        return { args, file };
    }

    const [file, args] = split(command);
    if (/unins\d*\.exe$/i.test(file)) {
        return { args: [...args, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], file }; // Inno Setup
    }
    if (/update\.exe$/i.test(file)) {
        return { args: [...args, "-s"], file }; // Squirrel (Discord)
    }
    // NSIS: `_?=` keeps the uninstaller in its own process, so the step waits for it (and leaves its directory behind).
    return { args: [...args, "/S", `_?=${dirname(file)}`], file, leftover: dirname(file) };
}

const OK = new Set(["0", "1605", "1638", "3010"]); // 1605: not installed (already gone)

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Uninstalls `entries`: per-machine ones under one UAC prompt (`runElevated`), per-user ones directly. Uninstallers that
 * return before they finish are waited for by watching the registry, then the directories they leave behind are deleted.
 * With `purgeLocations` the entries' install locations are deleted too (only for programs that own their directory).
 * Returns what failed.
 */
export async function removePrograms(
    entries: UninstallEntry[],
    runElevated: (steps: ElevatedStep[]) => Promise<Map<string, string>>,
    purgeLocations = false,
): Promise<string[]> {
    const plans = entries.map((entry, index) => ({ ...removalCommand(entry), entry, id: `${index}|${entry.name}` })),
        failures: string[] = [];

    const machine = plans.filter(({ entry }) => !entry.user);
    if (machine.length > 0) {
        const codes = await runElevated(machine.map(({ args, file, id }): ElevatedStep => [id, file, args, 1]));
        for (const { entry, id } of machine) {
            const code = codes.get(id);
            if (code === undefined || !OK.has(code)) {
                failures.push(`${entry.name}: exit code ${code ?? "unknown (elevation declined?)"}`);
            }
        }
    }
    for (const { args, entry, file } of plans.filter(({ entry }) => entry.user)) {
        await run(file, args, { okCodes: [0, 3010] }).catch((error: unknown) => {
            failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    const remaining = (current: UninstallEntry[]) =>
        entries.filter((entry) =>
            current.some(({ key, name, user }) => key === entry.key && name === entry.name && user === entry.user),
        );
    for (let waited = 0; waited < 180_000 && remaining(await uninstallEntries()).length > 0; waited += 3000) {
        await sleep(3000);
    }

    for (const { entry, leftover } of plans) {
        // Never a bare "C:\Program Files" or drive: a program's own directory is at least two levels down.
        for (const dir of [leftover, purgeLocations ? entry.location : undefined]) {
            if (dir && dir.replace(/\\+$/, "").split("\\").length >= 3) {
                try {
                    rmSync(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 1000 });
                } catch (error) {
                    failures.push(`: could not delete  ()`);
                }
            }
        }
    }
    return failures;
}
