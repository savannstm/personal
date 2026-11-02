// Installs/updates the dev toolchain and the personal GUI tools in one go.
// Usage: node personal/install-tools/index.ts [--toolchain=clang|msvc]   (Windows; Linux takes no argument)
//        node personal/install-tools/index.ts --clear [--yes]            (Windows only)
//        (Windows: powershell bootstrap.ps1 installs Node first if missing, and forwards the arguments)
// --toolchain=clang installs the C/C++ dev tools from MSYS2's CLANG64 (and the gnullvm Rust toolchains), no VS Build Tools;
// --toolchain=msvc leaves MSYS2/CLANG64 alone and installs them from GitHub and the like, plus VS Build Tools.
// Without --toolchain both are installed. Personal GUI tools (Alacritty, qBittorrent, ...) never go through MSYS2.
// Everything installs under C:\PATH where the program allows it, except MSYS2, Steam, VS Build Tools and .NET. --clear removes it all again (asks first, or pass --yes);
// user settings and the configs this repo provides are kept.
// dev/set-env.ts sets up the environment.
import process from "node:process";
import { parseArgs } from "node:util";

import { clearWindows } from "./clear.ts";
import { installLinux } from "./linux.ts";
import { PERSONAL_WINDOWS } from "./personal.ts";
import type { Toolchain } from "./toolchain.ts";
import { Report } from "./util.ts";
import { installWindows } from "./windows.ts";

const { values } = parseArgs({
    options: { clear: { type: "boolean" }, toolchain: { type: "string" }, yes: { type: "boolean" } },
});
const report = new Report();

if (values.clear) {
    if (process.platform !== "win32" || values.toolchain !== undefined) {
        throw new Error("--clear takes no --toolchain and only applies to Windows.");
    }
    await clearWindows(report, values.yes === true);
} else if (process.platform === "win32") {
    if (values.toolchain !== undefined && values.toolchain !== "clang" && values.toolchain !== "msvc") {
        throw new Error(`Invalid --toolchain "${values.toolchain}": expected clang or msvc.`);
    }
    await installWindows(
        report,
        PERSONAL_WINDOWS,
        values.toolchain ? [values.toolchain as Toolchain] : ["clang", "msvc"],
    );
} else {
    if (values.toolchain !== undefined) {
        throw new Error("--toolchain only applies to Windows.");
    }
    await installLinux(report);
}

report.print();
