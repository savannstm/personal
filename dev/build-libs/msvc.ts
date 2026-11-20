// Locating the Visual Studio MSVC tools, for the msvc toolchain's environment and for the MASM assembler clang lacks.

import { $ } from "dax";
import { readdir } from "node:fs/promises";

import { compareVersions } from "./check-updates.ts";
import { VSWHERE } from "./settings.ts";

export async function latestVersionDir(dir: string): Promise<string> {
    const versions = await readdir(dir);
    versions.sort(compareVersions);
    const latest = versions.at(-1);
    if (!latest) {
        throw new Error(`Nothing found under ${dir}`);
    }
    return latest;
}

/** The newest MSVC tools directory, e.g. `<VS>/VC/Tools/MSVC/14.44.35207`. */
export async function msvcToolsRoot(): Promise<string> {
    const vsRoot = (
        await $`${VSWHERE} -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`.text()
    ).trim();
    if (!vsRoot) {
        throw new Error("vswhere: no VS installation with VC.Tools found");
    }
    const toolsDir = `${vsRoot}/VC/Tools/MSVC`;
    return `${toolsDir}/${await latestVersionDir(toolsDir)}`;
}
