// Runs the test suites one after another against the installed CI artifacts. Usage: node run.ts [suite...]
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

import { fromHere } from "./common.ts";

// ruby-bench is last: it wants an idle machine.
const SUITES = ["smoke", "compiler", "rust", "allocator", "jumps", "libs", "cmake", "ruby-bench"];

const wanted = process.argv.slice(2),
    unknown = wanted.filter((suite) => !SUITES.includes(suite));
if (unknown.length > 0) {
    throw new Error(`Unknown suite(s) ${unknown.join(", ")}. Suites: ${SUITES.join(", ")}.`);
}

const failed = SUITES.filter((suite) => wanted.length === 0 || wanted.includes(suite)).filter((suite) => {
    console.log(`\n######## ${suite}`);
    return spawnSync(process.execPath, [fromHere(`${suite}.ts`)], { stdio: "inherit" }).status !== 0;
});
console.log(failed.length > 0 ? `\nSuites with failures: ${failed.join(", ")}` : "\nAll suites passed.");
process.exitCode = failed.length > 0 ? 1 : 0;
