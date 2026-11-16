import $ from "dax";
import { cp, readdir, rm, writeFile } from "node:fs/promises";

import { buildDir, buildRoot, DEBUG_NATIVE, DEBUG_TOOLCHAIN, RELEASE_NATIVE, RELEASE_TOOLCHAIN, WIN } from "./settings.ts";
import { bash, raw, toMsysPath } from "./shell.ts";
import { computeFlags, toolchainState } from "./toolchain.ts";
import type { Ctx, Library, PlainArgs } from "./types.ts";

export function cmakeVal(on: boolean): string {
    return on ? "ON" : "OFF";
}

/** Moves *.pdb from `from` to `to`; copy+delete because the build dir may sit on another device, where rename fails. */
export async function movePdbs(from: string, to: string) {
    for (const file of (await readdir(from)).filter((f) => f.endsWith(".pdb"))) {
        await cp(`${from}/${file}`, `${to}/${file}`);
        await rm(`${from}/${file}`);
    }
}

export async function copyLib(root: string, from: string, to: string): Promise<void> {
    await $`cp ${`${root}/lib/${from}`} ${`${root}/lib/${to}`}`;
}

/** Static (release) builds: the installed header must not declare the symbols dllimport. */
export async function stripDllImport(file: string): Promise<void> {
    await $`sd -s -- "__declspec(dllimport)" "" ${file}`;
}

export async function buildCMake(library: Library, ctx: Ctx) {
    const { isDebug, path } = ctx,
        cwd = library.sourceSubdir ? `${path}/${library.sourceSubdir}` : path,
        dir = buildDir(isDebug),
        toolchainFile = isDebug ? DEBUG_TOOLCHAIN : RELEASE_TOOLCHAIN;
    await $`cmake -B ${dir} -S . -G Ninja --toolchain ${toolchainFile} --fresh -DBUILD_TOOLS=OFF -DBUILD_DOCS=OFF -DBUILD_DOC=OFF -DBUILD_EXAMPLE=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF -DBUILD_TESTS=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=${cmakeVal(isDebug)} ${raw(library.args?.(ctx) ?? "")}`.cwd(
        cwd,
    );
    if (library.cmakeTarget) {
        await $`cmake --build ${dir} -j --target ${library.cmakeTarget}`.cwd(cwd);
        return;
    }
    await $`cmake --build ${dir} -j`.cwd(cwd);
    await $`cmake --install ${dir}`.cwd(cwd);
}

export async function buildMeson(library: Library, ctx: Ctx) {
    const { isDebug, path } = ctx,
        dir = buildDir(isDebug),
        native = isDebug ? DEBUG_NATIVE : RELEASE_NATIVE,
        meson = library.mesonCommand ?? ["meson"];

    await $`${meson} setup ${dir} --native-file=${native} ${raw(library.args?.(ctx) ?? "")}`.cwd(path);
    await $`${meson} compile -C ${dir}`.cwd(path);
    await $`${meson} install -C ${dir}`.cwd(path);
}

let cargoC: Promise<unknown> | undefined;

// `cargo cinstall` comes from cargo-c, which a stock Rust install doesn't have.
// --target: the global cargo config enables build-std, which needs an explicit target even for `cargo install`.
function ensureCargoC() {
    const target = WIN
        ? toolchainState().toolchain === "msvc"
            ? "x86_64-pc-windows-msvc"
            : "x86_64-pc-windows-gnullvm"
        : "x86_64-unknown-linux-gnu";
    cargoC ??= $`cargo cinstall --help`
        .quiet()
        .noThrow()
        .then(({ code }) => code === 0 || $`cargo binstall --no-confirm --targets ${target} cargo-c`);
    return cargoC;
}

export async function buildRust(library: Library, ctx: Ctx) {
    await ensureCargoC();
    const { isDebug, path } = ctx,
        { toolchain } = toolchainState(),
        profile = `${WIN ? (toolchain === "msvc" ? "win-msvc" : "win-clang") : "linux"}-${isDebug ? "debug" : "release"}`,
        target = WIN
            ? ` --target ${toolchain === "msvc" ? "x86_64-pc-windows-msvc" : "x86_64-pc-windows-gnullvm"}`
            : "";
    await $`cargo cinstall ${raw(isDebug ? "--library-type=cdylib" : "--library-type=staticlib")} ${raw(`--profile ${profile}${target}`)} --no-default-features ${raw(library.args?.(ctx) ?? "")} --prefix=${buildRoot(isDebug)}`.cwd(
        path,
    );
}

interface AutoconfOptions {
    args?: string;
    // The configure script to run, with its arguments (ICU uses runConfigureICU).
    configure?: string;
    // Environment assignments for configure and make.
    env?: string;
    // Patches the generated libtool (and, for MSVC, configure's libtool parts); off for projects that don't use libtool.
    libtool?: boolean;
    // Passes the Windows system/runtime libraries as LIBS; off for projects that set their own.
    libs?: boolean;
    // Environment assignments for make only.
    makeEnv?: string;
}

export async function buildAutoconf(
    path: string,
    isDebug: boolean,
    prefix: string,
    { args = "", configure = "./configure", env = "", libs: passLibs = true, libtool = true, makeEnv = "" }: AutoconfOptions = {},
) {
    const msysPath = toMsysPath(path),
        { toolchain, tools } = toolchainState();
    const configurePath = `${path}/configure`;
    let libs = "";

    if (WIN) {
        libs = "-ladvapi32 -luser32";

        if (toolchain !== "msvc") {
            libs += ` -lclang_rt.builtins-x86_64 ${process.env.CFLAGS!.includes("-fsanitize=address") ? "-lclang_rt.asan_dynamic-x86_64 -lclang_rt.asan_dynamic_runtime_thunk-x86_64" : ""} -lole32 -lcfgmgr32`;
        }
    }

    const buildType = isDebug ? "--enable-shared --disable-static" : "--disable-shared --enable-static",
        libtoolFlags = libtool
            ? `--disable-dependency-tracking --with-gnu-ld ${WIN ? "--build=x86_64-w64-mingw32 --host=x86_64-w64-mingw32" : ""} lt_cv_deplibs_check_method="pass_all" lt_cv_prog_gnu_ld=yes`
            : "";

    if (libtool && toolchain === "msvc") {
        await $`sd -s -- ${"-Fe$tool_output_objdir$soname"} ${"-o $tool_output_objdir$soname"} ${configurePath}`;
        await $`sd -s -- ${"-Fe$output_objdir/$soname"} ${"-o $output_objdir/$soname"} ${configurePath}`;
        await $`sd -s -- '-link -EXPORT' "-Xlinker -EXPORT" ${configurePath}`;
    }

    const libsArg = passLibs ? `LIBS="${libs}"` : "";

    // Archive-sourced libraries (e.g. libraw) build in-tree and are never `git clean`ed between variants, so make
    // would reuse the other variant's objects (debug's -DLIBRAW_BUILDLIB ones in a "static" release build).
    await bash`cd ${msysPath} && make distclean`.noThrow(); // fails harmlessly on a fresh tree

    await bash`cd ${msysPath} && ${env} CC="sccache ${tools.cc}" CXX="sccache ${tools.cxx}" ${libsArg} ${configure} ${args} ${buildType} --prefix=${toMsysPath(prefix)} ${libtoolFlags}`;

    if (libtool) {
        const libtoolPath = `${path}/libtool`;
        await $`sd -s -- "-fuse-ld=*|" "-f*|--target=*|-march=*|-mtune=*|-D*|-g*|-w*|" ${libtoolPath}`.noThrow();

        if (toolchain === "msvc") {
            await $`sd -s -- 'wl=""' 'wl="-Wl,"' ${libtoolPath}`;
        }
    }

    await bash`cd ${msysPath} && ${env} ${makeEnv} make -j2 && make install`;
}

/** Compiles the sources directly: a static archive for release, a DLL (or .so) with its import lib for debug. */
export async function buildPlain(
    path: string,
    isDebug: boolean,
    { defFile, defines = [], exportAllSymbols, headers, includeDirs, libName, sources }: PlainArgs,
) {
    const { cFlags, includeFlags, ldFlags } = await computeFlags(isDebug),
        defineArgs = defines.map((d) => `-D${d}`).join(" "),
        flags = `${cFlags} ${includeFlags}`.trim(),
        includeArgs = includeDirs.map((d) => `-I${d}`).join(" "),
        msysPath = toMsysPath(path),
        isMsvc = toolchainState().toolchain === "msvc",
        prefix = buildRoot(isDebug);

    await bash`cd ${msysPath} && rm -f *.o *.a *.dll *.lib *.exp *.so *.pdb`;
    await bash`cd ${msysPath} && ${toolchainState().tools.cc} -c ${flags} ${defineArgs} ${includeArgs} ${sources.join(" ")}`;

    await $`mkdir -p ${`${prefix}/lib`}`;
    await $`mkdir -p ${`${prefix}/include`}`;

    if (isDebug) {
        const baseName = libName.replace(/^lib/, "").replace(/\.a$/, "");

        if (WIN) {
            await $`mkdir -p ${`${prefix}/bin`}`;

            const dllName = `${baseName}.dll`,
                importLibName = isMsvc ? `${baseName}.lib` : `${dllName}.a`,
                implibFlag = isMsvc ? `-Wl,-IMPLIB:${importLibName}` : `-Wl,--out-implib,${importLibName}`,
                pdbName = `${baseName}.pdb`,
                exportAllFlag = !isMsvc && exportAllSymbols ? "-Wl,--export-all-symbols" : "";

            let resolvedDefFile = defFile;
            if (isMsvc && exportAllSymbols && !defFile) {
                const defName = `${baseName}.def`;
                const stdout = await $`dumpbin /symbols *.o`.cwd(path).quiet().text();

                const symbols = new Set<string>();
                for (const line of stdout.split("\n")) {
                    if (!line.includes("External") || line.includes("UNDEF")) {
                        continue;
                    }

                    if (!line.includes("notype ()")) {
                        continue;
                    }

                    const name = line.split("|").pop()?.trim();
                    if (!name || name.startsWith("__") || name.startsWith("??_")) {
                        continue;
                    }
                    symbols.add(name);
                }

                const defContents = [
                    `LIBRARY ${baseName}`,
                    "EXPORTS",
                    ...[...symbols].sort().map((s) => `    ${s}`),
                ].join("\n");
                await writeFile(`${path}/${defName}`, defContents, "utf-8");
                resolvedDefFile = defName;
            }
            const defFlag = resolvedDefFile ? (isMsvc ? `-Wl,-DEF:${resolvedDefFile}` : resolvedDefFile) : "";

            await bash`cd ${msysPath} && ${toolchainState().tools.cc} -shared -o ${dllName} *.o ${ldFlags} ${exportAllFlag} ${defFlag} ${implibFlag}`;

            await $`cp ${dllName} ${`${prefix}/bin/${dllName}`}`.cwd(path);
            await $`cp ${importLibName} ${`${prefix}/lib/${importLibName}`}`.cwd(path);

            if (isMsvc) {
                await $`cp ${pdbName} ${`${prefix}/bin/${pdbName}`}`.cwd(path);
            }
        } else {
            const soName = `lib${baseName}.so`;

            await bash`cd ${msysPath} && ${toolchainState().tools.cc} -shared -o ${soName} *.o ${ldFlags}`;

            await $`cp ${soName} ${`${prefix}/lib/${soName}`}`.cwd(path);
        }
    } else {
        const outputLibName = isMsvc ? libName.replace(/^lib/, "").replace(/\.a$/, ".lib") : libName;

        await bash`cd ${msysPath} && ${toolchainState().tools.ar} rcs ${libName} *.o`;
        await $`cp ${libName} ${`${prefix}/lib/${outputLibName}`}`.cwd(path);
    }

    for (const h of headers) {
        const dest = `${prefix}/include/${h.dest}`,
            destDir = dest.slice(0, dest.lastIndexOf("/"));
        await $`mkdir -p ${destDir}`;
        await $`cp ${h.src} ${dest}`.cwd(path);
    }
}
