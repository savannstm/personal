import process from "node:process";

import { installLinux } from "./linux.ts";
import { Report } from "./util.ts";
import { installWindows } from "./windows.ts";

const report = new Report();

await (process.platform === "win32" ? installWindows(report) : installLinux(report));

report.print();
