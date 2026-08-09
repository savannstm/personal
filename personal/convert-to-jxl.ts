// Recursively convert JPG/PNG/WebP/HEIC/AVIF to JXL. Runs with bounded concurrency.
// ALL other files (PSD, RAW, docs, whatever) are copied untouched.
// Files already converted (matching .jxl already exists in destination) are skipped.
//
// - JPG/JPEG          : lossless bit-exact transcode (no recompression)
// - PNG               : -d 1.0 (visually lossless) -e 5
// - WebP              : dwebp -> PNG -> cjxl (-d 1.0 -e 5)
// - HEIC/HEIF         : heif-convert -> PNG -> cjxl (-d 1.0 -e 5)
// - AVIF              : ffmpeg -> PNG -> cjxl (-d 1.0 -e 5)
// - GIF               : copied as-is (not converted)
// - Anything else / any failed conversion / non-image files : copied as-is
// - Already-converted files (out.jxl already exists)         : skipped entirely
//
// Requires: cjxl (libjxl-tools). Optional but recommended: dwebp (libwebp-tools),
//           heif-convert (libheif-tools), ffmpeg (for AVIF decode).
// Extension matching is case-insensitive.

import { consola } from "consola";
import { $ } from "dax";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import pc from "picocolors";

interface CliArgs {
    src: string;
    dst: string;
    jobs: number;
}

function parseCliArgs(): CliArgs {
    const positionals = process.argv.slice(2).filter((a) => !a.startsWith("-"));
    const { values } = parseArgs({
        allowPositionals: true,
        options: {
            jobs: { short: "j", type: "string" },
        },
    });

    return {
        dst: positionals[1] ?? "./output",
        jobs: values.jobs ? Number(values.jobs) : os.cpus().length,
        src: positionals[0] ?? "./input",
    };
}

async function commandExists(name: string): Promise<boolean> {
    const result = await $`${name} --help`.quiet().noThrow();
    return result.code !== undefined;
}

const EFFORT = 5;
const DISTANCE = 1.0;

async function copyUntouched(src: string, dst: string, relPath: string, reason: string): Promise<void> {
    await copyFile(src, dst);
    consola.log(`COPY (${reason}): ${relPath}`);
}

async function processFile(
    srcFile: string,
    srcDir: string,
    dstDir: string,
    have: { dwebp: boolean; heif: boolean; ffmpeg: boolean },
): Promise<void> {
    const relPath = relative(srcDir, srcFile);
    const outDir = join(dstDir, dirname(relPath));
    await mkdir(outDir, { recursive: true });

    const baseName = basename(relPath);
    const ext = extname(baseName).slice(1).toLowerCase();
    const nameNoExt = baseName.slice(0, baseName.length - extname(baseName).length);

    const jxlAlready = join(outDir, `${nameNoExt}.jxl`);
    const copyAlready = join(outDir, baseName);

    const convertible = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "avif"]);
    if (convertible.has(ext)) {
        if (existsSync(jxlAlready)) {
            consola.log(`SKIP (already converted): ${relPath}`);
            return;
        }
    } else if (existsSync(copyAlready)) {
        consola.log(`SKIP (already copied): ${relPath}`);
        return;
    }

    switch (ext) {
        case "gif": {
            await copyUntouched(srcFile, copyAlready, relPath, "gif, not converted");
            return;
        }

        case "jpg":
        case "jpeg": {
            const result = await $`cjxl ${srcFile} ${jxlAlready} --lossless_jpeg=1 -e ${EFFORT} --quiet`
                .quiet()
                .noThrow();
            if (result.code === 0) {
                consola.log(`OK   (jpeg lossless transcode): ${relPath}`);
            } else {
                await rm(jxlAlready, { force: true });
                await copyUntouched(srcFile, copyAlready, relPath, "jpeg conversion failed");
            }
            return;
        }

        case "png": {
            const result = await $`cjxl ${srcFile} ${jxlAlready} -d ${DISTANCE} -e ${EFFORT} --quiet`
                .quiet()
                .noThrow();
            if (result.code === 0) {
                consola.log(`OK   (png, d=${DISTANCE} e=${EFFORT}): ${relPath}`);
            } else {
                await rm(jxlAlready, { force: true });
                await copyUntouched(srcFile, copyAlready, relPath, "png conversion failed");
            }
            return;
        }

        case "webp": {
            if (!have.dwebp) {
                await copyUntouched(srcFile, copyAlready, relPath, "webp, dwebp missing");
                return;
            }
            const tmpPng = join(os.tmpdir(), `${randomUUID()}.png`);
            const decode = await $`dwebp ${srcFile} -o ${tmpPng} -quiet`.quiet().noThrow();
            const encode =
                decode.code === 0
                    ? await $`cjxl ${tmpPng} ${jxlAlready} -d ${DISTANCE} -e ${EFFORT} --quiet`.quiet().noThrow()
                    : decode;
            if (encode.code === 0) {
                consola.log(`OK   (webp->png->jxl, d=${DISTANCE} e=${EFFORT}): ${relPath}`);
            } else {
                await rm(jxlAlready, { force: true });
                await copyUntouched(srcFile, copyAlready, relPath, "webp conversion failed");
            }
            await rm(tmpPng, { force: true });
            return;
        }

        case "heic":
        case "heif": {
            if (!have.heif) {
                await copyUntouched(srcFile, copyAlready, relPath, "heic, heif-convert missing");
                return;
            }
            const tmpPng = join(os.tmpdir(), `${randomUUID()}.png`);
            const decode = await $`heif-convert ${srcFile} ${tmpPng}`.quiet().noThrow();
            const encode =
                decode.code === 0
                    ? await $`cjxl ${tmpPng} ${jxlAlready} -d ${DISTANCE} -e ${EFFORT} --quiet`.quiet().noThrow()
                    : decode;
            if (encode.code === 0) {
                consola.log(`OK   (heic->png->jxl, d=${DISTANCE} e=${EFFORT}): ${relPath}`);
            } else {
                await rm(jxlAlready, { force: true });
                await copyUntouched(srcFile, copyAlready, relPath, "heic conversion failed");
            }
            await rm(tmpPng, { force: true });
            return;
        }

        case "avif": {
            if (!have.ffmpeg) {
                await copyUntouched(srcFile, copyAlready, relPath, "avif, ffmpeg missing");
                return;
            }
            const tmpPng = join(os.tmpdir(), `${randomUUID()}.png`);
            const decode = await $`ffmpeg -y -i ${srcFile} ${tmpPng}`.quiet().noThrow();
            const encode =
                decode.code === 0
                    ? await $`cjxl ${tmpPng} ${jxlAlready} -d ${DISTANCE} -e ${EFFORT} --quiet`.quiet().noThrow()
                    : decode;
            if (encode.code === 0) {
                consola.log(`OK   (avif->png->jxl, d=${DISTANCE} e=${EFFORT}): ${relPath}`);
            } else {
                await rm(jxlAlready, { force: true });
                await copyUntouched(srcFile, copyAlready, relPath, "avif conversion failed");
            }
            await rm(tmpPng, { force: true });
            return;
        }

        default: {
            await copyUntouched(srcFile, copyAlready, relPath, "non-image file");
        }
    }
}

async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walk(full)));
        } else if (entry.isFile()) {
            files.push(full);
        }
    }
    return files;
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const current = index++;
            await fn(items[current]!);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main() {
    const { src, dst, jobs } = parseCliArgs();

    if (!(await commandExists("cjxl"))) {
        consola.error("cjxl not found. Install libjxl-tools.");
        process.exit(1);
    }

    const have = {
        dwebp: await commandExists("dwebp"),
        ffmpeg: await commandExists("ffmpeg"),
        heif: await commandExists("heif-convert"),
    };

    if (!have.dwebp) consola.warn(pc.yellow("dwebp not found, WebP files will be copied untouched."));
    if (!have.heif) consola.warn(pc.yellow("heif-convert not found, HEIC/HEIF files will be copied untouched."));
    if (!have.ffmpeg) consola.warn(pc.yellow("ffmpeg not found, AVIF files will be copied untouched."));

    if (!existsSync(src)) {
        consola.error(`Source directory not found: ${src}`);
        process.exit(1);
    }
    await mkdir(dst, { recursive: true });

    const files = await walk(src);
    await runWithConcurrency(files, jobs, (f) => processFile(f, src, dst, have));

    consola.log("\n----------------------------------------");
    consola.log(`Done. Output dir: ${dst}`);
    consola.log("(scroll up for per-file OK/COPY/SKIP lines; grep for COPY to see anything not converted)");
    consola.log("----------------------------------------");
}

await main();
