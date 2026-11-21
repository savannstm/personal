// The media fixtures of the ffmpeg PGO trainer. They are committed under patches/pgo/fixtures/ffmpeg so CI doesn't encode
// them; regenerate with `node dev/build-libs/pgo-fixtures.ts` (CLANG64's ffmpeg encodes) after changing this table.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { extname } from "node:path";

import { CLANG64, ROOT } from "./settings.ts";

export const FFMPEG_FIXTURES_DIR = `${ROOT}/patches/pgo/fixtures/ffmpeg`;

export interface FfmpegInput {
    // ffmpeg encoder arguments.
    codecs: string;
    // Decoders that can produce frames from the file. The trainer requires a variant that has one of them, and the
    // file's demuxer, to decode it (a variant that has neither skips the file).
    decoders: string[];
    file: string;
    // "v"ideo, "a"udio or "av".
    kind: "a" | "av" | "v";
    // Embed the tags and a cover picture, as a tagged music file has.
    tagged?: boolean;
    // An encoder binary other than CLANG64's, whose libtheora crashes.
    encoder?: string;
    // Picture size (default 320x240) and seconds (default: 6 for video, 12 for audio).
    seconds?: number;
    size?: string;
}

// Mirrors the variants' decoders and demuxers (libraries.ts FFMPEG_VARIANTS).
// Left out on purpose: MPEG-1/2/4, MS-MPEG4 and WMV/WMA, which the apps only keep for legacy video.
export const FFMPEG_INPUTS: FfmpegInput[] = [
    { codecs: "-c:v libx264 -preset medium -bf 2 -c:a aac", decoders: ["h264", "aac"], file: "h264.mp4", kind: "av" },
    {
        codecs: "-c:v libx264 -preset medium -bf 3 -refs 4 -crf 27 -x264-params weightp=2",
        decoders: ["h264"],
        file: "h264-480p.mp4",
        kind: "v",
        seconds: 3,
        size: "854x480",
    },
    {
        codecs: "-c:v libx264 -preset fast -x264-params cabac=0:8x8dct=0",
        decoders: ["h264"],
        file: "h264-cavlc.mkv",
        kind: "v",
    },
    {
        codecs: "-c:v libx264 -preset fast -pix_fmt yuv420p10le",
        decoders: ["h264"],
        file: "h264-10bit.mkv",
        kind: "v",
    },
    {
        codecs: "-c:v libx264 -preset fast -flags +ildct+ilme -x264-params tff=1",
        decoders: ["h264"],
        file: "h264-interlaced.mkv",
        kind: "v",
    },
    {
        codecs: "-c:v libx265 -preset fast -x265-params log-level=error",
        decoders: ["hevc"],
        file: "hevc.mp4",
        kind: "v",
    },
    {
        codecs: "-c:v libx265 -preset fast -pix_fmt yuv420p10le -x265-params log-level=error",
        decoders: ["hevc"],
        file: "hevc-10bit.mkv",
        kind: "v",
    },
    {
        codecs: "-c:v libvpx -b:v 600k -c:a libvorbis",
        decoders: ["vp8", "vorbis"],
        file: "vp8.webm",
        kind: "av",
    },
    // Good quality with an alt-ref frame and compound prediction, as web VP9 has (realtime has neither).
    {
        codecs: "-c:v libvpx-vp9 -b:v 600k -deadline good -cpu-used 2 -auto-alt-ref 1 -lag-in-frames 16 -c:a libopus",
        decoders: ["vp9", "opus"],
        file: "vp9.webm",
        kind: "av",
    },
    {
        codecs: "-c:v libvpx-vp9 -pix_fmt yuv444p -b:v 800k -deadline good -cpu-used 4",
        decoders: ["vp9"],
        file: "vp9-444.webm",
        kind: "v",
    },
    {
        codecs: "-c:v libaom-av1 -cpu-used 6 -crf 32 -b:v 0",
        decoders: ["libdav1d"],
        file: "av1.mkv",
        kind: "v",
    },
    {
        codecs: "-c:v libtheora -q:v 4 -c:a libvorbis",
        decoders: ["theora", "vorbis"],
        encoder: "C:/PATH/ffmpeg/bin/ffmpeg.exe",
        file: "theora.ogv",
        kind: "av",
    },
    { codecs: "-c:v mjpeg -q:v 8", decoders: ["mjpeg"], file: "mjpeg.avi", kind: "v", seconds: 3 },
    { codecs: "-vf scale=160:120", decoders: ["gif"], file: "anim.gif", kind: "v", seconds: 3 },
    { codecs: "-c:v apng -vf scale=160:120", decoders: ["apng"], file: "anim.apng", kind: "v", seconds: 2 },
    {
        codecs: "-c:v libwebp_anim -lossless 0 -q:v 70 -vf scale=160:120",
        decoders: ["webp_anim"],
        file: "anim.webp",
        kind: "v",
        seconds: 3,
    },
    { codecs: "-c:a aac", decoders: ["aac"], file: "aac.m4a", kind: "a", tagged: true },
    { codecs: "-c:a aac -ac 6", decoders: ["aac"], file: "aac-51.mp4", kind: "a" },
    { codecs: "-c:a libmp3lame -b:a 128k", decoders: ["mp3float"], file: "mp3.mp3", kind: "a", tagged: true },
    { codecs: "-c:a flac", decoders: ["flac"], file: "flac.flac", kind: "a", tagged: true, seconds: 6 },
    { codecs: "-c:a flac -sample_fmt s32", decoders: ["flac"], file: "flac.mkv", kind: "a", seconds: 6 },
    { codecs: "-c:a libvorbis", decoders: ["vorbis"], file: "vorbis.ogg", kind: "a" },
    { codecs: "-c:a libopus", decoders: ["opus"], file: "opus.ogg", kind: "a" },
    { codecs: "-c:a ac3 -ac 6", decoders: ["ac3"], file: "ac3.ac3", kind: "a", seconds: 6 },
    { codecs: "-c:a eac3", decoders: ["eac3"], file: "eac3.eac3", kind: "a" },
    { codecs: "-c:a alac", decoders: ["alac"], file: "alac.m4a", kind: "a", tagged: true, seconds: 6 },
    { codecs: "-c:a dca -strict -2", decoders: ["dca"], file: "dts.dts", kind: "a", seconds: 6 },
    { codecs: "-c:a truehd -strict -2", decoders: ["truehd"], file: "truehd.thd", kind: "a", seconds: 6 },
    { codecs: "-c:a pcm_s16le", decoders: ["pcm_s16le"], file: "pcm16.wav", kind: "a", seconds: 3 },
    { codecs: "-c:a pcm_s24le", decoders: ["pcm_s24le"], file: "pcm24.wav", kind: "a", seconds: 3 },
    { codecs: "-c:a pcm_f32le", decoders: ["pcm_f32le"], file: "pcmf32.wav", kind: "a", seconds: 3 },
    { codecs: "-c:a pcm_u8", decoders: ["pcm_u8"], file: "pcm8.wav", kind: "a", seconds: 3 },
    { codecs: "-c:a pcm_mulaw", decoders: ["pcm_mulaw"], file: "mulaw.wav", kind: "a", seconds: 3 },
    { codecs: "-c:a pcm_alaw", decoders: ["pcm_alaw"], file: "alaw.wav", kind: "a", seconds: 3 },
    { codecs: "-c:a pcm_s16be", decoders: ["pcm_s16be"], file: "pcm16be.aiff", kind: "a", seconds: 3 },
    { codecs: "-c:a pcm_s24be", decoders: ["pcm_s24be"], file: "pcm24.caf", kind: "a", seconds: 3 },
    { codecs: "-c:a adpcm_ima_wav", decoders: ["adpcm_ima_wav"], file: "adpcm-ima.wav", kind: "a", seconds: 3 },
    { codecs: "-c:a adpcm_ms", decoders: ["adpcm_ms"], file: "adpcm-ms.wav", kind: "a", seconds: 3 },
];

// The demuxer of each container extension in the table.
export const FFMPEG_DEMUXERS: Record<string, string> = {
    ".aac": "aac",
    ".ac3": "ac3",
    ".aiff": "aiff",
    ".apng": "apng",
    ".avi": "avi",
    ".caf": "caf",
    ".dts": "dts",
    ".eac3": "eac3",
    ".flac": "flac",
    ".gif": "gif",
    ".m4a": "mov",
    ".mkv": "matroska",
    ".mp3": "mp3",
    ".mp4": "mov",
    ".ogg": "ogg",
    ".ogv": "ogg",
    ".thd": "truehd",
    ".wav": "wav",
    ".webm": "matroska",
    ".webp": "webp_anim",
};

const TAGS = [
    "title=The Innkeeper's Daughter",
    "artist=Trainer Quartet",
    "album=Synthetic Etudes",
    "album_artist=Trainer Quartet",
    "date=2024",
    "genre=Test",
    "track=3/12",
    "comment=PGO fixture",
];

function generate() {
    const ffmpeg = `${CLANG64}/bin/ffmpeg.exe`,
        run = (args: string[], binary = ffmpeg) =>
            execFileSync(binary, ["-v", "error", "-y", ...args], { stdio: "inherit" }),
        cover = `${FFMPEG_FIXTURES_DIR}/cover.tmp.jpg`;
    rmSync(FFMPEG_FIXTURES_DIR, { force: true, recursive: true });
    mkdirSync(FFMPEG_FIXTURES_DIR, { recursive: true });
    run(["-f", "lavfi", "-i", "testsrc2=size=300x300:rate=1:duration=1", "-frames:v", "1", cover]);

    for (const { codecs, encoder, file, kind, seconds, size, tagged } of FFMPEG_INPUTS) {
        const video = [
                "-f",
                "lavfi",
                "-i",
                `testsrc2=size=${size ?? "320x240"}:rate=25:duration=${seconds ?? 6},noise=alls=12:allf=t:all_seed=7`,
            ],
            audio = [
                "-f",
                "lavfi",
                "-i",
                `aevalsrc=0.4*sin(2*PI*(440+6*sin(6*t))*t)+0.02*random(0)|0.3*sin(2*PI*1320*t)+0.02*random(1):s=48000:d=${seconds ?? (kind === "av" ? 6 : 12)}`,
            ],
            inputs = kind === "v" ? video : kind === "a" ? audio : [...video, ...audio],
            extra = tagged
                ? [
                      "-i",
                      cover,
                      "-map",
                      "0:a",
                      "-map",
                      "1:v",
                      "-c:v",
                      "copy",
                      "-disposition:v:0",
                      "attached_pic",
                      ...(extname(file) === ".mp3" ? ["-id3v2_version", "3"] : []),
                      ...TAGS.flatMap((tag) => ["-metadata", tag]),
                  ]
                : [];
        run([...inputs, ...extra, ...codecs.split(" "), `${FFMPEG_FIXTURES_DIR}/${file}`], encoder);
    }
    rmSync(cover);
}

if (import.meta.filename.replaceAll("\\", "/") === process.argv[1]?.replaceAll("\\", "/")) {
    generate();
}
