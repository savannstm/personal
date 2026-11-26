// Every installed artifact starts: the compiler, each Ruby (including a raise round trip) and the cargo tools.
import { spawnSync } from "node:child_process";
import console from "node:console";
import { readdirSync } from "node:fs";
import process from "node:process";

import { LLVM, PREFIX, setup } from "./common.ts";

setup("smoke");

// Portable down to Ruby 1.8.1.
const RAISE = `n = 0; 10_000.times { |i| catch(:out) { begin; raise ArgumentError if i % 2 == 1; throw :out; rescue ArgumentError; ensure; n += 1; end } }; abort "raise" unless n == 10_000; puts "ruby #{RUBY_VERSION}"`,
    // 3.x and later build every default extension.
    EXTENSIONS = `if RUBY_VERSION >= "3"; %w[openssl psych zlib socket json fiddle].each { |lib| require lib }; end;`;

const checks: [name: string, exe: string, args: string[]][] = [
    ...["clang", "clang++", "ld.lld", "lld-link", "clangd", "clang-tidy", "lldb", "llvm-ar"].map(
        (tool): [string, string, string[]] => [tool, `${LLVM}/bin/${tool}.exe`, ["--version"]],
    ),
    ...readdirSync(`${PREFIX}/release`)
        .filter((dir) => dir.startsWith("ruby-"))
        .map((dir): [string, string, string[]] => [
            dir,
            `${PREFIX}/release/${dir}/bin/ruby.exe`,
            ["-e", `${EXTENSIONS} ${RAISE}`],
        ]),
    ...["rg", "sd", "fd", "sccache", "tokei"].map((tool): [string, string, string[]] => [
        tool,
        `C:/PATH/bin/${tool}.exe`,
        ["--version"],
    ]),
];

let passed = 0;
for (const [name, exe, args] of checks) {
    const { status, stdout, stderr, error } = spawnSync(exe, args, { encoding: "utf8", timeout: 60_000 });
    if (status === 0) {
        passed++;
        console.log(`  ok ${name}: ${stdout.split("\n")[0]}`);
    } else {
        console.log(`FAIL ${name}: exit ${status} ${error?.message ?? stderr.slice(0, 600)}`);
    }
}
console.log(`\nsmoke: ${passed}/${checks.length} passed`);
process.exitCode = passed === checks.length ? 0 : 1;
