// Alternates each CI-built Ruby and the installed one of the same minor version (C:/PATH/ruby*, RubyInstaller); skips Rubies
// with no such counterpart. Reports the best and the median of ROUNDS runs per workload. Run on an idle machine.
// Usage: node ruby-bench.ts [rounds] [version-regex] [script: ruby-bench.rb | ruby-micro.rb]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { setPriority } from "node:os";
import process from "node:process";

import { fromHere, PREFIX, setup } from "./common.ts";

const ROUNDS = Number(process.argv[2] ?? 7),
    SCRIPT = fromHere(process.argv[4] ?? "ruby-bench.rb"),
    WORK = setup("ruby-bench");

const minor = (root: string) =>
    // No --disable-gems: 1.8 rejects it.
    execFileSync(`${root}/bin/ruby.exe`, ["-e", "print RUBY_VERSION[/\\d+\\.\\d+/]"], {
        encoding: "utf8",
    });
const installed = new Map(
    readdirSync("C:/PATH")
        .filter((dir) => /^ruby(-|$)/.test(dir) && existsSync(`C:/PATH/${dir}/bin/ruby.exe`))
        .map((dir) => [minor(`C:/PATH/${dir}`), dir]),
);
const PAIRS = readdirSync(`${PREFIX}/release`)
    .filter((dir) => dir.startsWith("ruby-"))
    .flatMap((dir): [string, string][] => {
        const match = installed.get(minor(`${PREFIX}/release/${dir}`));
        return match ? [[dir.slice(5), match]] : [];
    });

setPriority(-14); // children inherit high priority

// Only the interpreter's own bin on PATH: other Rubies' and CLANG64's DLLs must not be picked up.
const run = (root: string, args: string[]) =>
    execFileSync(`${root}/bin/ruby.exe`, args, {
        cwd: WORK,
        encoding: "utf8",
        env: { SystemRoot: "C:\\Windows", TEMP: WORK, TMP: WORK, PATH: `${root}/bin;C:/Windows/System32;C:/Windows` },
    });

const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!;

function startup(root: string, flags: string[]): number {
    const start = performance.now();
    for (let i = 0; i < 20; i++) run(root, [...flags, "-e", "1"]);
    return (performance.now() - start) / 20 / 1000;
}

for (const [ci, other] of PAIRS.filter(([v]) => new RegExp(process.argv[3] ?? ".").test(v))) {
    const roots = { ci: `${PREFIX}/release/ruby-${ci}`, ri: `C:/PATH/${other}` },
        times = { ci: new Map<string, number[]>(), ri: new Map<string, number[]>() };
    for (const key of ["ci", "ri"] as const) {
        console.log(
            key,
            run(roots[key], [
                "-rrbconfig",
                "-e",
                'puts RUBY_DESCRIPTION; puts "  CC=#{RbConfig::CONFIG["CC_VERSION_MESSAGE"].to_s.lines.first}"; puts "  CFLAGS=#{RbConfig::CONFIG["CFLAGS"]}"; puts "  VM=#{RubyVM::OPTS.join(", ")}"',
            ]).trimEnd(),
        );
    }
    for (let round = 0; round < ROUNDS; round++) {
        for (const key of round % 2 ? (["ri", "ci"] as const) : (["ci", "ri"] as const)) {
            const results = run(roots[key], [SCRIPT])
                .trim()
                .split(/\r?\n/)
                .map((line) => line.split(" "));
            if (SCRIPT.endsWith("ruby-bench.rb")) {
                results.push(["startup", String(startup(roots[key], []))]);
                results.push(["startup_no_gems", String(startup(roots[key], ["--disable-gems"]))]);
            }
            for (const [name, seconds] of results) {
                const list = times[key].get(name!) ?? [];
                list.push(Number(seconds));
                times[key].set(name!, list);
            }
        }
    }
    console.log(`\n== ${ci} (CI) vs ${other} (installed), ${ROUNDS} rounds; ratio > 1: CI build slower`);
    console.log(
        "workload".padEnd(22),
        "CI best".padStart(8),
        "RI best".padStart(8),
        "best".padStart(6),
        "median".padStart(7),
    );
    let bestSum = 0,
        medianSum = 0,
        count = 0;
    for (const [name, mine] of times.ci) {
        const theirs = times.ri.get(name);
        if (!theirs) continue;
        // median() sorts in place: the best run is then first.
        const a = median(mine),
            b = median(theirs),
            best = mine[0]! / theirs[0]!;
        if (!name.startsWith("startup")) {
            bestSum += Math.log(best);
            medianSum += Math.log(a / b);
            count++;
        }
        console.log(
            name.padEnd(22),
            mine[0]!.toFixed(3).padStart(8),
            theirs[0]!.toFixed(3).padStart(8),
            best.toFixed(2).padStart(6),
            (a / b).toFixed(2).padStart(7),
        );
    }
    console.log(
        `geometric mean CI/RI over ${count} workloads (startup excluded): best ${Math.exp(bestSum / count).toFixed(3)}, median ${Math.exp(medianSum / count).toFixed(3)}\n`,
    );
}
