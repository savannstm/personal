import { consola } from "consola";
import { $ } from "dax";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import pc from "picocolors";

interface CliArgs {
    input: string;
    output: string;
    parallel: number;
}

type Status = "failed" | "ok" | "skipped";
interface Result {
    name: string;
    status: Status;
    reason?: string;
}

function parseCliArgs(): CliArgs {
    const { values } = parseArgs({
        options: {
            input: { short: "i", type: "string" },
            output: { short: "o", type: "string" },
            parallel: { default: "2", short: "p", type: "string" },
        },
    });

    if (!values.input || !values.output) {
        consola.error("Usage: chevc.ts --input <dir> --output <dir> [--parallel <n>]");
        process.exit(1);
    }

    return {
        input: values.input,
        output: values.output,
        parallel: Number(values.parallel),
    };
}

async function convertFile(file: string, outputDir: string): Promise<Result> {
    const name = basename(file);
    const output = join(outputDir, name);

    if (existsSync(output)) {
        consola.log(pc.yellow(`  ⊘ Skipped (exists): ${name}`));
        return { name, status: "skipped" };
    }

    // Per-stream bitrate, fall back to container bitrate
    let bitrate = (
        await $`ffprobe -v quiet -select_streams v:0 -show_entries stream=bit_rate -of csv=p=0 ${file}`.text()
    ).trim();

    if (!bitrate || bitrate === "N/A") {
        bitrate = (await $`ffprobe -v quiet -show_entries format=bit_rate -of csv=p=0 ${file}`.text()).trim();
    }

    if (!bitrate || bitrate === "N/A") {
        return { name, reason: "no bitrate", status: "failed" };
    }

    const bps = Number(bitrate);
    const maxrate = Math.round(bps * 1.2);
    const bufsize = bps * 2;
    const kbps = Math.round(bps / 1000);

    // Probe codec + pixel format
    const streamInfo = (
        await $`ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name,pix_fmt -of csv=p=0 ${file}`.text()
    ).trim();
    const [codecName, pixFmt] = streamInfo.split(",");

    let hwaccelArgs: string[] = [];
    let decoderArgs: string[] = [];

    switch (codecName) {
        case "h264":
            if (/yuv420p10|p010|yuv420p10le/.test(pixFmt ?? "")) {
                // h264 with 10-bit is not hardware-supported ANYWHERE
            } else {
                hwaccelArgs = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"];
                decoderArgs = ["-c:v", "h264_cuvid"];
            }
            break;
        case "hevc":
            hwaccelArgs = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"];
            decoderArgs = ["-c:v", "hevc_cuvid"];
            break;
        default:
            return {
                name,
                reason: `unsupported codec: ${codecName}`,
                status: "skipped",
            };
    }

    consola.log(`→ ${name}  [${kbps} kbps]  codec=${codecName}  pix=${pixFmt}`);

    const result =
        await $`ffmpeg -hide_banner ${hwaccelArgs} ${decoderArgs} -i ${file} -map 0 -map_metadata 0 -map_chapters 0 -c:v hevc_nvenc -profile:v main10 -preset p6 -pix_fmt p010le -rc:v vbr -b:v ${bps} -maxrate:v ${maxrate} -bufsize:v ${bufsize} -bf 5 -c:a copy -c:s copy ${output}`
            .quiet()
            .noThrow();

    const ok = result.code === 0;
    consola.log((ok ? pc.green : pc.red)(`  ${ok ? "✓" : "✗"} ${name}\n`));

    return { name, status: ok ? "ok" : "failed" };
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const current = index++;
            results[current] = await fn(items[current]!);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

async function main() {
    const { input, output, parallel } = parseCliArgs();

    if (!existsSync(input)) {
        consola.error(`Input directory not found: ${input}`);
        process.exit(1);
    }

    await mkdir(output, { recursive: true });

    const entries = await readdir(input, { withFileTypes: true });
    const files = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".mkv"))
        .map((e) => join(input, e.name));

    if (files.length === 0) {
        consola.log(`No MKV files found in: ${input}`);
        return;
    }

    consola.log(`Found ${files.length} file(s). Starting conversion (parallel: ${parallel})...\n`);

    const results = await runWithConcurrency(files, parallel, (f) => convertFile(f, output));

    const success = results.filter((r) => r.status === "ok").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const failed = results.filter((r) => r.status !== "ok" && r.status !== "skipped").length;

    consola.log(`Complete - Success: ${success}  Skipped: ${skipped}  Failed: ${failed}`);
}

$.setPrintCommand(true);

await main();
