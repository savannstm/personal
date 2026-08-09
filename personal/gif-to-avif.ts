// Convert all GIFs under an input dir to AVIF (librav1e) in an output dir (flat, no mirrored structure).
// Usage: gif-to-avif.ts <input_dir> <output_dir>

import { consola } from "consola";
import { $ } from "dax";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";

const QP = 50;

async function walkGifs(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walkGifs(full)));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gif")) {
            files.push(full);
        }
    }
    return files;
}

async function convertOne(gif: string, outputDir: string): Promise<void> {
    const name = basename(gif, ".gif");
    const out = join(outputDir, `${name}.avif`);
    consola.log(`Converting: ${gif} -> ${out}`);

    const result = await $`ffmpeg -y -i ${gif} -c:v librav1e -qp ${QP} -pix_fmt yuv420p ${out}`.quiet().noThrow();
    if (result.code === 0) {
        consola.log(`Done: ${out}`);
    } else {
        consola.error(`Failed: ${gif}`);
    }
}

async function main() {
    const [inputDir, outputDir] = process.argv.slice(2);
    if (!inputDir || !outputDir) {
        consola.error("Usage: gif-to-avif.ts <input_dir> <output_dir>");
        process.exit(1);
    }

    if (!existsSync(inputDir)) {
        consola.error(`Input directory not found: ${inputDir}`);
        process.exit(1);
    }
    await mkdir(outputDir, { recursive: true });

    const gifs = await walkGifs(inputDir);
    for (const gif of gifs) {
        await convertOne(gif, outputDir);
    }
}

await main();
