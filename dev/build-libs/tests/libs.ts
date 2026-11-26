// Links every pkg-config package of the C:/dev-clang prefixes into a test executable and runs it.
// plain: ordinary flags. consumer: the flags of build-libs' generated toolchain files (full LTO, sanitizers).
// Usage: node libs.ts [plain|consumer] [release|debug] [name-regex]; without a mode and variant, all four combinations.
import { exec, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fromHere, generateToolchains, PREFIX as ROOT_PREFIX, setup } from "./common.ts";

const [MODE, VARIANT, FILTER = "."] = process.argv.slice(2) as ["plain" | "consumer", "release" | "debug", string?];
if (!VARIANT) {
    let failed = false;
    for (const mode of ["plain", "consumer"]) {
        for (const variant of ["release", "debug"]) {
            failed =
                spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode, variant], { stdio: "inherit" })
                    .status !== 0 || failed;
        }
    }
    process.exit(failed ? 1 : 0);
}
const WORK = setup(`libs-${MODE}-${VARIANT}`),
    PREFIX = `${ROOT_PREFIX}/${VARIANT}`,
    isRelease = VARIANT === "release";
if (MODE === "consumer") generateToolchains();

// package -> [headers, body of main returning non-zero on failure]
const SMOKE: Record<string, [string, string]> = {
    zlib: ["<zlib.h>", "CHECK(zlibVersion()[0] == '1');"],
    libpng: ["<png.h>", "CHECK(png_access_version_number() > 10600);"],
    libpng16: ["<png.h>", "CHECK(png_create_read_struct(PNG_LIBPNG_VER_STRING, 0, 0, 0));"],
    libjpeg: [
        "<cstdio> <jpeglib.h>",
        "jpeg_compress_struct c; jpeg_error_mgr e; c.err = jpeg_std_error(&e); jpeg_create_compress(&c); jpeg_destroy_compress(&c);",
    ],
    libturbojpeg: ["<turbojpeg.h>", "CHECK(tjInitCompress());"],
    libwebp: [
        "<webp/encode.h> <webp/decode.h>",
        "uint8_t px[16] = {}, *out = 0; CHECK(WebPEncodeRGBA(px, 2, 2, 8, 75, &out) > 0 && WebPGetDecoderVersion());",
    ],
    libwebpdecoder: ["<webp/decode.h>", "CHECK(WebPGetDecoderVersion());"],
    libwebpdemux: ["<webp/demux.h>", "CHECK(WebPGetDemuxVersion());"],
    libwebpmux: ["<webp/mux.h>", "CHECK(WebPGetMuxVersion() && WebPMuxNew());"],
    libsharpyuv: ["<webp/sharpyuv/sharpyuv.h>", "CHECK(SharpYuvGetVersion());"],
    libbrotlicommon: ["<brotli/shared_dictionary.h>", "CHECK(BrotliSharedDictionaryCreateInstance(0, 0, 0));"],
    libbrotlidec: ["<brotli/decode.h>", "CHECK(BrotliDecoderVersion());"],
    libbrotlienc: [
        "<brotli/encode.h>",
        'uint8_t out[64]; size_t n = 64; CHECK(BrotliEncoderCompress(5, 22, BROTLI_MODE_GENERIC, 3, (const uint8_t *)"abc", &n, out));',
    ],
    liblzma: ["<lzma.h>", "CHECK(lzma_version_number() && lzma_easy_encoder_memusage(6));"],
    libzstd: ["<zstd.h>", 'char out[64]; CHECK(!ZSTD_isError(ZSTD_compress(out, 64, "abc", 3, 3)));'],
    libdeflate: ["<libdeflate.h>", "CHECK(libdeflate_alloc_compressor(6));"],
    "libtiff-4": ["<tiffio.h>", "CHECK(TIFFGetVersion());"],
    libopenjp2: ["<openjpeg.h>", "CHECK(opj_version() && opj_create_compress(OPJ_CODEC_JP2));"],
    openjph: ["<openjph/ojph_codestream.h> <openjph/ojph_params.h>", "ojph::codestream s; s.access_siz();"],
    lcms2: ["<lcms2.h>", "CHECK(cmsCreate_sRGBProfile());"],
    dav1d: [
        "<dav1d/dav1d.h>",
        "Dav1dSettings s; dav1d_default_settings(&s); Dav1dContext *c = 0; CHECK(dav1d_open(&c, &s) == 0); dav1d_close(&c);",
    ],
    kvazaar: ["<kvazaar.h>", "const kvz_api *a = kvz_api_get(8); CHECK(a && a->config_alloc());"],
    libde265: ["<libde265/de265.h>", "CHECK(de265_get_version() && de265_new_decoder());"],
    libheif: [
        "<libheif/heif.h>",
        "CHECK(heif_get_version() && heif_context_alloc()); CHECK(heif_have_decoder_for_format(heif_compression_HEVC));",
    ],
    libhwy: ["<hwy/targets.h>", "CHECK(hwy::SupportedTargets() != 0);"],
    libjxl: [
        "<jxl/decode.h> <jxl/encode.h>",
        "CHECK(JxlDecoderVersion() && JxlDecoderCreate(0) && JxlEncoderCreate(0));",
    ],
    libjxl_cms: ["<jxl/cms.h>", "CHECK(JxlGetDefaultCms());"],
    libjxl_threads: ["<jxl/thread_parallel_runner.h>", "CHECK(JxlThreadParallelRunnerCreate(0, 2));"],
    libuhdr: ["<ultrahdr_api.h>", "CHECK(uhdr_create_encoder());"],
    libraw: ["<libraw/libraw.h>", "CHECK(libraw_version() && libraw_init(0));"],
    libraw_r: ["<libraw/libraw.h>", "CHECK(libraw_version() && libraw_init(0));"],
    "libxml-2.0": ["<libxml/parser.h>", 'CHECK(xmlReadMemory("<a/>", 4, 0, 0, 0));'],
    libzip: ["<zip.h>", 'int err; CHECK(zip_libzip_version() && zip_open("t.zip", ZIP_CREATE, &err));'],
    libarchive: [
        "<archive.h>",
        "CHECK(archive_version_details()); archive *a = archive_read_new(); CHECK(archive_read_support_format_all(a) == ARCHIVE_OK); archive_read_support_filter_all(a);",
    ],
    freetype2: ["<ft2build.h> FT_FREETYPE_H", "FT_Library l; CHECK(FT_Init_FreeType(&l) == 0);"],
    harfbuzz: ["<hb.h>", "CHECK(hb_version_string() && hb_buffer_create());"],
    "harfbuzz-subset": ["<hb-subset.h>", "CHECK(hb_subset_input_create_or_fail());"],
    "icu-uc": [
        "<unicode/uchar.h> <unicode/ucnv.h>",
        'UErrorCode s = U_ZERO_ERROR; CHECK(ucnv_open("Shift_JIS", &s) && U_SUCCESS(s));',
    ],
    // Collation data is excluded by patches/filters.json: use an i18n API that needs none of it.
    "icu-i18n": [
        "<unicode/uregex.h>",
        'UErrorCode s = U_ZERO_ERROR; CHECK(uregex_openC("a+", 0, 0, &s) && U_SUCCESS(s));',
    ],
    md4c: [
        "<md4c.h>",
        'MD_PARSER p = {}; p.enter_block = p.leave_block = [](MD_BLOCKTYPE, void *, void *) { return 0; }; p.enter_span = p.leave_span = [](MD_SPANTYPE, void *, void *) { return 0; }; p.text = [](MD_TEXTTYPE, const MD_CHAR *, MD_SIZE, void *) { return 0; }; CHECK(md_parse("# a", 3, &p, 0) == 0);',
    ],
    "md4c-html": ["<md4c-html.h>", 'CHECK(md_html("# a", 3, [](const MD_CHAR *, MD_SIZE, void *) {}, 0, 0, 0) == 0);'],
    OpenEXR: [
        "<openexr.h> <ImfRgbaFile.h>",
        'int a, b, c; const char *d; exr_get_library_version(&a, &b, &c, &d); CHECK(a == 3); { Imf::RgbaOutputFile f("t.exr", 2, 2); Imf::Rgba px[4] = {}; f.setFrameBuffer(px, 1, 2); f.writePixels(2); } Imf::RgbaInputFile in("t.exr");',
    ],
    Imath: ["<ImathVec.h> <half.h>", "Imath::V3f v(1, 2, 2); CHECK(v.length() == 3.f && (float)half(1.5f) == 1.5f);"],
    nuspell: [
        "<nuspell/dictionary.hxx> <sstream>",
        'std::istringstream aff("SET UTF-8\\n"), dic("1\\nword\\n"); nuspell::Dictionary d; d.load_aff_dic(aff, dic); CHECK(d.spell("word"));',
    ],
    OpenCL: ["<CL/cl.h>", "cl_uint n = 0; clGetPlatformIDs(0, 0, &n);"],
};
for (const [base, header, init] of [
    [
        "MagickWand",
        "<MagickWand/MagickWand.h>",
        'MagickWandGenesis(); MagickWand *w = NewMagickWand(); CHECK(MagickReadImage(w, "xc:red") && MagickWriteImage(w, "o.png") && MagickReadImage(w, "o.png")); MagickWriteImage(w, "o.jxl"); DestroyMagickWand(w); MagickWandTerminus();',
    ],
    [
        "MagickCore",
        "<MagickCore/MagickCore.h>",
        'MagickCoreGenesis("t", MagickFalse); size_t v; CHECK(GetMagickVersion(&v)); MagickCoreTerminus();',
    ],
    [
        "Magick++",
        "<Magick++.h>",
        'Magick::InitializeMagick(0); Magick::Image i(Magick::Geometry(4, 4), Magick::Color("red")); i.write("p.webp"); CHECK(i.columns() == 4);',
    ],
    ["ImageMagick", "<MagickCore/MagickCore.h>", 'MagickCoreGenesis("t", MagickFalse); MagickCoreTerminus();'],
] as const) {
    for (const suffix of ["", "-7.Q8", "-7.Q16HDRI"]) SMOKE[base + suffix] = [header, init];
}
const FFMPEG: [string, string] = [
    "<libavcodec/avcodec.h> <libavformat/avformat.h> <libavfilter/avfilter.h> <libavutil/avutil.h> <libswscale/swscale.h> <libswresample/swresample.h>",
    "CHECK(avcodec_version() && av_version_info()); void *it = 0; int n = 0; while (av_codec_iterate(&it)) ++n; CHECK(n > 0);",
];

function toolchainFlags(key: string): string {
    const text = readFileSync(fromHere(`../toolchains/${VARIANT}.cmake`), "utf8");
    return new RegExp(`set\\(${key}_${VARIANT.toUpperCase()} "([^"]*)"`).exec(text)![1]!;
}

const cxxFlags = MODE === "consumer" ? toolchainFlags("CMAKE_CXX_FLAGS") : `-O2 -fopenmp ${isRelease ? "" : "-g"}`,
    ldFlags = MODE === "consumer" ? toolchainFlags("CMAKE_EXE_LINKER_FLAGS") : `-fopenmp ${isRelease ? "-static" : ""}`;

function sh(cmd: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
    return new Promise((done) =>
        exec(cmd, { cwd, env, timeout: 600_000, maxBuffer: 1 << 26, windowsHide: true }, (err, stdout, stderr) =>
            done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: stdout + stderr }),
        ),
    );
}

const dirs = [
    PREFIX,
    ...readdirSync(PREFIX)
        .filter((d) => d.startsWith("ffmpeg-"))
        .map((d) => `${PREFIX}/${d}`),
];
const jobs: { name: string; dir: string; pkgs: string[]; smoke: [string, string] | undefined }[] = [];
for (const dir of dirs) {
    const pcs = ["lib/pkgconfig", "share/pkgconfig"].flatMap((sub) =>
        existsSync(`${dir}/${sub}`)
            ? readdirSync(`${dir}/${sub}`)
                  .filter((f) => f.endsWith(".pc"))
                  .map((f) => f.slice(0, -3))
            : [],
    );
    if (dir === PREFIX) {
        for (const pc of pcs) jobs.push({ name: pc, dir, pkgs: [pc], smoke: SMOKE[pc] });
    } else {
        jobs.push({ name: dir.slice(PREFIX.length + 1), dir, pkgs: pcs, smoke: FFMPEG });
    }
}

mkdirSync(WORK!, { recursive: true });
const results: string[] = [];
let passed = 0;

async function run({ name, dir, pkgs, smoke }: (typeof jobs)[number]) {
    const cwd = `${WORK}/${name}`;
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd);
    const env = {
            ...process.env,
            PKG_CONFIG_PATH: [`${dir}/lib/pkgconfig`, `${PREFIX}/lib/pkgconfig`, `${PREFIX}/share/pkgconfig`].join(";"),
            PATH: `${PREFIX}/bin;${process.env.PATH}`,
        },
        fail = (stage: string, cmd: string, out: string) =>
            results.push(
                `FAIL ${name} (${stage})\n  $ ${cmd.slice(0, 400)}\n${
                    out
                        .split("\n")
                        .filter((l) => /error|undefined|duplicate|>>>/i.test(l))
                        .slice(0, 12)
                        .join("\n") || out.slice(0, 1500)
                }`,
            ),
        query = async (args: string) => (await sh(`pkg-config ${args} ${pkgs.join(" ")}`, cwd, env)).out.trim();

    const cflags = (await query(isRelease ? "--static --cflags" : "--cflags")).replaceAll("-I", "-isystem "),
        libs = await query(isRelease ? "--static --libs" : "--libs"),
        // The package's own libraries that live in this prefix: pulled in whole, so every member must resolve.
        own = [...new Set((await query("--libs-only-l")).split(/\s+/))].filter((l) => {
            const base = `${dir}/lib/lib${l.slice(2)}`;
            return isRelease && existsSync(`${base}.a`);
        });
    const [headers, body] = smoke ?? ["", ""];
    const includes = headers
        .split(" ")
        .filter(Boolean)
        .map((h) => (/^<lib(av|sw)/.test(h) ? `extern "C" {\n#include ${h}\n}` : `#include ${h}`))
        .join("\n");
    writeFileSync(
        `${cwd}/t.cpp`,
        `#include <cstdio>\n#include <cstdint>\n${includes}\n#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "check failed: %s\\n", #x); return 1; } } while (0)\nint main() {\n    ${body}\n    std::puts("OK");\n}\n`,
    );

    const compile = `clang++ -std=c++23 ${cxxFlags} -isystem ${dir}/include -isystem ${PREFIX}/include ${cflags} -c t.cpp -o t.obj`;
    let r = await sh(compile, cwd, env);
    if (r.code) return fail("compile", compile, r.out);

    const link = `clang++ ${ldFlags} t.obj -o t.exe -L${dir}/lib -L${PREFIX}/lib ${libs}`;
    r = await sh(link, cwd, env);
    if (r.code) return fail("link", link, r.out);
    r = await sh(".\\t.exe", cwd, env);
    if (r.code || !r.out.includes("OK")) return fail("run", ".\\t.exe", `exit ${r.code}\n${r.out}`);

    // harfbuzz-subset compiles some of harfbuzz's objects itself: whole-archiving both collides by design.
    if (own.length && name !== "harfbuzz-subset") {
        const whole = `clang++ ${ldFlags} t.obj -o w.exe -L${dir}/lib -L${PREFIX}/lib -Wl,--whole-archive ${own.join(" ")} -Wl,--no-whole-archive ${libs
            .split(/\s+/)
            .filter((l) => !own.includes(l))
            .join(" ")}`;
        r = await sh(whole, cwd, env);
        if (r.code) return fail(`whole-archive ${own.join(" ")}`, whole, r.out);
    }
    passed++;
    if (!smoke) results.push(`note: ${name} linked without an API smoke call`);
}

const selected = jobs.filter((j) => new RegExp(FILTER).test(j.name));
let next = 0;
await Promise.all(
    Array.from({ length: MODE === "consumer" && isRelease ? 3 : 6 }, async () => {
        while (next < selected.length) await run(selected[next++]!);
    }),
);
console.log(results.join("\n\n"));
console.log(`\nlibs ${MODE} ${VARIANT}: ${passed}/${selected.length} passed`);
process.exitCode = passed === selected.length ? 0 : 1;
