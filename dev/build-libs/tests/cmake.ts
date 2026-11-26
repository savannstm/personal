// find_package() every CMake package of a prefix with build-libs' generated toolchain file, link, run.
// Usage: node cmake.ts [release|debug] [name-regex]; without a variant, both.
import { exec, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fromHere, generateToolchains, PREFIX as ROOT_PREFIX, setup } from "./common.ts";

const [VARIANT, FILTER = "."] = process.argv.slice(2) as ["release" | "debug", string?];
if (!VARIANT) {
    let failed = false;
    for (const variant of ["release", "debug"]) {
        failed =
            spawnSync(process.execPath, [fileURLToPath(import.meta.url), variant], { stdio: "inherit" }).status !== 0 ||
            failed;
    }
    process.exit(failed ? 1 : 0);
}
const WORK = setup(`cmake-${VARIANT}`),
    PREFIX = `${ROOT_PREFIX}/${VARIANT}`;
generateToolchains();

interface Pkg {
    find: string;
    targets: string;
    code: string; // headers + main
    extra?: string;
    release?: boolean; // only in the release prefix
}

const main = (headers: string, body: string) =>
    `#include <cstdio>\n${headers}\nint main(int argc, char **argv) {\n    (void)argc; (void)argv;\n    ${body}\n    std::puts("OK");\n}\n`;
const dep = (find: string, targets: string, headers: string, body: string): Pkg => ({
    find,
    targets,
    code: main(headers, body),
    release: true,
});

const PKGS: Record<string, Pkg> = {
    Qt6: {
        find: "Qt6 CONFIG REQUIRED COMPONENTS Core Gui Widgets Network Svg SvgWidgets OpenGL OpenGLWidgets Concurrent Test Xml UiTools",
        targets:
            "Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Network Qt6::Svg Qt6::SvgWidgets Qt6::OpenGL Qt6::OpenGLWidgets Qt6::Concurrent Qt6::Test Qt6::Xml Qt6::UiTools",
        extra: `set_target_properties(t PROPERTIES AUTOMOC ON)
qt_import_plugins(t INCLUDE Qt6::QOffscreenIntegrationPlugin)`,
        code: `#include <QApplication>
#include <QBuffer>
#include <QDomDocument>
#include <QImage>
#include <QImageReader>
#include <QLabel>
#include <QNetworkAccessManager>
#include <QOpenGLWidget>
#include <QSvgRenderer>
#include <QUiLoader>
#include <QtConcurrentRun>
#include <cstdio>
class Obj : public QObject { Q_OBJECT public: using QObject::QObject; Q_SIGNAL void ping(int); };
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "check failed: %s\\n", #x); return 1; } } while (0)
int main(int argc, char **argv) {
    qputenv("QT_QPA_PLATFORM", "offscreen");
    QApplication app(argc, argv);
    QLabel label(QStringLiteral("x")); label.show(); app.processEvents();
    Obj o; int got = 0; QObject::connect(&o, &Obj::ping, [&](int v) { got = v; }); emit o.ping(3); CHECK(got == 3);
    CHECK(QtConcurrent::run([] { return 5; }).result() == 5);
    QNetworkAccessManager net; QOpenGLWidget gl; QUiLoader loader; CHECK(!loader.availableWidgets().isEmpty());
    QSvgRenderer svg(QByteArray("<svg xmlns='http://www.w3.org/2000/svg' width='2' height='2'/>")); CHECK(svg.isValid());
    QDomDocument dom; CHECK(dom.setContent(QStringLiteral("<a/>")));
    const auto formats = QImageReader::supportedImageFormats();
    std::fprintf(stderr, "formats: %s\\n", formats.join(',').constData());
    for (const char *fmt : {"png", "jpg", "webp"}) { QImage img(2, 2, QImage::Format_RGB32); img.fill(Qt::red); QBuffer buf; buf.open(QIODevice::ReadWrite); CHECK(img.save(&buf, fmt)); CHECK(!QImage::fromData(buf.data(), fmt).isNull()); }
    std::puts("OK");
}
#include "t.moc"
`,
    },
    FLTK: {
        find: "FLTK CONFIG REQUIRED",
        targets: "fltk::fltk fltk::images fltk::gl",
        code: main(
            "#include <FL/Fl.H>\n#include <FL/Fl_PNG_Image.H>\n#include <FL/gl.h>",
            "if (Fl::api_version() < 10400) return 1;",
        ),
    },
    md4c: {
        find: "md4c CONFIG REQUIRED",
        targets: "md4c::md4c md4c::md4c-html",
        code: main(
            "#include <md4c-html.h>",
            'if (md_html("# a", 3, [](const MD_CHAR *, MD_SIZE, void *) {}, 0, 0, 0)) return 1;',
        ),
    },
    projectM4: {
        find: "projectM4 CONFIG REQUIRED",
        targets: "libprojectM::projectM",
        code: main(
            "#include <projectM-4/projectM.h>",
            "int a, b, c; projectm_get_version_components(&a, &b, &c); if (a != 4) return 1;",
        ),
    },
    qjs: dep(
        "qjs CONFIG REQUIRED",
        "qjs",
        "#include <quickjs.h>",
        'JSRuntime *r = JS_NewRuntime(); JSContext *c = JS_NewContext(r); JSValue v = JS_Eval(c, "6*7", 3, "t", 0); int n = 0; JS_ToInt32(c, &n, v); if (n != 42) return 1;',
    ),
    zlib: dep("ZLIB CONFIG REQUIRED", "ZLIB::ZLIB", "#include <zlib.h>", "if (!zlibVersion()) return 1;"),
    zstd: dep(
        "zstd CONFIG REQUIRED",
        "zstd::libzstd_static",
        "#include <zstd.h>",
        "if (!ZSTD_versionNumber()) return 1;",
    ),
    bzip2: dep("Threads REQUIRED", "BZip2::BZip2", "#include <bzlib.h>", "if (!BZ2_bzlibVersion()) return 1;"),
    liblzma: dep(
        "liblzma CONFIG REQUIRED",
        "liblzma::liblzma",
        "#include <lzma.h>",
        "if (!lzma_version_number()) return 1;",
    ),
    libdeflate: dep(
        "libdeflate CONFIG REQUIRED",
        "libdeflate::libdeflate_static",
        "#include <libdeflate.h>",
        "if (!libdeflate_alloc_compressor(1)) return 1;",
    ),
    tiff: dep(
        "tiff CONFIG REQUIRED",
        "TIFF::tiff TIFF::tiffxx",
        "#include <tiffio.h>\n#include <tiffio.hxx>",
        "if (!TIFFGetVersion()) return 1;",
    ),
    WebP: dep(
        "WebP CONFIG REQUIRED",
        "WebP::webp WebP::webpdecoder WebP::webpdemux WebP::libwebpmux",
        "#include <webp/decode.h>",
        "if (!WebPGetDecoderVersion()) return 1;",
    ),
    PNG: dep(
        "PNG CONFIG REQUIRED",
        "PNG::png_static",
        "#include <png.h>",
        "if (!png_access_version_number()) return 1;",
    ),
    openjph: dep("openjph CONFIG REQUIRED", "openjph", "#include <openjph/ojph_codestream.h>", "ojph::codestream s;"),
    OpenJPEG: dep("OpenJPEG CONFIG REQUIRED", "openjp2", "#include <openjpeg.h>", "if (!opj_version()) return 1;"),
    OpenEXR: dep(
        "OpenEXR CONFIG REQUIRED",
        "OpenEXR::OpenEXR OpenEXR::OpenEXRUtil",
        "#include <ImfRgbaFile.h>",
        'Imf::RgbaOutputFile f("t.exr", 2, 2);',
    ),
    Imath: dep("Imath CONFIG REQUIRED", "Imath::Imath", "#include <half.h>", "if ((float)half(2.f) != 2.f) return 1;"),
    Nuspell: dep(
        "Nuspell CONFIG REQUIRED",
        "Nuspell::nuspell",
        "#include <nuspell/dictionary.hxx>",
        "nuspell::Dictionary d;",
    ),
    libzip: dep("libzip CONFIG REQUIRED", "libzip::zip", "#include <zip.h>", "if (!zip_libzip_version()) return 1;"),
    libxml2: dep(
        "libxml2 CONFIG REQUIRED",
        "LibXml2::LibXml2",
        "#include <libxml/parser.h>",
        'if (!xmlReadMemory("<a/>", 4, 0, 0, 0)) return 1;',
    ),
    "libjpeg-turbo": dep(
        "libjpeg-turbo CONFIG REQUIRED",
        "libjpeg-turbo::turbojpeg-static",
        "#include <turbojpeg.h>",
        "if (!tjInitCompress()) return 1;",
    ),
    libheif: dep(
        "libheif CONFIG REQUIRED",
        "heif",
        "#include <libheif/heif.h>",
        "if (!heif_context_alloc()) return 1;",
    ),
    harfbuzz: dep(
        "harfbuzz CONFIG REQUIRED",
        "harfbuzz::harfbuzz harfbuzz::subset",
        "#include <hb-subset.h>",
        "if (!hb_subset_input_create_or_fail()) return 1;",
    ),
    libde265: dep(
        "libde265 CONFIG REQUIRED",
        "de265",
        "#include <libde265/de265.h>",
        "if (!de265_new_decoder()) return 1;",
    ),
    freetype: dep(
        "freetype CONFIG REQUIRED",
        "freetype",
        "#include <ft2build.h>\n#include FT_FREETYPE_H",
        "FT_Library l; if (FT_Init_FreeType(&l)) return 1;",
    ),
    lcms2: dep(
        "lcms2 CONFIG REQUIRED",
        "lcms2::lcms2",
        "#include <lcms2.h>",
        "if (!cmsCreate_sRGBProfile()) return 1;",
    ),
    hwy: dep("hwy CONFIG REQUIRED", "hwy::hwy", "#include <hwy/targets.h>", "if (!hwy::SupportedTargets()) return 1;"),
    OpenCL: dep(
        "OpenCLICDLoader CONFIG REQUIRED",
        "OpenCL::OpenCL",
        "#include <CL/cl.h>",
        "cl_uint n; clGetPlatformIDs(0, 0, &n);",
    ),
};

function sh(cmd: string, cwd: string): Promise<{ code: number; out: string }> {
    return new Promise((done) =>
        exec(
            cmd,
            {
                cwd,
                timeout: 600_000,
                maxBuffer: 1 << 26,
                windowsHide: true,
                env: { ...process.env, PATH: `${PREFIX}/bin;${process.env.PATH}` },
            },
            (err, stdout, stderr) =>
                done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: stdout + stderr }),
        ),
    );
}

const selected = Object.entries(PKGS).filter(
    ([name, p]) => new RegExp(FILTER).test(name) && !(p.release && VARIANT === "debug"),
);
const results: string[] = [];
let passed = 0,
    next = 0;

async function run([name, pkg]: [string, Pkg]) {
    const cwd = `${WORK}/${name}`;
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(`${cwd}/t.cpp`, pkg.code);
    writeFileSync(
        `${cwd}/CMakeLists.txt`,
        `cmake_minimum_required(VERSION 3.28)\nproject(t C CXX)\nfind_package(${pkg.find})\nadd_executable(t t.cpp)\ntarget_link_libraries(t PRIVATE ${pkg.targets})\n${pkg.extra ?? ""}\n`,
    );
    for (const [stage, cmd] of [
        ["configure", `cmake -S . -B b --toolchain ${fromHere(`../toolchains/${VARIANT}.cmake`)}`],
        ["build", "cmake --build b -j 3"],
        ["run", "b\\t.exe"],
    ] as const) {
        if (stage === "run" && !existsSync(`${cwd}/b/t.exe`)) return results.push(`FAIL ${name}: no executable`);
        const r = await sh(cmd, cwd);
        if (r.code || (stage === "run" && !r.out.includes("OK"))) {
            const lines = r.out.split("\n"),
                hits = lines.filter((l) => /error|undefined|>>>|check failed|Could not|not found|formats:/i.test(l));
            return results.push(
                `FAIL ${name} (${stage}, exit ${r.code})\n${(hits.length ? hits.slice(0, 10) : lines.slice(-25)).join("\n").slice(0, 2500)}`,
            );
        }
        if (stage === "run")
            for (const l of r.out.split("\n")) if (l.startsWith("formats:")) results.push(`note ${name} ${l}`);
    }
    passed++;
}

await Promise.all(
    Array.from({ length: 3 }, async () => {
        while (next < selected.length) await run(selected[next++]!);
    }),
);
console.log(results.join("\n\n"));
console.log(`\ncmake ${VARIANT}: ${passed}/${selected.length} passed`);
process.exitCode = passed === selected.length ? 0 : 1;
