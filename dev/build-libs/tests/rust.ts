// rustc with the installed clang/lld: Rust, C, C++ and CMake dependencies, a proc macro, the repo's cargo profiles
// (configs/config.toml, expected in ~/.cargo), cross-language LTO, and C calling into Rust libraries.
// shortcut: cc and cmake come from crates.io, so the first run needs network access.
import { execSync } from "node:child_process";
import console from "node:console";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import { LLVM, setup } from "./common.ts";

const WORK = setup("rust"),
    TARGET = "--target x86_64-pc-windows-gnullvm";
Object.assign(process.env, {
    CARGO_BUILD_BUILD_DIR: `${WORK}/build`,
    CARGO_TARGET_DIR: `${WORK}/target`,
    RUSTUP_TOOLCHAIN: "nightly-x86_64-pc-windows-gnullvm",
});

const member = (name: string, rest = "") => `[package]\nname="${name}"\nversion="0.1.0"\nedition="2024"\n${rest}`;

const FILES: Record<string, string> = {
    "Cargo.toml": '[workspace]\nmembers = ["app", "lib", "dy", "pm"]\nresolver = "3"\n',
    "pm/Cargo.toml": member("pm", "[lib]\nproc-macro = true\n"),
    "pm/src/lib.rs": `use proc_macro::TokenStream;
#[proc_macro]
pub fn answer(_: TokenStream) -> TokenStream { "42".parse().unwrap() }
`,
    "dy/Cargo.toml": member("dy", '[lib]\ncrate-type = ["cdylib", "staticlib"]\n'),
    "dy/src/lib.rs": `#[unsafe(no_mangle)]
pub extern "C" fn rs_add(a: i32, b: i32) -> i32 { a + b }
`,
    "lib/Cargo.toml": member("lib"),
    "lib/src/lib.rs": "pub fn two() -> i32 { 2 }\n",
    "app/Cargo.toml": member(
        "app",
        '[dependencies]\npm = { path = "../pm" }\nlib = { path = "../lib" }\n[build-dependencies]\ncc = "1"\ncmake = "0.1"\n',
    ),
    "app/c/c.c": `#include <stdio.h>
#include <zlib.h>
int c_zlib(void) { return zlibVersion()[0] - '0'; }
`,
    "app/c/cpp.cpp": `#include <string>
#include <stdexcept>
extern "C" int cpp_len() { try { throw std::runtime_error(std::string("abc")); } catch (const std::exception &e) { return (int)std::string(e.what()).size(); } }
`,
    "app/cm/CMakeLists.txt": `cmake_minimum_required(VERSION 3.20)
project(cm C CXX)
add_library(cm STATIC cm.cpp)
install(TARGETS cm ARCHIVE DESTINATION lib)
`,
    "app/cm/cm.cpp": 'extern "C" int cm_seven() { return 7; }\n',
    "app/build.rs": `fn main() {
    cc::Build::new().file("c/c.c").compile("cc_c");
    cc::Build::new().cpp(true).std("c++23").file("c/cpp.cpp").compile("cc_cpp");
    let out = cmake::build("cm");
    println!("cargo:rustc-link-search=native={}/lib", out.display());
    println!("cargo:rustc-link-lib=static=cm");
    println!("cargo:rustc-link-lib=static=z");
}
`,
    "app/src/main.rs": `unsafe extern "C" { fn c_zlib() -> i32; fn cpp_len() -> i32; fn cm_seven() -> i32; }
fn main() {
    let unwound = std::panic::catch_unwind(|| 1).is_ok();
    let h = std::thread::spawn(|| lib::two()).join().unwrap();
    let (z, c, m) = unsafe { (c_zlib(), cpp_len(), cm_seven()) };
    assert_eq!((pm::answer!(), h, c, m, unwound), (42, 2, 3, 7, true));
    assert!(z >= 1);
    println!("rust ok");
}
#[cfg(test)]
mod tests { #[test] fn t() { assert_eq!(lib::two(), 2); } }
`,
    "m.c": "int rs_add(int, int);\nint main(void) { return rs_add(2, 3) != 5; }\n",
    "direct.rs": 'fn main() { println!("rustc direct ok") }\n',
};

for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(dirname(`${WORK}/${name}`), { recursive: true });
    writeFileSync(`${WORK}/${name}`, text);
}

let passed = 0,
    total = 0;
function check(name: string, command: string, env: Record<string, string> = {}): string {
    total++;
    try {
        const out = execSync(command, {
            cwd: WORK,
            encoding: "utf8",
            env: { ...process.env, ...env },
            stdio: "pipe",
            timeout: 900_000,
        });
        passed++;
        console.log(`  ok ${name}`);
        return out;
    } catch (error) {
        const { stderr = "", stdout = "" } = error as { stderr?: string; stdout?: string },
            lines = `${stdout}${stderr}`.split("\n");
        console.log(
            `FAIL ${name}\n  $ ${command}\n${lines
                .filter((line) => /error|ld:|lld:/i.test(line))
                .slice(0, 20)
                .join("\n")}`,
        );
        return "";
    }
}

for (const profile of ["dev", "win-clang-debug", "win-clang-release", "release"]) {
    check(`${profile}: app`, `cargo run --profile ${profile} ${TARGET} -p app`);
    check(`${profile}: cdylib + staticlib`, `cargo build --profile ${profile} ${TARGET} -p dy`);
}
check("cargo test", `cargo test ${TARGET} -p app`);
check("no --target", "cargo run -p app");
check("cross-language LTO", `cargo run --profile win-clang-release ${TARGET} -p app`, {
    AR: "llvm-ar",
    CFLAGS: "-flto",
    CXXFLAGS: "-flto",
});

const out = `${WORK}/target/x86_64-pc-windows-gnullvm/win-clang-release`.replaceAll("/", "\\");
check("C -> cdylib", `copy ${out}\\dy.dll . && clang m.c ${out}\\libdy.dll.a -o dyn.exe && .\\dyn.exe`);
const native = check(
    "native-static-libs",
    `cargo rustc --profile win-clang-release ${TARGET} -p dy --crate-type staticlib -- --print native-static-libs 2>&1`,
);
const libs = /native-static-libs: (.*)/.exec(native)?.[1]?.trim() ?? "-lkernel32 -lntdll -luserenv -lws2_32 -ldbghelp";
check("C -> staticlib", `clang m.c ${out}\\libdy.a ${libs} -o st.exe && .\\st.exe`);
check("rustc directly", "rustc -Clinker=clang direct.rs -o direct.exe && .\\direct.exe");
check("MSVC target with our lld-link", `rustc -Clinker=${LLVM}/bin/lld-link.exe direct.rs -o msvc.exe && .\\msvc.exe`, {
    RUSTUP_TOOLCHAIN: "nightly-x86_64-pc-windows-msvc",
});

console.log(`\nrust: ${passed}/${total} passed`);
process.exitCode = passed === total ? 0 : 1;
