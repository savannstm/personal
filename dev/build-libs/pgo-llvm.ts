import $ from "dax";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { latestVersionDir } from "./msvc.ts";
import {
    MAGICK_CODEC_LIBS,
    MAGICK_DEFINES,
    PGO_SYSTEM_LIBS,
    profraws,
    releaseArchives,
    removeStaleProfiles,
} from "./pgo-common.ts";
import {
    buildRoot,
    CLANG64,
    CLANG64_PKG_CONFIG,
    type LlvmTarget,
    llvmPgo,
    llvmTargets,
    MAGICK_PGO_VARIANT,
    magickSuffix,
    PROFILES_DIR,
    ROOT,
    settings,
} from "./settings.ts";
import { raw } from "./shell.ts";
import {
    CLANG_WIN_TARGET,
    computeFlags,
    DEBUG_TRAIN_CFLAGS,
    installedRuntimes,
    RELEASE_NON_LTO_LINKER_FLAGS,
    updateEnv,
} from "./toolchain.ts";

const LLVM_PGO_DIR = `${ROOT}/pgo/llvm`;

// Trains the LLVM profiles when --pgo-train asks for them. Resolves to true for a training run, whose LLVM build is skipped.
export async function trainLlvm(path: string, llvmArgs: string, optFlags: string): Promise<boolean> {
    // A full run stops once the profile exists; --pgo-ir-only always stops after the IR profiles.
    const stops = settings.pgoTraining && llvmPgo() && (settings.pgoIrOnly || !existsSync(settings.llvmProfdata));
    if (!stops) {
        return false;
    }
    const targets = llvmTargets(),
        missingIr = targets.filter((target) => !existsSync(settings.llvmIrProfdata[target]!));
    if (settings.pgoIrOnly && missingIr.length === 0) {
        return true;
    }
    if (targets.includes("lld") && !existsSync(`${buildRoot(false)}/include/ImageMagick-7`)) {
        throw new Error(
            `--pgo lld links ImageMagick from ${buildRoot(false)}, which isn't built yet: build the libraries first.`,
        );
    }
    await updateEnv(false);
    // updateEnv seeds the cmake runs below through the environment. Keep the release flags (CMake initializes its flags from
    // them), but drop what depends on the prefix's contents: the final LLVM build's prefix has no libraries, this one does.
    const { cFlags, cxxFlags, ldFlags } = await computeFlags(false);
    Object.assign(process.env, { CFLAGS: cFlags, CXXFLAGS: cxxFlags, LDFLAGS: ldFlags });
    for (const name of ["CPATH", "C_INCLUDE_PATH", "LIBRARY_PATH"]) {
        delete process.env[name];
    }
    for (const dir of ["instrument", "cs-instrument", "train", "train-debug", "lld-train"]) {
        rmSync(`${LLVM_PGO_DIR}/${dir}`, { force: true, recursive: true });
    }

    const llvmSrc = `${path}/llvm`,
        inst = `${LLVM_PGO_DIR}/instrument`,
        csInst = `${LLVM_PGO_DIR}/cs-instrument`,
        trainDir = `${LLVM_PGO_DIR}/train`,
        debugTrainDir = `${LLVM_PGO_DIR}/train-debug`,
        lldDir = `${LLVM_PGO_DIR}/lld-train`,
        irProfdata = `${LLVM_PGO_DIR}/ir.profdata`,
        profdata = `${CLANG64}/bin/llvm-profdata.exe`,
        withLld = targets.includes("lld");

    const buildInstrumented = async (dir: string, flags: string, instrumentArgs: string[], active: LlvmTarget[]) => {
        await $`cmake -G Ninja -S ${llvmSrc} -B ${dir} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_FLAGS_RELEASE=${flags} -DCMAKE_CXX_FLAGS_RELEASE=${flags} ${instrumentArgs} ${raw(llvmArgs)} -DLLVM_ENABLE_PROJECTS=${active.join(";")} -DLLVM_ENABLE_RUNTIMES= -DLLVM_DISTRIBUTION_COMPONENTS= -DCLANG_DEFAULT_CXX_STDLIB=libc++ -DCLANG_DEFAULT_RTLIB=compiler-rt -DCLANG_DEFAULT_UNWINDLIB=libunwind`.env(
            {
                ...process.env,
                PKG_CONFIG_PATH: CLANG64_PKG_CONFIG,
            },
        );
        await $`ninja ${active}`.cwd(dir);
        if (active.includes("lld")) {
            await $`cp ${dir}/bin/lld.exe ${dir}/bin/ld.lld.exe`;
        }
    };

    // The runtimes come from llvm-runtimes' install once it's in the prefix; CLANG64's clang headers stay (version-specific).
    const runtimes = installedRuntimes(buildRoot(false)),
        clangResource = `${CLANG64}/lib/clang/${latestVersionDir(`${CLANG64}/lib/clang`)}`,
        clangHeaders = `${clangResource}/include`,
        libDirs = [...(runtimes?.libDirs ?? []), `${CLANG64}/lib`].map((dir) => `-L ${dir}`).join(" "),
        cxxIncludes = (runtimes?.cxxIncludes ?? [`${CLANG64}/include/c++/v1`])
            .map((dir) => `-isystem ${dir}`)
            .join(" "),
        trainRuntime = `--sysroot=${CLANG64} -resource-dir ${runtimes?.resourceDir ?? clangResource} -rtlib=compiler-rt --unwindlib=libunwind ${libDirs}`,
        rtHeaders = runtimes ? `-isystem ${runtimes.resourceDir}/include ` : "",
        trainCFlags = `${trainRuntime} ${rtHeaders}-isystem ${clangHeaders} -isystem ${CLANG64}/include`,
        trainCxxFlags = `${trainRuntime} -stdlib=libc++ ${runtimes ? "-nostdinc++ " : ""}${cxxIncludes} ${rtHeaders}-isystem ${clangHeaders} -isystem ${CLANG64}/include`,
        trainLdFlags = `${trainRuntime} -stdlib=libc++`,
        clang64Env = { ...process.env, PATH: `${CLANG64}/bin;${process.env.PATH ?? ""}` },
        mainCpp = `${lldDir}/main.cpp`,
        magickDefs = [...MAGICK_DEFINES, "-D_MT"];

    if (withLld) {
        mkdirSync(lldDir, { recursive: true });
        writeFileSync(
            mainCpp,
            '#include <MagickWand/MagickWand.h>\nint main() {\n    MagickWandGenesis();\n    MagickWand* wand = NewMagickWand();\n    MagickReadImage(wand, "xc:red");\n    MagickWriteImage(wand, "out.png");\n    DestroyMagickWand(wand);\n    MagickWandTerminus();\n}\n',
        );
    }

    const configureTrain = async (
        dir: string,
        out: string,
        releaseC: string,
        releaseCxx: string,
        tablegen: string[] = [],
    ) => {
        await $`cmake -G Ninja -S ${llvmSrc} -B ${out} -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=${`${dir}/bin/clang.exe`} -DCMAKE_CXX_COMPILER=${`${dir}/bin/clang++.exe`} -DLLVM_ENABLE_LIBCXX=ON -DLLVM_ENABLE_PROJECTS=clang -DLLVM_ENABLE_ASSERTIONS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_DOCS=OFF -DLLVM_INCLUDE_UTILS=OFF -DCLANG_INCLUDE_DOCS=OFF -DCLANG_INCLUDE_TESTS=OFF -DLLVM_TARGETS_TO_BUILD=Native -DCMAKE_C_FLAGS=${trainCFlags} -DCMAKE_CXX_FLAGS=${trainCxxFlags} -DCMAKE_C_FLAGS_RELEASE=${releaseC} -DCMAKE_CXX_FLAGS_RELEASE=${releaseCxx} -DCMAKE_EXE_LINKER_FLAGS=${trainLdFlags} -DCMAKE_SHARED_LINKER_FLAGS=${trainLdFlags} -DCMAKE_MODULE_LINKER_FLAGS=${trainLdFlags} ${tablegen}`;
    };

    const train = async (dir: string, rawDir: string, active: LlvmTarget[]): Promise<string[]> => {
        mkdirSync(rawDir, { recursive: true });

        if (active.includes("clang")) {
            rmSync(trainDir, { force: true, recursive: true });
            await configureTrain(dir, trainDir, `${optFlags} ${trainCFlags}`, `${optFlags} ${trainCxxFlags}`);
        }

        for (const file of profraws(rawDir)) {
            rmSync(file);
        }

        if (active.includes("clang")) {
            await $`ninja tools/clang/lib/Sema/CMakeFiles/obj.clangSema.dir/Sema.cpp.obj`.cwd(trainDir);

            const cxx23Dir = `${ROOT}/patches/pgo/fixtures/cxx23`;
            await $`${dir}/bin/clang++.exe --target=${CLANG_WIN_TARGET} -std=c++23 -O3 -c ${raw(trainCxxFlags)} -I${cxx23Dir} ${cxx23Dir}/train.cpp -o ${trainDir}/cxx23.o`.env(
                clang64Env,
            );

            const cDir = `${ROOT}/patches/pgo/fixtures/c`;
            await $`${dir}/bin/clang.exe --target=${CLANG_WIN_TARGET} -O3 -c ${raw(trainCFlags)} ${cDir}/tinyfiledialogs.c -o ${trainDir}/tinyfiledialogs.o`.env(
                clang64Env,
            );

            rmSync(debugTrainDir, { force: true, recursive: true });
            await configureTrain(
                dir,
                debugTrainDir,
                `${DEBUG_TRAIN_CFLAGS.join(" ")} ${trainCFlags}`,
                `${DEBUG_TRAIN_CFLAGS.join(" ")} ${trainCxxFlags}`,
                [
                    `-DLLVM_TABLEGEN=${trainDir}/bin/llvm-tblgen.exe`,
                    `-DCLANG_TABLEGEN=${trainDir}/bin/clang-tblgen.exe`,
                ],
            );
            const semaUnits = ["Sema", "SemaExpr", "SemaDecl", "SemaDeclCXX", "SemaOverload", "SemaTemplate"].map(
                (unit) => `tools/clang/lib/Sema/CMakeFiles/obj.clangSema.dir/${unit}.cpp.obj`,
            );
            await $`ninja ${semaUnits}`.cwd(debugTrainDir);
        }

        if (active.includes("lld")) {
            const lldArchives = releaseArchives(`${buildRoot(false)}/lib`, ["Qt6"]),
                codecLibs = MAGICK_CODEC_LIBS.map((name) => `-l${name}`),
                linkBase = [
                    `--target=${CLANG_WIN_TARGET}`,
                    "-std=gnu++23",
                    "-O3",
                    "-fopenmp",
                    `--ld-path=${dir}/bin/ld.lld.exe`,
                    mainCpp,
                ],
                releaseArgs = [
                    ...linkBase,
                    "-flto=full",
                    "-ffat-lto-objects",
                    "-ffunction-sections",
                    "-fdata-sections",
                    ...RELEASE_NON_LTO_LINKER_FLAGS,
                    "-Wl,--lto-O3",
                    // The consumers' link applies the library profile's CS part (linkLibsProfile), which changes the LTO work.
                    ...(existsSync(settings.libsProfdata) ? [`-fprofile-use=${settings.libsProfdata}`] : []),
                    "-static",
                    "-pthread",
                    "-D_LIB",
                    ...magickDefs,
                    `-I${buildRoot(false)}/include/ImageMagick-7`,
                    "-Wl,--start-group",
                    ...lldArchives,
                    ...codecLibs,
                    ...PGO_SYSTEM_LIBS,
                    "-Wl,--end-group",
                    "-o",
                    `${lldDir}/release.exe`,
                ],
                debugArgs = [
                    ...linkBase,
                    ...DEBUG_TRAIN_CFLAGS,
                    "-D_DLL",
                    ...magickDefs,
                    `-I${CLANG64}/include/ImageMagick-7`,
                    `-L${CLANG64}/lib`,
                    `-lMagickWand-7.${magickSuffix(MAGICK_PGO_VARIANT)}`,
                    "-o",
                    `${lldDir}/debug.exe`,
                ];
            // lld ends with TerminateProcess unless LLD_IN_TEST is set, which skips the profile runtime's atexit dump.
            const lldEnv = { ...clang64Env, LLD_IN_TEST: "1" };
            await $`clang++ ${releaseArgs}`.env(lldEnv);
            await $`clang++ ${debugArgs}`.env(lldEnv);
        }

        return profraws(rawDir);
    };

    mkdirSync(LLVM_PGO_DIR, { recursive: true });
    mkdirSync(PROFILES_DIR, { recursive: true });

    for (const target of missingIr) {
        rmSync(inst, { force: true, recursive: true });
        await buildInstrumented(inst, optFlags, ["-DLLVM_BUILD_INSTRUMENTED=IR"], [target]);
        const output = settings.llvmIrProfdata[target]!;
        await $`${profdata} merge -output=${output} ${await train(inst, `${inst}/profiles`, [target])}`.env(clang64Env);
        removeStaleProfiles(output, `llvm-ir-${target}-`);
    }
    if (settings.pgoIrOnly) {
        return true;
    }
    await $`${profdata} merge -output=${irProfdata} ${targets.map((target) => settings.llvmIrProfdata[target]!)}`.env(
        clang64Env,
    );

    const csNameDir = `${LLVM_PGO_DIR}/cs-name`;
    rmSync(csNameDir, { force: true, recursive: true });
    mkdirSync(csNameDir, { recursive: true });
    await $`${CLANG64}/bin/llvm-ar.exe x ${resourceDir}/lib/windows/libclang_rt.profile-x86_64.a InstrProfilingNameVar.c.obj`
        .cwd(csNameDir)
        .env(clang64Env);
    await buildInstrumented(
        csInst,
        optFlags,
        [
            "-DLLVM_BUILD_INSTRUMENTED=CSIR",
            `-DLLVM_PROFDATA_FILE=${irProfdata}`,
            "-DLLVM_ENABLE_LTO=Full",
            "-DLLVM_PARALLEL_LINK_JOBS=2",
            `-DCMAKE_EXE_LINKER_FLAGS=${ldFlags} ${csNameDir}/InstrProfilingNameVar.c.obj`,
        ],
        targets,
    );
    await $`${profdata} merge -output=${settings.llvmProfdata} ${irProfdata} ${await train(csInst, `${csInst}/csprofiles`, targets)}`.env(
        clang64Env,
    );
    removeStaleProfiles(settings.llvmProfdata, `llvm-${targets.join("+")}-`);
    return true;
}
