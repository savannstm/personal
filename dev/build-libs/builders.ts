import consola from "consola";
import $ from "dax";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import pc from "picocolors";

import { buildDir, buildRoot, ROOT, TOOLCHAINS_DIR, WIN_TAR } from "./settings.ts";
import { bash, raw, toMsysPath } from "./shell.ts";
import { clangBuiltinHeaders, computeFlags, installedRuntimes, rustPlatform, toolchainState } from "./toolchain.ts";
import type { Ctx, Library } from "./types.ts";

export function cmakeVal(on: boolean): string {
    return on ? "ON" : "OFF";
}

export function movePdbs(from: string, to: string) {
    for (const file of readdirSync(from).filter((f) => f.endsWith(".pdb"))) {
        cpSync(`${from}/${file}`, `${to}/${file}`);
        rmSync(`${from}/${file}`);
    }
}

export async function copyLib(root: string, from: string, to: string): Promise<void> {
    await $`cp ${`${root}/lib/${from}`} ${`${root}/lib/${to}`}`;
}

export function replaceInFile(file: string, from: RegExp | string, to: string, { optional = false } = {}): void {
    const text = readFileSync(file, "utf8");
    let search = from,
        replacement = to;
    if (typeof from === "string" && text.includes("\r\n")) {
        search = from.replaceAll("\n", "\r\n");
        replacement = to.replaceAll("\n", "\r\n");
    }
    const result =
        typeof search === "string" ? text.replaceAll(search, () => replacement) : text.replace(search, replacement);
    if (result === text) {
        if (!optional) {
            consola.warn(`${file}: nothing matched ${String(from)}`);
        }
        return;
    }
    writeFileSync(file, result);
}

export function stripDllImport(file: string): void {
    replaceInFile(file, "__declspec(dllimport)", "", { optional: true });
}

// For the installed CMake configs that use imported targets of other packages without finding them first.
export function addFindDependency(file: string, anchor: string, packages: string[]): void {
    const calls = packages.map((pkg) => `find_dependency(${pkg})`).join("\n");
    replaceInFile(file, anchor, `include(CMakeFindDependencyMacro)\n${calls}\n${anchor}`, { optional: true });
}

export async function applyPatch(path: string, patch: string): Promise<void> {
    const file = `${ROOT}/patches/${patch}`;
    if ((await $`git apply --check -R ${file}`.cwd(path).quiet().noThrow()).code === 0) {
        return;
    }
    try {
        await $`git apply ${file}`.cwd(path);
    } catch (error) {
        consola.warn(
            pc.yellow(
                `Patch ${patch} did not apply in ${path}: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
    }
}

export async function configureCMake(
    isDebug: boolean,
    cwd: string,
    args: string,
    env: Record<string, string | undefined> = { ...process.env },
) {
    const dir = buildDir(isDebug);
    await $`cmake -B ${dir} -S . -G Ninja --toolchain ${`${TOOLCHAINS_DIR}/${dir}.cmake`} --fresh -DBUILD_TOOLS=OFF -DBUILD_DOCS=OFF -DBUILD_DOC=OFF -DBUILD_EXAMPLE=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF -DBUILD_TESTS=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=${cmakeVal(isDebug)} ${raw(args)}`
        .cwd(cwd)
        .env(env);
}

export async function buildCMake(library: Library, ctx: Ctx) {
    const { isDebug, path } = ctx,
        cwd = library.sourceSubdir ? `${path}/${library.sourceSubdir}` : path,
        dir = buildDir(isDebug);
    await configureCMake(isDebug, cwd, library.args?.(ctx) ?? "");
    await $`cmake --build ${dir} -j`.cwd(cwd);
    await $`cmake --install ${dir}`.cwd(cwd);
}

export async function buildMeson(library: Library, ctx: Ctx) {
    const { isDebug, path } = ctx,
        dir = buildDir(isDebug);

    await $`meson setup ${dir} --native-file=${`${TOOLCHAINS_DIR}/native-${dir}.ini`} ${raw(library.args?.(ctx) ?? "")}`.cwd(
        path,
    );
    await $`meson compile -C ${dir}`.cwd(path);
    await $`meson install -C ${dir}`.cwd(path);
}

let cargoC: Promise<unknown> | undefined;

function rustTarget(): string {
    return toolchainState().toolchain === "msvc" ? "x86_64-pc-windows-msvc" : "x86_64-pc-windows-gnullvm";
}

async function installBinstall() {
    if (await $.which("cargo-binstall")) {
        return;
    }
    const bin = `${process.env.CARGO_HOME ?? `${process.env.USERPROFILE}/.cargo`}/bin`.replaceAll("\\", "/"),
        zip = `${bin}/cargo-binstall.zip`;
    mkdirSync(bin, { recursive: true });
    await $`curl -fL -o ${zip} https://github.com/cargo-bins/cargo-binstall/releases/latest/download/cargo-binstall-x86_64-pc-windows-msvc.zip`;
    await $`${WIN_TAR} -xf ${zip} -C ${bin}`;
    rmSync(zip);
}

function ensureCargoC() {
    const target = rustTarget();
    cargoC ??= (async () => {
        if ((await $`cargo cinstall --help`.quiet().noThrow()).code !== 0) {
            await installBinstall();
            await $`cargo binstall --no-confirm --targets ${target} cargo-c`;
        }
    })();
    return cargoC;
}

export async function buildRust(library: Library, ctx: Ctx) {
    await ensureCargoC();
    const { isDebug, path } = ctx,
        { toolchain } = toolchainState(),
        profile = `${rustPlatform(toolchain)}-${buildDir(isDebug)}`,
        target = ` --target ${rustTarget()}`;
    await $`cargo cinstall ${raw(isDebug ? "--library-type=cdylib" : "--library-type=staticlib")} ${raw(`--profile ${profile}${target}`)} --no-default-features ${raw(library.args?.(ctx) ?? "")} --prefix=${buildRoot(isDebug)}`.cwd(
        path,
    );
}

interface PlainArgs {
    defines?: string[];
    headers: string[]; // relative to the source tree, installed at the same path under include/
    includeDirs: string[];
    libName: string;
    sources: string[];
    defFile?: string;
}

interface AutoconfOptions {
    args?: string;
    configure?: string;
    env?: string;
    libtool?: boolean;
    libs?: boolean;
    linkage?: string; // replaces the build type's --enable/--disable-shared/static options
    nativePrefix?: boolean; // the prefix as a Windows path, for configure scripts whose result native programs read (Ruby)
    makeEnv?: string;
    jobs?: string;
}

export async function buildAutoconf(
    path: string,
    isDebug: boolean,
    prefix: string,
    {
        args = "",
        configure = "./configure",
        env = "",
        libs: passLibs = true,
        libtool = true,
        linkage,
        nativePrefix = false,
        makeEnv = "",
        jobs = "2",
    }: AutoconfOptions = {},
) {
    const msysPath = toMsysPath(path),
        { ownClang, ownRuntimes, toolchain, tools } = toolchainState();
    const configurePath = `${path}/configure`;
    let libs = "-ladvapi32 -luser32";

    if (toolchain !== "msvc") {
        // llvm-runtimes' compiler-rt installs per target, without the suffix of CLANG64's.
        const suffix = ownClang || ownRuntimes ? "" : "-x86_64";
        libs += ` -lclang_rt.builtins${suffix}`;
        if (process.env.CFLAGS!.includes("-fsanitize=address")) {
            libs += ` -lclang_rt.asan_dynamic${suffix} -lclang_rt.asan_dynamic_runtime_thunk${suffix}`;
        }
        libs += " -lole32 -lcfgmgr32";
    }

    const buildType = linkage ?? (isDebug ? "--enable-shared --disable-static" : "--disable-shared --enable-static");
    const libtoolFlags = libtool
        ? '--disable-dependency-tracking --with-gnu-ld --build=x86_64-w64-mingw32 --host=x86_64-w64-mingw32 lt_cv_deplibs_check_method="pass_all" lt_cv_prog_gnu_ld=yes'
        : "";

    if (libtool && toolchain === "msvc") {
        replaceInFile(configurePath, "-Fe$tool_output_objdir$soname", "-o $tool_output_objdir$soname");
        replaceInFile(configurePath, "-Fe$output_objdir/$soname", "-o $output_objdir/$soname");
        replaceInFile(configurePath, "-link -EXPORT", "-Xlinker -EXPORT");
    }

    const libsArg = passLibs ? `LIBS="${libs}"` : "";

    await bash`cd ${msysPath} && make distclean`.noThrow();

    // In ImageMagick's libtool shared link, -resource-dir from LDFLAGS never reached clang: compiler-rt was then missing or
    // taken from CLANG64 (duplicate symbols). libtool runs $CC as the command prefix, so the flag goes there.
    const resourceFlag = ownRuntimes && !ownClang ? ` -resource-dir=${installedRuntimes(buildRoot(false))!.resourceDir}` : "",
        // configure also compiles helper programs with CC alone (gmp's gen-fac.c includes stdlib.h, which needs mm_malloc.h).
        // Not CXX: builtin headers ahead of libc++'s wrappers break C++ includes.
        ccHeaders = resourceFlag ? ` -isystem ${clangBuiltinHeaders()}` : "";

    await bash`cd ${msysPath} && ${env} CC="sccache ${tools.cc}${resourceFlag}${ccHeaders}" CXX="sccache ${tools.cxx}${resourceFlag}" ${libsArg} ${configure} ${args} ${buildType} --prefix=${nativePrefix ? prefix : toMsysPath(prefix)} ${libtoolFlags}`;

    if (libtool) {
        const libtoolPath = `${path}/libtool`;
        replaceInFile(libtoolPath, "-fuse-ld=*|", "-f*|--target=*|-march=*|-mtune=*|-D*|-g*|-w*|", {
            optional: true,
        });

        if (toolchain === "msvc") {
            replaceInFile(libtoolPath, 'wl=""', 'wl="-Wl,"');
        }
    }

    await bash`cd ${msysPath} && ${env} ${makeEnv} make -j${jobs} && make install`;
}

export async function buildPlain(
    path: string,
    isDebug: boolean,
    { defFile, defines = [], headers, includeDirs, libName, sources }: PlainArgs,
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

        await $`mkdir -p ${`${prefix}/bin`}`;

        const dllName = `${baseName}.dll`,
            importLibName = isMsvc ? `${baseName}.lib` : `${dllName}.a`,
            implibFlag = isMsvc ? `-Wl,-IMPLIB:${importLibName}` : `-Wl,--out-implib,${importLibName}`,
            pdbName = `${baseName}.pdb`;

        let defFlag = "";
        if (defFile) {
            defFlag = isMsvc ? `-Wl,-DEF:${defFile}` : defFile;
        }

        await bash`cd ${msysPath} && ${toolchainState().tools.cc} -shared -o ${dllName} *.o ${ldFlags} ${defFlag} ${implibFlag}`;

        await $`cp ${dllName} ${`${prefix}/bin/${dllName}`}`.cwd(path);
        await $`cp ${importLibName} ${`${prefix}/lib/${importLibName}`}`.cwd(path);

        if (isMsvc) {
            await $`cp ${pdbName} ${`${prefix}/bin/${pdbName}`}`.cwd(path);
        }
    } else {
        const outputLibName = isMsvc ? libName.replace(/^lib/, "").replace(/\.a$/, ".lib") : libName;

        await bash`cd ${msysPath} && ${toolchainState().tools.ar} rcs ${libName} *.o`;
        await $`cp ${libName} ${`${prefix}/lib/${outputLibName}`}`.cwd(path);
    }

    for (const header of headers) {
        const dest = `${prefix}/include/${header}`,
            destDir = dest.slice(0, dest.lastIndexOf("/"));
        await $`mkdir -p ${destDir}`;
        await $`cp ${header} ${dest}`.cwd(path);
    }
}
