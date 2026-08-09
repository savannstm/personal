import { $ } from "dax";

import { WIN } from "./config.ts";

export const raw = (text: string) => $.rawArg(text);

function toMsysList(envVar: string): string {
    return (process.env[envVar] ?? "").split(";").map(toMsysPath).join(":");
}

export function toMsysPath(path: string) {
    if (!WIN) {
        return path;
    }
    const p = path.replaceAll("\\", "/"),
        m = /^([A-Za-z]):(.*)$/.exec(p);
    return m ? `/${m[1]!.toLowerCase()}${m[2]}` : p;
}

export function bash(strings: TemplateStringsArray, ...values: any[]) {
    if (!WIN) {
        return $(strings, ...values);
    }

    const innerCommand = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");

    const includeLibExports = `export INCLUDE="${toMsysList("INCLUDE")}" && export LIB="${toMsysList("LIB")}"`;
    const pkgConfigExport = `export PKG_CONFIG_PATH="${toMsysList("PKG_CONFIG_PATH")}:$PKG_CONFIG_PATH"`;
    const msvcExports = `${includeLibExports} && ${pkgConfigExport}`;

    return $`MSYS2_PATH_TYPE=inherit C:/msys64/usr/bin/bash.exe -lc ${`${msvcExports} && ${innerCommand}`}`;
}
