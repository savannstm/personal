import { $ } from "dax";
import { readdirSync } from "node:fs";

import { VSWHERE } from "./settings.ts";

export function latestVersionDir(dir: string): string {
    const versions = readdirSync(dir);
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const latest = versions.at(-1);
    if (!latest) {
        throw new Error(`Nothing found under ${dir}`);
    }
    return latest;
}

export async function msvcToolsRoot(): Promise<string> {
    const vsRoot = (
        await $`${VSWHERE} -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`.text()
    ).trim();
    if (!vsRoot) {
        throw new Error("vswhere: no VS installation with VC.Tools found");
    }
    const toolsDir = `${vsRoot}/VC/Tools/MSVC`;
    return `${toolsDir}/${latestVersionDir(toolsDir)}`;
}
