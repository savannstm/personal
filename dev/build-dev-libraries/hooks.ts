import $ from "dax";
import { appendFile, cp, readdir, rm, writeFile } from "node:fs/promises";

import {
    buildDir,
    buildRoot,
    DBG_ROOT,
    DEBUG_NATIVE,
    DEBUG_TOOLCHAIN,
    ICU_DATA_FILTERS,
    REL_ROOT,
    RELEASE_NATIVE,
    RELEASE_TOOLCHAIN,
    ROOT,
    WIN,
} from "./config.ts";
import { bash, raw, toMsysPath } from "./shell.ts";
import { computeFlags, toolchainState } from "./toolchain.ts";

/** Moves *.pdb from `from` to `to`; copy+delete because the build dir may sit on another device, where rename fails. */
async function movePdbs(from: string, to: string) {
    for (const file of (await readdir(from)).filter((f) => f.endsWith(".pdb"))) {
        await cp(`${from}/${file}`, `${to}/${file}`);
        await rm(`${from}/${file}`);
    }
}

function cmakeVal(isDebug: boolean): string {
    return isDebug ? "ON" : "OFF";
}

const LIBLTDL_MSVC_CONFIG = `#define HAVE_DECL_CYGWIN_CONV_PATH 0
#define HAVE_INTTYPES_H 1
#define HAVE_LIBDLLOADER 1
#define HAVE_PRELOADED_SYMBOLS 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define LTDL_DLOPEN_DEPLIBS 1
#define LT_DLSEARCH_PATH "/lib:/usr/lib"
#define LT_LIBEXT "lib"
#define LT_LIBPREFIX "lib"
#define LT_MODULE_EXT ".dll"
#define LT_MODULE_PATH_VAR "PATH"
#define LT_OBJDIR ".libs/"
#define PACKAGE "libltdl"
#define PACKAGE_BUGREPORT "bug-libtool@gnu.org"
#define PACKAGE_NAME "libltdl"
#define PACKAGE_STRING "libltdl 2.4.3a"
#define PACKAGE_TARNAME "libltdl"
#define PACKAGE_URL ""
#define PACKAGE_VERSION "2.4.3a"
#define STDC_HEADERS 1
#define VERSION "2.4.3a"
#define __error_t_defined 1
#define error_t int`;
const LIBLTDL_MINGW_CONFIG = `
#define HAVE_CLOSEDIR 1
#define HAVE_DECL_CYGWIN_CONV_PATH 0
#define HAVE_DIRENT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIBDLLOADER 1
#define HAVE_OPENDIR 1
#define HAVE_PRELOADED_SYMBOLS 1
#define HAVE_READDIR 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define LTDL_DLOPEN_DEPLIBS 1
#define LT_DLSEARCH_PATH "/lib:/usr/lib"
#define LT_LIBEXT "lib"
#define LT_LIBPREFIX "lib"
#define LT_MODULE_EXT ".dll"
#define LT_MODULE_PATH_VAR "PATH"
#define LT_OBJDIR ".libs/"
#define PACKAGE "libltdl"
#define PACKAGE_BUGREPORT "bug-libtool@gnu.org"
#define PACKAGE_NAME "libltdl"
#define PACKAGE_STRING "libltdl 2.4.3a"
#define PACKAGE_TARNAME "libltdl"
#define PACKAGE_URL ""
#define PACKAGE_VERSION "2.4.3a"
#define STDC_HEADERS 1
#define VERSION "2.4.3a"
#define __error_t_defined 1
#define error_t int`;
const LIBLTDL_LINUX_CONFIG = `
#define HAVE_ARGZ_H 1
#define HAVE_CLOSEDIR 1
#define HAVE_DIRENT_H 1
#define HAVE_DLFCN_H 1
#define HAVE_DLERROR 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIBDL 1
#define HAVE_OPENDIR 1
#define HAVE_PRELOADED_SYMBOLS 1
#define HAVE_READDIR 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define LT_DLSEARCH_PATH "/lib:/usr/lib"
#define LT_LIBEXT "so"
#define LT_LIBPREFIX "lib"
#define LT_MODULE_EXT ".so"
#define LT_MODULE_PATH_VAR "LD_LIBRARY_PATH"
#define LT_OBJDIR ".libs/"
#define PACKAGE "libltdl"
#define PACKAGE_BUGREPORT "bug-libtool@gnu.org"
#define PACKAGE_NAME "libltdl"
#define PACKAGE_STRING "libltdl 2.4.3a"
#define PACKAGE_TARNAME "libltdl"
#define PACKAGE_URL ""
#define PACKAGE_VERSION "2.4.3a"
#define STDC_HEADERS 1
#define VERSION "2.4.3a"
#define error_t int`;

async function copyLib(root: string, from: string, to: string): Promise<void> {
    await $`cp ${`${root}/lib/${from}`} ${`${root}/lib/${to}`}`;
}

async function stripDllImport(file: string): Promise<void> {
    await $`sd -s -- "__declspec(dllimport)" "" ${file}`;
}

export async function customBuild(
    name: string,
    p: string,
    isDebug: boolean,
    step: (sub: string, build: () => Promise<void>) => Promise<void>,
) {
    const table: Record<string, () => Promise<void>> = {
        bzip2: async () => {
            await buildPlain(p, isDebug, {
                defFile: "libbz2.def",
                headers: [{ dest: "bzlib.h", src: "bzlib.h" }],
                includeDirs: ["./"],
                libName: "libbz2.a",
                sources: [
                    "blocksort.c",
                    "bzlib.c",
                    "compress.c",
                    "crctable.c",
                    "decompress.c",
                    "huffman.c",
                    "randtable.c",
                ],
            });
        },
        ffmpeg: async () => {
            const { AR, CC, CFLAGS, CXX, CXXFLAGS, LDFLAGS, NM, RANLIB, STRIP, WINDRES } = process.env,
                { toolchain } = toolchainState(),
                audioCodecs =
                    "--enable-decoder=aac,ac3,alac,dca,eac3,flac,mp3float,opus,pcm_f32be,pcm_f32le,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_u8,truehd,vorbis --enable-demuxer=aac,ac3,aiff,avi,caf,dts,eac3,flac,matroska,mov,mp3,ogg,truehd,wav --enable-parser=aac,ac3,dca,flac,mlp,mpegaudio,opus,vorbis --enable-filter=aformat,alimiter,aresample,firequalizer",
                common = `--target-os=${WIN ? (toolchain === "msvc" ? "win64" : "mingw32") : "linux"} --arch=x86_64 ${toolchain === "msvc" ? "--toolchain=msvc" : ""} --stdc=gnu17 --stdcxx=gnu++23 --cc=${CC} --cxx=${CXX} --ar=${AR} --strip=${STRIP} --ld=${CC} --ranlib=${RANLIB} --nm=${NM} --windres=${WINDRES} --disable-autodetect --disable-all --enable-asm --enable-protocol=file --enable-avformat --enable-avcodec --enable-avfilter --enable-swscale --enable-swresample --extra-cflags="${CFLAGS}" --extra-ldflags="${LDFLAGS}" --extra-cxxflags="${CXXFLAGS}" --optflags="${CFLAGS}"`,
                // Only the formats nearly everything is in; the demuxers are the same as RAP's, they cost next to nothing.
                trapCodecs =
                    "--enable-decoder=aac,alac,flac,mp3float,opus,pcm_f32le,pcm_s16le,pcm_s24le,pcm_s32le,pcm_u8,vorbis --enable-demuxer=aac,aiff,avi,flac,matroska,mov,mp3,ogg,wav --enable-parser=aac,flac,mpegaudio,opus,vorbis --enable-filter=aformat,alimiter,aresample,firequalizer",
                rpgCodecs =
                    "--enable-demuxer=asf,avi,flac,matroska,mov,mp3,mpegps,ogg,wav --enable-decoder=aac,adpcm_ima_wav,adpcm_ms,flac,h264,mjpeg,mp2float,mp3float,mpeg1video,mpeg2video,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,opus,pcm_f32be,pcm_f32le,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_u8,pcm_s8,pcm_mulaw,pcm_alaw,pcm_dvd,theora,vc1,vorbis,vp8,vp9,wmav1,wmav2,wmv1,wmv2,wmv3 --enable-parser=h264,mpeg4video,mpegvideo,vc1";

            let variants;

            if (isDebug) {
                variants = [
                    { codecs: audioCodecs, isDebug, prefix: `${DBG_ROOT}/ffmpeg-rap` },
                    { codecs: trapCodecs, isDebug, prefix: `${DBG_ROOT}/ffmpeg-trap` },
                    { codecs: rpgCodecs, isDebug, prefix: `${DBG_ROOT}/ffmpeg-rpgmtranslate` },
                ];
            } else {
                variants = [
                    { codecs: audioCodecs, isDebug, prefix: `${REL_ROOT}/ffmpeg-rap` },
                    { codecs: trapCodecs, isDebug, prefix: `${REL_ROOT}/ffmpeg-trap` },
                    { codecs: rpgCodecs, isDebug, prefix: `${REL_ROOT}/ffmpeg-rpgmtranslate` },
                ];
            }

            for (const v of variants) {
                await step(v.prefix.split("/").pop()!, async () => {
                    await bash`cd ${toMsysPath(p)} && make clean`.noThrow();
                    const buildType = v.isDebug
                        ? "--disable-optimizations --enable-debug --disable-stripping"
                        : "--enable-optimizations --disable-debug --enable-stripping";
                    await buildAutoconf(p, v.isDebug, v.prefix, `${common} ${buildType} ${v.codecs}`);
                });
            }
        },
        icu: async () => {
            const sourceDir = `${p}/icu4c/source`;
            await writeFile(`${sourceDir}/filters.json`, ICU_DATA_FILTERS);
            const { toolchain } = toolchainState(),
                common = `--enable-option-checking --disable-tests --disable-samples --enable-tools --disable-icu-config --disable-extras --disable-icuio --disable-layout --disable-layoutex --disable-dyload --disable-fuzzer --disable-tracing --disable-plugins --disable-draft --with-library-suffix=""`,
                prefix = buildRoot(isDebug),
                variantArgs = isDebug
                    ? `${common} --with-data-packaging=library`
                    : `${common} --with-data-packaging=static`;
            let icuToolchain;

            if (WIN) {
                if (toolchain === "msvc") {
                    icuToolchain = "Cygwin";
                } else {
                    icuToolchain = "MinGW";
                }
            } else {
                icuToolchain = "Linux/clang";
            }

            await buildAutoconf(
                sourceDir,
                isDebug,
                prefix,
                variantArgs,
                `ICU_DATA_FILTER_FILE=filters.json CPPFLAGS="-DUCONFIG_NO_COLLATION=ON -DUCONFIG_NO_FORMATTING=ON -DUCONFIG_NO_TRANSLITERATION=ON -DUCONFIG_NO_REGULAR_EXPRESSIONS=ON -DUCONFIG_NO_SERVICE=ON -DUCONFIG_NO_IDNA=ON -DUCONFIG_NO_CONVERSION=OFF -DUCONFIG_NO_LEGACY_CONVERSION=OFF -DUCONFIG_NO_NORMALIZATION=OFF"`,
                `./runConfigureICU ${icuToolchain}`,
            );
        },
        imagemagick: async () => {
            const libRoot = buildRoot(isDebug);

            // fourier.c is patched to #include this instead of linking GPL FFTW3, and the copy has
            // to happen here rather than in prehook: buildVariants runs `git clean -fdx` per variant
            // after the prepare hooks, which would delete these as untracked files.
            await $`cp ${`${ROOT}/patches/imagemagick/pocketfft.c`} MagickCore/pocketfft.c`.cwd(p);
            await $`cp ${`${ROOT}/patches/imagemagick/pocketfft.h`} MagickCore/pocketfft.h`.cwd(p);

            for (const quantum of [8, 16]) {
                for (const hdr of ["enable", "disable"]) {
                    await step(`q${quantum}-${hdr}-hdri`, () =>
                        buildAutoconf(
                        p,
                        isDebug,
                        libRoot,
                        `--disable-dependency-tracking --disable-legacy-support ${isDebug ? "--enable-assert" : "--disable-assert"} --enable-openmp --enable-opencl --with-threads --with-quantum-depth=${quantum} --without-modules --without-utilities --disable-docs --${hdr}-hdri --disable-deprecated --without-perl --with-ltdl ` +
                            "--with-bzlib --without-fftw --with-freetype --with-heic --without-jbig --with-jpeg --with-jxl --with-lcms --with-lzma --with-openexr --with-openjp2 --with-png --with-raw --with-tiff --with-webp --with-xml --with-zip --with-zlib --with-zstd --without-autotrace --without-djvu --without-dps --without-flif --without-fpx --without-fontconfig --without-gslib --without-gvc --without-dmr --without-lqr --without-pango --without-raqm --without-rsvg --with-uhdr --without-wmf --without-x --without-gdi32",
                    ));
                }
            }
        },
        libraw: async () => {
            if (!WIN) {
                await $`chmod +x configure`.cwd(p);
            }

            await buildAutoconf(
                p,
                isDebug,
                buildRoot(isDebug),
                `--enable-openmp --enable-jpeg --enable-zlib --enable-lcms --disable-examples`,
                `CPPFLAGS="${isDebug ? "-DLIBRAW_BUILDLIB" : "-DLIBRAW_NODLL"}"`,
            );
        },
        libtool: async () => {
            p = `${p}/libltdl`;

            await cp(`${p}/libltdl/lt__argz_.h`, `${p}/lt__argz.h`);

            const { toolchain } = toolchainState(),
                CONFIG = WIN
                    ? toolchain === "msvc"
                        ? LIBLTDL_MSVC_CONFIG
                        : LIBLTDL_MINGW_CONFIG
                    : LIBLTDL_LINUX_CONFIG;
            await writeFile(`${p}/config.h`, CONFIG);

            const loaderSrc = WIN ? "loaders/loadlibrary.c" : "loaders/dlopen.c";

            await buildPlain(p, isDebug, {
                defines: ["HAVE_CONFIG_H", "LTDL", isDebug ? "DLL_EXPORT" : "LTDL", "LT_DEBUG_LOADERS"],
                headers: [
                    { dest: "ltdl.h", src: "ltdl.h" },
                    { dest: "libltdl/lt_dlloader.h", src: "libltdl/lt_dlloader.h" },
                    { dest: "libltdl/lt_error.h", src: "libltdl/lt_error.h" },
                    { dest: "libltdl/lt_system.h", src: "libltdl/lt_system.h" },
                ],
                includeDirs: ["./", "./libltdl", "./loaders"],
                libName: "libltdl.a",
                sources: [
                    "ltdl.c",
                    "lt_error.c",
                    "lt_dlloader.c",
                    "lt__alloc.c",
                    "lt__strl.c",
                    "lt__argz.c",
                    toolchain === "msvc" ? "lt__dirent.c" : "",
                    "slist.c",
                    "loaders/preopen.c",
                    loaderSrc,
                ],
            });
        },
        qt5: async () => {
            const submodules = ["qtbase", "qtimageformats", "qttools", "qtsvg"],
                common = `-no-guess-compiler -cmake-generator Ninja -c++std c++23 -gui -widgets -submodules ${submodules.join(",")} -pch -qpa "${WIN ? "windows" : "xcb;wayland"}" ${toolchainState().toolchain === "msvc" ? "" : "-reduce-exports"} -disable-deprecated-up-to 0x060213 -nomake tests -nomake examples -nomake benchmarks -nomake manual-tests -nomake minimal-static-tests -nomake doc-snippets  -no-emojisegmenter -no-appstore-compliant -no-sbom -no-sbom-json -no-sbom-verify -no-system-proxies -no-mimetype-database -no-icu -no-gif -no-dbus ${WIN ? "-ssl -schannel -no-openssl" : "-no-ssl -no-openssl -no-schannel"} -no-libb2 -system-harfbuzz -system-freetype -system-libpng -system-libjpeg -system-webp -system-zlib -system-doubleconversion -system-pcre -system-libmd4c -no-tiff -no-jasper -no-mng -no-zstd ${!WIN ? "-no-glib -no-evdev -no-mtdev -no-tslib -no-eglfs -no-linuxfb -no-gtk -xcb-xlib -libudev -libinput -opengl -egl" : "-opengl desktop -no-egl"}`,
                featureToggles = `-feature-accessibility -feature-animation -feature-calendarwidget -feature-cborstreamreader -feature-cborstreamwriter -feature-datetimeedit -feature-datetimeparser -feature-designer -feature-dom -feature-draganddrop -feature-imageformat_jpeg -feature-imageformat_png -feature-imageformat_xpm -no-feature-linguist -feature-rubberband -feature-style-stylesheet ${WIN ? "-feature-style-windows -feature-style-windows11 -feature-style-windowsvista" : ""} -feature-texthtmlparser -feature-textmarkdownreader -feature-wizard -no-feature-androiddeployqt -no-feature-appstore-compliant -no-feature-assistant -no-feature-brotli -no-feature-distancefieldgenerator -no-feature-dnslookup -no-feature-dtls -no-feature-effects -no-feature-emojisegmenter -no-feature-fullqthelp -no-feature-gestures -no-feature-gssapi -no-feature-hijricalendar -no-feature-imageformat_bmp -no-feature-imageformat_ppm -no-feature-imageformat_xbm -no-feature-islamiccivilcalendar -no-feature-jalalicalendar -no-feature-kmap2qmap -no-feature-macdeployqt -no-feature-movie -no-feature-ocsp -no-feature-openssl-hash -no-feature-pdf -no-feature-pixeltool -no-feature-printsupport -no-feature-qdbus -no-feature-qdoc -no-feature-qdoc_coverage -no-feature-qmake -no-feature-qtattributionsscanner -no-feature-qtdiag -no-feature-qtplugininfo -no-feature-sessionmanager -no-feature-socks5 -no-feature-splashscreen -no-feature-sql -no-feature-sspi -no-feature-tabletevent -no-feature-testlib -no-feature-textmarkdownwriter -no-feature-textodfwriter -no-feature-timezone -no-feature-timezone_locale -no-feature-timezone_tzdb -no-feature-topleveldomain -no-feature-tuiotouch -no-feature-udpsocket -no-feature-wasm-exceptions -no-feature-wasm-jspi -no-feature-wasm-simd128 -no-feature-wasmdeployqt -no-feature-windeployqt ${!WIN ? "-no-feature-wayland-client-wl-shell -no-feature-liburing -no-feature-xlib -feature-system-xcb-xinput -no-feature-vnc" : ""}`;

            await $`git submodule update --init --depth 1 ${submodules}`.cwd(p);
            await $`git submodule update --init --recursive --depth 1`.cwd(`${p}/qttools`);

            if (isDebug) {
                if (toolchainState().toolchain === "msvc") {
                    await $`sd -s "add_dependencies(Core qmodule_pri)" ${`add_dependencies(Core qmodule_pri)\ntarget_link_options(Core PRIVATE "-Wl,-FORCE:UNRESOLVED")`} qtbase/src/corelib/CMakeLists.txt`.cwd(
                        p,
                    );

                    // await $`sd -s "asm.v2" "asm.v3" qtbase/src/corelib/Qt6CoreMacros.cmake`.cwd(p);
                    //! Qt 6.12 finally uses asm.v3
                }

                await $`./configure${raw(WIN ? ".bat" : "")} ${raw(common)} -debug -sanitize address -no-static -no-static-runtime ${raw(featureToggles)} -- -B=debug -DCMAKE_TOOLCHAIN_FILE=${DEBUG_TOOLCHAIN} -DQT_USE_DEFAULT_CMAKE_OPTIMIZATION_FLAGS=ON`.cwd(
                    p,
                );
                await $`cmake --build debug -j`.cwd(p);
                await $`cmake --install debug`.cwd(p);
            } else {
                await $`./configure${raw(WIN ? ".bat" : "")} ${raw(common)} -release -static -static-runtime ${raw(featureToggles)} -- -B=release -DCMAKE_TOOLCHAIN_FILE=${RELEASE_TOOLCHAIN} -DQT_USE_DEFAULT_CMAKE_OPTIMIZATION_FLAGS=ON`.cwd(
                    p,
                );
                await $`cmake --build release -j`.cwd(p);
                await $`cmake --install release`.cwd(p);
            }
        },
    };

    if (table[name]) {
        await table[name]();
    }
}

export function arghook(name: string, isDebug: boolean) {
    const table: Record<string, string> = {
        brotli: `-DBROTLI_EMSCRIPTEN=OFF -DBROTLI_BUILD_TOOLS=OFF`,
        dav1d: "-Denable_asm=true -Denable_tools=false -Denable_examples=false -Denable_tests=false -Denable_seek_stress=false -Denable_docs=false -Dlogging=false -Dtestdata_tests=false -Dfuzzing_engine=none -Dtrim_dsp=true",
        fltk: `-DFLTK_BUILD_SHARED_LIBS=OFF -DFLTK_USE_SYSTEM_ZLIB=ON -DFLTK_USE_SYSTEM_LIBPNG=ON -DFLTK_USE_SYSTEM_LIBJPEG=ON -DFLTK_OPTION_SVG=OFF -DFLTK_BUILD_FLUID=OFF -DFLTK_BUILD_FLTK_OPTIONS=OFF -DFLTK_BUILD_GL=ON -DFLTK_BUILD_FORMS=OFF -DFLTK_BUILD_TEST=OFF -DFLTK_BUILD_HTML_DOCS=OFF -DFLTK_OPTION_PEN_SUPPORT=OFF -DFLTK_OPTION_LARGE_FILE=OFF -DFLTK_OPTION_PRINT_SUPPORT=OFF -DFLTK_OPTION_FILESYSTEM_SUPPORT=OFF -DFLTK_OPTION_STD=OFF -DFLTK_GRAPHICS_GDIPLUS=OFF -DFLTK_MSVC_RUNTIME_DLL=${cmakeVal(isDebug)}`,
        freetype: `-DFT_DISABLE_ZLIB=OFF -DFT_REQUIRE_ZLIB=ON -DFT_DISABLE_BZIP2=OFF -DFT_REQUIRE_BZIP2=ON -DFT_DISABLE_PNG=OFF -DFT_REQUIRE_PNG=ON -DFT_DISABLE_HARFBUZZ=ON -DFT_DYNAMIC_HARFBUZZ=OFF -DFT_REQUIRE_HARFBUZZ=OFF -DFT_DISABLE_BROTLI=ON -DFT_REQUIRE_BROTLI=OFF -DDISABLE_FORCE_DEBUG_POSTFIX=ON`,
        glaze: "-Dglaze_ENABLE_FUZZING=OFF -Dglaze_DEVELOPER_MODE=OFF",
        glfw: `-DGLFW_BUILD_EXAMPLES=OFF -DGLFW_BUILD_TESTS=OFF -DGLFW_BUILD_DOCS=OFF -DGLFW_INSTALL=ON -DGLFW_LIBRARY_TYPE=${isDebug ? "SHARED" : "STATIC"}`,
        googletest: "-DBUILD_GMOCK=OFF",
        harfbuzz: `-DHB_BUILD_UTILS=OFF -DHB_BUILD_RASTER=OFF -DHB_BUILD_VECTOR=OFF -DHB_BUILD_GPU=OFF -DHB_BUILD_TESTS=OFF -DHB_HAVE_CAIRO=OFF -DHB_HAVE_FREETYPE=ON -DHB_HAVE_GRAPHITE2=OFF -DHB_HAVE_GLIB=OFF -DHB_HAVE_ICU=OFF -DHB_HAVE_UNISCRIBE=OFF -DHB_HAVE_GDI=OFF -DHB_HAVE_DIRECTWRITE=ON -DHB_HAVE_GOBJECT=OFF -DHB_HAVE_INTROSPECTION=OFF`,
        highway: `-DHWY_ENABLE_CONTRIB=OFF -DHWY_ENABLE_EXAMPLES=OFF -DHWY_ENABLE_TESTS=OFF -DHWY_FORCE_STATIC_LIBS=${cmakeVal(!isDebug)}`,
        imath: `-DPYTHON=OFF -DPYBIND11=OFF -DBUILD_WEBSITE=OFF -DIMATH_HALF_USE_LOOKUP_TABLE=ON -DIMATH_USE_DEFAULT_VISIBILITY=OFF -DIMATH_ENABLE_LARGE_STACK=OFF -DIMATH_USE_NOEXCEPT=OFF -DIMATH_INSTALL_PKG_CONFIG=ON`,
        kvazaar: "-DBUILD_TESTS=OFF -DUSE_CRYPTO=OFF -DBUILD_KVAZAAR_BINARY=OFF",
        lcms2: `-DLCMS2_BUILD_TOOLS=OFF -DLCMS2_BUILD_TESTS=OFF -DLCMS2_BUILD_JPGICC=OFF -DLCMS2_BUILD_TIFICC=OFF -DLCMS2_BUILD_TIFDIFF=OFF -DLCMS2_BUILD_SHARED=${cmakeVal(isDebug)} -DLCMS2_BUILD_STATIC=${cmakeVal(!isDebug)}`,
        libarchive: `-DENABLE_MBEDTLS=OFF -DENABLE_NETTLE=OFF -DENABLE_OPENSSL=OFF -DENABLE_LIBB2=OFF -DENABLE_LZ4=OFF -DENABLE_LZO=OFF -DENABLE_LZMA=ON -DENABLE_ZSTD=OFF -DENABLE_ZLIB=OFF -DENABLE_BZip2=OFF -DENABLE_LIBXML2=OFF -DENABLE_EXPAT=OFF -DENABLE_WIN32_XMLLITE=OFF -DENABLE_PCREPOSIX=OFF -DENABLE_PCRE2POSIX=OFF -DENABLE_LIBGCC=OFF -DENABLE_CNG=ON -DENABLE_TAR=OFF -DENABLE_CPIO=OFF -DENABLE_CAT=OFF -DENABLE_UNZIP=OFF -DENABLE_XATTR=OFF -DENABLE_ACL=OFF -DENABLE_ICONV=OFF -DENABLE_TEST=OFF -DENABLE_COVERAGE=OFF -DENABLE_WERROR=OFF -DPOSIX_REGEX_LIB=NONE`,
        libde265: `-DUSE_IWYU=OFF -DENABLE_SDL=OFF -DENABLE_SIMD=ON -DENABLE_AVX2=ON -DENABLE_AVX512=OFF -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF -DENABLE_SHERLOCK265=OFF -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=OFF -DWITH_FUZZERS=OFF -DFORCE_FULL_VISIBILITY=OFF`,
        libdeflate: `-DLIBDEFLATE_COMPRESSION_SUPPORT=ON -DLIBDEFLATE_DECOMPRESSION_SUPPORT=ON -DLIBDEFLATE_ZLIB_SUPPORT=ON -DLIBDEFLATE_GZIP_SUPPORT=OFF -DLIBDEFLATE_BUILD_GZIP=OFF -DLIBDEFLATE_BUILD_TESTS=OFF -DLIBDEFLATE_BUILD_STATIC_LIB=${cmakeVal(!isDebug)} -DLIBDEFLATE_BUILD_SHARED_LIB=${cmakeVal(isDebug)}`,
        libgit2: `-DBUILD_CLI=OFF -DBUILD_FUZZERS=OFF -DUSE_THREADS=ON -DUSE_NSEC=ON -DUSE_SSH=OFF -DUSE_HTTPS=ON -DREGEX_BACKEND=pcre2 -DDEPRECATE_HARD=ON`,
        libheif: `-DWITH_EXAMPLES=OFF -DWITH_EXAMPLE_HEIF_THUMB=OFF -DWITH_EXAMPLE_HEIF_VIEW=OFF -DWITH_GDK_PIXBUF=OFF -DENABLE_PLUGIN_LOADING=OFF -DWITH_LIBDE265=ON -DWITH_X265=OFF -DWITH_KVAZAAR=ON -DWITH_UVG266=OFF -DWITH_VVDEC=OFF -DWITH_VVENC=OFF -DWITH_X264=OFF -DWITH_OpenH264_DECODER=ON -DWITH_DAV1D=ON -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF -DWITH_SvtEnc=OFF -DWITH_RAV1E=ON -DWITH_JPEG_DECODER=ON -DWITH_JPEG_ENCODER=OFF -DWITH_OpenJPEG_ENCODER=OFF -DWITH_OpenJPEG_DECODER=ON -DWITH_FFMPEG_DECODER=OFF -DWITH_OPENJPH_ENCODER=OFF -DWITH_UNCOMPRESSED_CODEC=OFF -DWITH_WEBCODECS=OFF -DWITH_LIBSHARPYUV=ON -DBUILD_DOCUMENTATION=OFF`,
        "libjpeg-turbo": `-DWITH_ARITH_DEC=ON -DWITH_ARITH_ENC=ON -DWITH_JAVA=OFF -DWITH_JPEG7=OFF -DWITH_JPEG8=OFF -DWITH_SIMD=ON -DWITH_TURBOJPEG=ON -DWITH_TOOLS=OFF -DWITH_TESTS=OFF -DWITH_FUZZ=OFF -DFORCE_INLINE=ON -DENABLE_SHARED=${cmakeVal(isDebug)} -DENABLE_STATIC=${cmakeVal(!isDebug)} -DWITH_SYSTEM_SPNG=ON -DWITH_SYSTEM_ZLIB=ON`,
        libjxl: `-DJPEGXL_ENABLE_FUZZERS=OFF -DJPEGXL_ENABLE_DEVTOOLS=OFF -DJPEGXL_ENABLE_TESTS=OFF -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_MANPAGES=OFF -DJPEGXL_ENABLE_BENCHMARK=OFF -DJPEGXL_ENABLE_EXAMPLES=OFF -DJPEGXL_BUNDLE_LIBPNG=OFF -DJPEGXL_ENABLE_JNI=OFF -DJPEGXL_ENABLE_SJPEG=OFF -DJPEGXL_ENABLE_OPENEXR=ON -DJPEGXL_ENABLE_SKCMS=OFF -DJPEGXL_ENABLE_VIEWERS=OFF -DJPEGXL_ENABLE_TCMALLOC=OFF -DJPEGXL_ENABLE_PLUGINS=OFF -DJPEGXL_ENABLE_COVERAGE=OFF -DJPEGXL_ENABLE_TRANSCODE_JPEG=ON -DJPEGXL_ENABLE_BOXES=ON -DJPEGXL_WARNINGS_AS_ERRORS=OFF -DJPEGXL_TEST_TOOLS=OFF -DJPEGXL_ENABLE_WASM_THREADS=OFF -DJPEGXL_FORCE_SYSTEM_BROTLI=ON -DJPEGXL_FORCE_SYSTEM_GTEST=ON -DJPEGXL_FORCE_SYSTEM_LCMS2=ON -DJPEGXL_FORCE_SYSTEM_HWY=ON -DJPEGXL_STATIC=${cmakeVal(!isDebug)}`,
        libpng: `-DPNG_TESTS=OFF -DPNG_TOOLS=OFF -DPNG_EXECUTABLES=OFF -DPNG_HARDWARE_OPTIMIZATIONS=ON -DPNG_BUILD_ZLIB=OFF -DPNG_SHARED=${cmakeVal(isDebug)} -DPNG_STATIC=${cmakeVal(!isDebug)} -DPNG_DEBUG_POSTFIX=""`,
        libspng: `-DENABLE_OPT=ON -DSPNG_SHARED=${cmakeVal(isDebug)} -DSPNG_STATIC=${cmakeVal(!isDebug)}`,
        libtiff: `-Dtiff-tools=OFF -Dtiff-tests=OFF -Dtiff-contrib=OFF -Dtiff-docs=OFF -Dtiff-deprecated=OFF -Dtiff-static=${cmakeVal(!isDebug)} -Dlerc=OFF -Djbig=OFF -DTIFF_STATIC_LIBS_DEFAULT=${cmakeVal(!isDebug)}`,
        libultrahdr: `-DUHDR_BUILD_EXAMPLES=OFF -DUHDR_ENABLE_INTRINSICS=ON -DUHDR_ENABLE_GLES=ON -DUHDR_ENABLE_HEIF=OFF`,
        libwebp: `-DWEBP_ENABLE_SIMD=ON -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_LIBWEBPMUX=ON -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF -DWEBP_BUILD_FUZZTEST=OFF -DWEBP_USE_THREAD=ON -DWEBP_NEAR_LOSSLESS=ON -DWEBP_ENABLE_SWAP_16BIT_CSP=OFF -DWEBP_ENABLE_WUNUSED_RESULT=OFF -DWEBP_BUILD_WEBP_JS=OFF -DWEBP_UNICODE=OFF -DWEBP_LINK_STATIC=${cmakeVal(!isDebug)}`,
        libxml2: `-DLIBXML2_WITH_CATALOG=OFF -DLIBXML2_WITH_DEBUG=OFF -DLIBXML2_WITH_DOCS=OFF -DLIBXML2_WITH_HTML=OFF -DLIBXML2_WITH_HTTP=OFF -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_ICU=OFF -DLIBXML2_WITH_ISO8859X=ON -DLIBXML2_WITH_LEGACY=OFF -DLIBXML2_WITH_MODULES=OFF -DLIBXML2_WITH_OUTPUT=ON -DLIBXML2_WITH_PATTERN=OFF -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_PUSH=ON -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_READLINE=OFF -DLIBXML2_WITH_REGEXPS=OFF -DLIBXML2_WITH_SAX1=ON -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_TLS=OFF -DLIBXML2_WITH_VALID=OFF -DLIBXML2_WITH_XINCLUDE=OFF -DLIBXML2_WITH_XPATH=OFF -DLIBXML2_WITH_ZLIB=ON -DLIBXML2_WITH_C14N=OFF -DLIBXML2_WITH_HISTORY=OFF -DLIBXML2_WITH_READER=ON -DLIBXML2_WITH_SCHEMAS=OFF -DLIBXML2_WITH_SCHEMATRON=OFF -DLIBXML2_WITH_THREAD_ALLOC=ON -DLIBXML2_WITH_WRITER=ON -DLIBXML2_WITH_XPTR=OFF -DLIBXML2_WITH_RELAXNG=OFF -DLIBXML2_WITH_THREADS=ON`,
        libzip: `-DENABLE_COMMONCRYPTO=OFF -DENABLE_GNUTLS=OFF -DENABLE_MBEDTLS=OFF -DENABLE_OPENSSL=OFF -DENABLE_WINDOWS_CRYPTO=OFF -DENABLE_BZIP2=ON -DENABLE_LZMA=ON -DENABLE_ZSTD=ON -DENABLE_FDOPEN=ON -DBUILD_REGRESS=OFF -DBUILD_OSSFUZZ=OFF`,
        md4c: "-DBUILD_MD2HTML_EXECUTABLE=OFF",
        mesa: `-Dplatforms=windows -Degl=enabled -Degl-native-platform=surfaceless -Dgles1=disabled -Dgles2=enabled -Dopengl=true -Dglx=disabled -Dgallium-drivers=d3d12 -Dgallium-d3d12-graphics=enabled -Dgallium-d3d12-video=disabled -Dvulkan-drivers= -Dllvm=disabled -Dshader-cache=disabled -Dxmlconfig=disabled -Dexpat=disabled -Dzlib=disabled -Dzstd=disabled -Dvalgrind=disabled -Dlibunwind=disabled -Dlmsensors=disabled -Ddisplay-info=disabled -Dmicrosoft-clc=disabled -Dspirv-to-dxil=false -Dbuild-tests=false -Dhtml-docs=disabled -Dmin-windows-version=10 -Dvideo-codecs=`,
        mimalloc: `-DMI_OPT_ARCH=ON -DMI_OPT_SIMD=ON -DMI_SECURE=${cmakeVal(isDebug)} -DMI_SECURE_FULL=${cmakeVal(isDebug)} -DMI_OVERRIDE=ON -DMI_XMALLOC=OFF -DMI_SHOW_ERRORS=${cmakeVal(isDebug)} -DMI_GUARDED=${cmakeVal(isDebug)} -DMI_FREE_IS_CHECKED=${cmakeVal(isDebug)} -DMI_DEBUG=${cmakeVal(isDebug)} -DMI_DEBUG_INTERNAL=${cmakeVal(isDebug)} -DMI_BUILD_SHARED=${cmakeVal(isDebug)} -DMI_BUILD_STATIC=${cmakeVal(!isDebug)} -DMI_BUILD_OBJECT=OFF -DMI_BUILD_TESTS=OFF`,
        "opencl-headers": `-DOPENCL_HEADERS_BUILD_TESTING=OFF -DOPENCL_HEADERS_BUILD_CXX_TESTS=OFF`,
        "opencl-icd": `-DOPENCL_ICD_LOADER_BUILD_TESTING=OFF -DENABLE_OPENCL_LAYERINFO=OFF`,
        openexr: `-DOPENEXR_INSTALL_DOCS=OFF -DBUILD_WEBSITE=OFF -DOPENEXR_ENABLE_THREADING=ON -DOPENEXR_USE_TBB=OFF -DOPENEXR_USE_DEFAULT_VISIBILITY=OFF -DOPENEXR_ENABLE_LARGE_STACK=OFF -DOPENEXR_BUILD_TOOLS=OFF -DOPENEXR_INSTALL_TOOLS=OFF -DOPENEXR_INSTALL_DEVELOPER_TOOLS=OFF -DOPENEXR_BUILD_EXAMPLES=OFF -DOPENEXR_BUILD_PYTHON=OFF -DOPENEXR_BUILD_OSS_FUZZ=OFF -DOPENEXR_TEST_LIBRARIES=OFF -DOPENEXR_TEST_TOOLS=OFF -DOPENEXR_TEST_PYTHON=OFF -DOPENEXR_USE_CLANG_TIDY=OFF -DOPENEXR_FORCE_INTERNAL_DEFLATE=OFF -DOPENEXR_FORCE_INTERNAL_OPENJPH=OFF -DOPENEXR_FORCE_INTERNAL_IMATH=OFF -DOPENEXR_INSTALL_PKG_CONFIG=ON`,
        openh264: "-Dtests=disabled",
        openjpeg: `-DBUILD_LUTS_GENERATOR=OFF -DBUILD_UNIT_TESTS=OFF -DBUILD_CODEC=OFF -DBUILD_JPIP=OFF -DBUILD_VIEWER=OFF -DBUILD_JAVA=OFF -DBUILD_STATIC_LIBS=${cmakeVal(!isDebug)}`,
        openjph: `-DOJPH_ENABLE_TIFF_SUPPORT=OFF -DOJPH_DISABLE_AVX512=ON -DOJPH_BUILD_EXECUTABLES=OFF`,
        pcre2: `-DPCRE2_BUILD_PCRE2_8=ON -DPCRE2_BUILD_PCRE2_16=ON -DPCRE2_BUILD_PCRE2_32=OFF -DPCRE2_STATIC_PIC=OFF -DPCRE2_DEBUG=OFF -DPCRE2_DISABLE_PERCENT_ZT=ON -DPCRE2_EBCDIC=OFF -DPCRE2_EBCDIC_NL25=OFF -DPCRE2_EBCDIC_IGNORING_COMPILER=OFF -DPCRE2_REBUILD_CHARTABLES=OFF -DPCRE2_NEWLINE=LF -DPCRE2_SUPPORT_JIT=ON -DPCRE2_BUILD_PCRE2GREP=OFF -DPCRE2_BUILD_TESTS=OFF -DPCRE2_SUPPORT_BSR_ANYCRLF=ON -DPCRE2_SUPPORT_UNICODE=ON -DPCRE2GREP_SUPPORT_JIT=OFF -DPCRE2GREP_SUPPORT_CALLOUT=OFF -DPCRE2GREP_SUPPORT_CALLOUT_FORK=OFF -DBUILD_STATIC_LIBS=${cmakeVal(!isDebug)} -DLIB_POSTFIX=""`,
        projectm: "-DENABLE_DEBUG_POSTFIX=OFF -DENABLE_PLAYLIST=OFF",
        quickjs: `-DQJS_ENABLE_ASAN=OFF`,
        rav1e: "--features capi,asm,threading",
        xz: `-DXZ_NLS=OFF -DXZ_SMALL=OFF -DXZ_TOOL_XZDEC=OFF -DXZ_TOOL_LZMADEC=OFF -DXZ_TOOL_LZMAINFO=OFF -DXZ_TOOL_XZ=OFF -DXZ_DOC=OFF`,
        "zlib-ng": `-DWITH_GTEST=OFF -DWITH_FUZZERS=OFF -DWITH_BENCHMARKS=OFF -DWITH_BENCHMARK_APPS=OFF -DWITH_GZFILEOP=OFF -DZLIB_COMPAT=ON -DZLIB_ALIASES=ON -DWITH_OPTIM=ON -DWITH_ALL_FALLBACKS=OFF -DWITH_REDUCED_MEM=OFF -DWITH_NEW_STRATEGIES=ON -DWITH_CRC32_CHORBA=ON -DWITH_NATIVE_INSTRUCTIONS=OFF -DWITH_MAINTAINER_WARNINGS=OFF -DWITH_CODE_COVERAGE=OFF -DWITH_INFLATE_STRICT=OFF -DWITH_INFLATE_ALLOW_INVALID_DIST=OFF -DINSTALL_UTILS=OFF`,
        zstd: `-DZSTD_LEGACY_SUPPORT=ON -DZSTD_MULTITHREAD_SUPPORT=ON -DZSTD_BUILD_PROGRAMS=OFF -DZSTD_BUILD_CONTRIB=OFF -DZSTD_BUILD_TESTS=OFF -DZSTD_BUILD_STATIC=${cmakeVal(!isDebug)} -DZSTD_BUILD_SHARED=${cmakeVal(isDebug)} -DZSTD_USE_STATIC_RUNTIME=${cmakeVal(!isDebug)}`,
    };
    return table[name] ?? "";
}

/**
 * Runs right after one variant (debug or release) was built, so the in-tree build artifacts of that variant
 * (e.g. PDBs) still exist: buildVariants wipes the tree with `git clean -fdx` before the next variant.
 */
export async function posthook(name: string, path: string, isDebug: boolean) {
    const root = buildRoot(isDebug),
        { toolchain, useCodeview } = toolchainState(),
        msvc = toolchain === "msvc";

    const table: Record<string, () => Promise<void>> = {
        dav1d: async () => {
            if (WIN && !isDebug && msvc) {
                await copyLib(root, "libdav1d.a", "dav1d.lib");
            }
        },
        fltk: async () => {
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/FL/Fl_Export.H`);
            }
        },
        icu: async () => {
            if (!WIN) {
                return;
            }

            if (msvc) {
                if (isDebug) {
                    if (useCodeview) {
                        await movePdbs(`${path}/icu4c/source/bin`, `${root}/bin`);
                        await movePdbs(`${path}/icu4c/source/lib`, `${root}/bin`);
                    }
                } else {
                    await $`mv ${`${root}/bin/icudt.lib`} ${`${root}/lib/icudt.lib`}`;
                }

                for (const lib of ["icudt", "icuuc", "icuin", "icutest", "icutu"]) {
                    await $`mv ${`${root}/lib/${lib}.lib`} ${`${root}/lib/c${lib}.lib`}`;
                }
            } else if (!isDebug) {
                await $`mv ${`${root}/bin/libicudt.a`} ${`${root}/lib/libicudt.a`}`;
            }

            if (!isDebug) {
                await stripDllImport(`${root}/include/unicode/platform.h`);
            }
        },
        imagemagick: async () => {
            if (isDebug && msvc) {
                if (useCodeview) {
                    await movePdbs(`${path}/MagickCore/.libs`, `${root}/bin`);
                    await movePdbs(`${path}/MagickWand/.libs`, `${root}/bin`);
                    await movePdbs(`${path}/Magick++/lib/.libs`, `${root}/bin`);
                }

                for (const variant of ["Q8", "Q8HDRI", "Q16", "Q16HDRI"]) {
                    for (const lib of ["Magick++", "MagickCore", "MagickWand"]) {
                        await copyLib(root, `${lib}-7.${variant}.dll.lib`, `${lib}-7.${variant}.lib`);
                    }
                }
            }
        },
        imath: async () => {
            if (WIN && !msvc && isDebug) {
                await $`sd -s "/// @cond Doxygen_Suppress" "/*" ${`${root}/include/Imath/ImathVec.h`}`;
                await $`sd -s "/// @endcond Doxygen_Suppress" "*/" ${`${root}/include/Imath/ImathVec.h`}`;
            }
        },
        kvazaar: async () => {
            if (WIN && !isDebug && msvc) {
                await stripDllImport(`${root}/include/kvazaar.h`);
            }
        },
        libarchive: async () => {
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/archive.h`);
                await stripDllImport(`${root}/include/archive_entry.h`);
            }
        },
        libde265: async () => {
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/libde265/de265.h`);
            }
        },
        libheif: async () => {
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/libheif/heif_export.h`);
            }
        },
        "libjpeg-turbo": async () => {
            if (msvc && !isDebug) {
                await copyLib(root, "jpeg-static.lib", "jpeg.lib");
            }
        },
        libjxl: async () => {
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/jxl/jxl_export.h`);
            }
        },
        libpng: async () => {
            if (!WIN) {
                return;
            }

            if (isDebug) {
                await (msvc
                    ? copyLib(root, "libpng16.lib", "png16.lib")
                    : copyLib(root, "libpng16.dll.a", "libpng.dll.a"));
            } else if (msvc) {
                await copyLib(root, "libpng.lib", "png16.lib");
            }
        },
        libraw: async () => {
            if (isDebug && msvc) {
                if (useCodeview) {
                    await movePdbs(`${path}/lib/.libs`, `${root}/bin`);
                }

                await copyLib(root, "raw.dll.lib", "raw.lib");
                await copyLib(root, "raw_r.dll.lib", "raw_r.lib");
            }

            await $`sd -s -- "-lstdc++" "" ${`${root}/lib/pkgconfig/libraw.pc`}`;
            await $`sd -s -- "-lstdc++" "" ${`${root}/lib/pkgconfig/libraw_r.pc`}`;

            if (!isDebug) {
                await stripDllImport(`${root}/include/libraw/libraw_types.h`);
            }
        },
        libspng: async () => {
            await $`sd -s -- "find_dependency(ZLIB REQUIRED)" "include(CMakeFindDependencyMacro)\nfind_dependency(ZLIB REQUIRED)" ${`${root}/lib/cmake/spng/SPNGConfig.cmake`}`;
        },
        libtool: async () => {
            if (WIN && isDebug) {
                await $`sd -s -- "defined LIBLTDL_DLL_IMPORT" "1" ${`${root}/include/libltdl/lt_system.h`}`;
            }
        },
        libxml2: async () => {
            if (msvc) {
                await copyLib(root, "libxml2.lib", "xml2.lib");
            }
        },
        "opencl-icd": async () => {
            if (WIN && !isDebug && !msvc) {
                await copyLib(root, "OpenCL.a", "libOpenCL.a");
            }
        },
        openh264: async () => {
            if (WIN && !isDebug && msvc) {
                await copyLib(root, "libopenh264.a", "openh264.lib");
            }
        },
        openjpeg: async () => {
            if (WIN && !isDebug && msvc) {
                await stripDllImport(`${root}/include/openjpeg-2.5/openjpeg.h`);
            }
        },
        pcre2: async () => {
            if (!isDebug) {
                if (WIN) {
                    await stripDllImport(`${root}/include/pcre2.h`);
                    await $`sd -s -- "STATIC IMPORTED" "STATIC IMPORTED GLOBAL" ${`${root}/lib/cmake/pcre2/pcre2-targets.cmake`}`;
                }
                return;
            }

            // for libgit2
            if (msvc) {
                await copyLib(root, "pcre2-8d.lib", "pcre2-8.lib");
                await copyLib(root, "pcre2-16d.lib", "pcre2-16.lib");
                await copyLib(root, "pcre2-posixd.lib", "pcre2-posix.lib");
            } else {
                await copyLib(root, "libpcre2-8d.dll.a", "libpcre2-8.dll.a");
                await copyLib(root, "libpcre2-16d.dll.a", "libpcre2-16.dll.a");
                await copyLib(root, "libpcre2-posixd.dll.a", "libpcre2-posix.dll.a");
            }
        },
        rav1e: async () => {
            if (isDebug && msvc) {
                await $`mv ${`${root}/lib/rav1e.dll.lib`} ${`${root}/lib/rav1e.lib`}`;
            }
        },
        xz: async () => {
            if (WIN && !isDebug) {
                await stripDllImport(`${root}/include/lzma.h`);
            }
        },
        "zlib-ng": async () => {
            if (WIN && isDebug) {
                await (msvc ? copyLib(root, "zlib.lib", "z.lib") : copyLib(root, "libzlib.dll.a", "libz.dll.a"));
            }
        },
    };
    if (table[name]) {
        await table[name]();
    }
}

export async function prehook(name: string, path: string) {
    const table: Record<string, () => Promise<void>> = {
        bzip2: async () => {
            if (toolchainState().toolchain === "msvc") {
                await $`sd "DESCRIPTION.+" "" libbz2.def`.cwd(path);
                // LIBRARY sets the DLL name recorded in the import lib; upstream's LIBBZ2 makes consumers load LIBBZ2.dll.
                await $`sd "LIBRARY.+" "LIBRARY bz2" libbz2.def`.cwd(path);
            }
        },
        "double-conversion": async () => {
            await $`sd -s "if(BUILD_SHARED_LIBS AND MSVC)" "if(BUILD_SHARED_LIBS AND (MSVC OR (CMAKE_CXX_SIMULATE_ID STREQUAL "MSVC")))" CMakeLists.txt`.cwd(
                path,
            );
        },
        ffmpeg: async () => {
            // Upstream 9.0 treats any lld-link "ignoring unknown argument" warning as a
            // hard failure in test_ld, which kills the compiler sanity check outright
            // for any -Wl,* flag the local LLD doesn't recognize. Revert to exit-code-only.
            await $`sd -s -- ${`test $ret -eq 0 && ! echo "$output" | grep -qE 'LNK4044|lld-link: warning: ignoring unknown argument'`} ${"test $ret -eq 0"} configure`.cwd(
                path,
            );

            // mlpdsp_init.c defines the ff_mlp_firorder_*/ff_mlp_iirorder_* jump labels inside an inline-asm block and
            // references them from C. With -flto=full the C reference becomes an undefined external in the bitcode and
            // the labels only exist as local symbols after late codegen, so linking against avcodec.lib fails with
            // "undefined symbol: ff_mlp_firorder_*" unless /FORCE:UNRESOLVED is passed. Building this one object
            // without LTO keeps the assembler resolving the labels locally, as it does in a regular build.
            await appendFile(`${path}/libavcodec/x86/Makefile`, "\n$(SUBDIR)x86/mlpdsp_init.o: CFLAGS += -fno-lto\n");

            if (toolchainState().toolchain === "msvc") {
                await $`sd -s -- ${"$AR rcs"} "llvm-ar rcs" compat/windows/makedef`.cwd(path);
                await $`sd ${"SLIB_INSTALL_EXTRA_SHLIB='$(SLIBNAME:$(SLIBSUF)=.lib)'"} ${`SLIB_INSTALL_EXTRA_SHLIB='$(SLIBNAME:$(SLIBSUF)=.lib)${toolchainState().useCodeview ? "$(SLIBNAME_WITH_MAJOR:$(SLIBSUF)=.pdb)'" : "'"}`} configure`.cwd(
                    path,
                );
                await $`sd -s -- ${"SLIB_INSTALL_EXTRA_LIB='$(SLIBNAME_WITH_MAJOR:$(SLIBSUF)=.def)'"} ${"SLIB_INSTALL_EXTRA_LIB='$(SLIBNAME:$(SLIBSUF)=.lib)'"} configure`.cwd(
                    path,
                );
            }
        },
        harfbuzz: async () => {
            if (WIN && toolchainState().toolchain !== "msvc") {
                await $`sd -s "PROPERTIES LINKER_LANGUAGE C)" "PROPERTIES LINKER_LANGUAGE CXX)" CMakeLists.txt`.cwd(
                    path,
                );
            }
        },
        icu: async () => {
            await $`sd -s -- "STATIC_PREFIX_WHEN_USED = s" "STATIC_PREFIX_WHEN_USED =" "icu4c/source/icudefs.mk.in"`.cwd(
                path,
            );
            await $`sd -s -- "STATIC_PREFIX = s" "STATIC_PREFIX =" "icu4c/source/icudefs.mk.in"`.cwd(path);

            await $`sd -s -- "OUTPUTFILE=icupkg.inc" "OUTPUTFILE=icupkg.inc\nCFLAGS += -fno-lto -fno-whole-program-vtables\nCXXFLAGS += -fno-lto -fno-whole-program-vtables\nLDFLAGSICUDT += -fno-lto -fno-whole-program-vtables" ${`${path}/icu4c/source/data/pkgdataMakefile.in`}`;

            // Builds go to another device than the final install dir, and NTFS can't symlink across devices: install copies instead.
            for (const dir of [".", "common", "i18n", "io", "stubdata", "tools/toolutil"]) {
                await $`sd -s -- "ln -s" "cp -rf" Makefile.in`.cwd(`${path}/icu4c/source/${dir}`);
            }
            await $`sd -s -- '#define LN_CMD "ln -s"' '#define LN_CMD "cp -f"' icu4c/source/tools/pkgdata/pkgdata.cpp`.cwd(
                path,
            );

            if (toolchainState().toolchain === "msvc") {
                await $`git apply ${`${ROOT}/patches/plurrule.patch`}`.cwd(path);
                await $`cp ${`${ROOT}/patches/mh-cygwin-clang-msvc.txt`} icu4c/source/config/mh-cygwin-msvc`.cwd(path);
                await $`sd -s "LIB.exe /nologo /out:" "llvm-ar qc " icu4c/source/tools/pkgdata/pkgdata.cpp`.cwd(path);
                await $`sd -s "link.exe" "lld-link" icu4c/source/tools/pkgdata/pkgdata.cpp`.cwd(path);
                await $`sd -s "rc.exe" "llvm-rc" icu4c/source/data/makedata.mak`.cwd(path);
                await $`sd -s "rc.exe" "llvm-rc" icu4c/source/data/Makefile.in`.cwd(path);
            }
        },
        imagemagick: async () => {
            // Swaps GPL FFTW3 for BSD-licensed PocketFFT, amalgamated into fourier.c. Safe to
            // git apply exactly once here: buildVariants resets the tree hard before prehook runs.
            // Also subsumes the old MAGICKCORE_HAVE_COMPLEX_H / HAVE_C{ABS,ARG,IMAG,REAL} rewrites,
            // since the patch undefines the former and defines the latter four outright.
            await $`git apply ${`${ROOT}/patches/imagemagick-fourier-pocketfft.patch`}`.cwd(path);

            if (toolchainState().toolchain === "msvc") {
                await $`sd -s "GOMP_LIBS=''" "GOMP_LIBS=' '" configure`.cwd(path);

                await $`sd ${String.raw`echo /'\*' \$ac_prefix_conf_OUT\. Generated automatically at end of configure\. '\*'/ >>\$tmp/pconfig\.h`} ${`echo /'*' $$ac_prefix_conf_OUT. Generated automatically at end of configure. '*'/ >>$$tmp/pconfig.h\n    echo 'typedef __int64 ssize_t;' >>$$tmp/pconfig.h`} configure`.cwd(
                    path,
                );
            }
        },
        kvazaar: async () => {
            if (toolchainState().toolchain === "msvc") {
                await $`git apply ${`${ROOT}/patches/kvazaar-cmakelists.patch`}`.cwd(path);
            }
        },
        libarchive: async () => {
            await $`cp ${`${ROOT}/patches/libarchive/CMakeLists.txt`} libarchive/CMakeLists.txt`.cwd(path);
        },
        libgit2: async () => {
            await $`sd -s -- "include(DefaultCFlags)" "" CMakeLists.txt`.cwd(path);
        },
        libjxl: async () => {
            await $`sd -s "add_subdirectory(tools)" "# " CMakeLists.txt`.cwd(path);
        },
        libpng: async () => {
            if (toolchainState().toolchain === "msvc") {
                await $`sd -s "if(NOT CMAKE_HOST_WIN32 OR CYGWIN OR MINGW)" "if(CMAKE_HOST_WIN32 OR CYGWIN OR MINGW)" CMakeLists.txt`.cwd(
                    path,
                );
                await $`sd -s "if(NOT WIN32 OR CYGWIN OR MINGW)" "if(WIN32 OR CYGWIN OR MINGW)" CMakeLists.txt`.cwd(
                    path,
                );
            }
        },
        libtool: async () => {
            if (WIN) {
                await $`sd -s -- "extern LT_DLSYM_CONST lt_dlsymlist preloaded_symbols[]" "extern LT_DLSYM_CONST lt_dlsymlist* preloaded_symbols = NULL" libltdl/ltdl.c`.cwd(
                    path,
                );
                await $`sd -s -- "LT_SCOPE const lt_dlvtable *	get_vtable (lt_user_data data);" "LT_SCOPE const lt_dlvtable *	get_vtable (lt_user_data data);\nLT_SCOPE const lt_dlvtable *	loadlibrary_LTX_get_vtable (lt_user_data data);" libltdl/ltdl.c`.cwd(
                    path,
                );
                await $`sd -s -- "errors += loader_init (get_vtable, 0);" "errors += loader_init (get_vtable, 0);\nerrors += loader_init (loadlibrary_LTX_get_vtable, 0);" libltdl/ltdl.c`.cwd(
                    path,
                );
                await $`sd -s -- "errors += lt_dlpreload_open (LT_STR(LTDLOPEN), loader_init_callback);" "" libltdl/ltdl.c`.cwd(
                    path,
                );
            }
        },
        libultrahdr: async () => {
            if (WIN) {
                await $`sd -s -- ${"if(MSVC AND NOT BUILD_SHARED_LIBS)"} ${"if((MSVC OR WIN32) AND NOT BUILD_SHARED_LIBS)"} CMakeLists.txt`.cwd(
                    path,
                );
                await $`sd -s -- ${"if(BUILD_SHARED_LIBS AND NOT MSVC)"} ${"if(BUILD_SHARED_LIBS AND NOT (MSVC OR WIN32))"} CMakeLists.txt`.cwd(
                    path,
                );
                await $`sd -s -- ${"combine_static_libs(${UHDR_CORE_LIB_NAME} ${UHDR_TARGET_NAME_STATIC})\n  if(NOT MSVC)"} ${"combine_static_libs(${UHDR_CORE_LIB_NAME} ${UHDR_TARGET_NAME_STATIC})\n  if(NOT (MSVC OR WIN32))"} CMakeLists.txt`.cwd(
                    path,
                );
                await $`sd -s -- ${"$<$<CONFIG:Debug>:Debug>"} "" CMakeLists.txt`.cwd(path);
            }
        },
        mesa: async () => {
            if (toolchainState().toolchain === "msvc") {
                await $`sd -s -- "_interlockedexchange64" "_InterlockedExchange64" src/util/u_atomic.h`.cwd(path);
                await $`sd -s -- "_interlockedexchangeadd64" "_InterlockedExchangeAdd64" src/util/u_atomic.h`.cwd(path);
                await $`sd -s -- "_interlockeddecrement64" "_InterlockedDecrement64" src/util/u_atomic.h`.cwd(path);
                await $`sd -s -- "_interlockedincrement64" "_InterlockedIncrement64" src/util/u_atomic.h`.cwd(path);
                // _InterlockedAdd/_InterlockedAdd8/_InterlockedAdd16/64 are ARM64-only
                // intrinsics and aren't defined for x86_64; rewrite p_atomic_add_return
                // to use the (defined) ExchangeAdd variants plus the delta instead.
                const shimOld =
                        "__forceinline char _interlockedadd8(char volatile * _Addend, char _Value)\n{\n   return _InterlockedExchangeAdd8(_Addend, _Value) + _Value;\n}\n\n__forceinline short _interlockedadd16(short volatile * _Addend, short _Value)\n{\n   return _InterlockedExchangeAdd16(_Addend, _Value) + _Value;\n}\n\n",
                    addLines: [string, string][] = [
                        [
                            "_interlockedadd8 ((char *)   (_v), (char) (_i)) : \\",
                            "_InterlockedExchangeAdd8 ((char *)   (_v), (char) (_i)) + (char) (_i) : \\",
                        ],
                        [
                            "_interlockedadd16((short *)  (_v), (short) (_i)) : \\",
                            "_InterlockedExchangeAdd16((short *)  (_v), (short) (_i)) + (short) (_i) : \\",
                        ],
                        [
                            "_interlockedadd  ((long *)   (_v), (long) (_i)) : \\",
                            "_InterlockedExchangeAdd  ((long *)   (_v), (long) (_i)) + (long) (_i) : \\",
                        ],
                        [
                            "_interlockedadd64((__int64 *)(_v), (__int64) (_i)) : \\",
                            "_InterlockedExchangeAdd64((__int64 *)(_v), (__int64) (_i)) + (__int64) (_i) : \\",
                        ],
                    ];

                await $`sd -s -- ${shimOld} ${""} src/util/u_atomic.h`.cwd(path);
                for (const [from, to] of addLines) {
                    await $`sd -s -- ${from} ${to} src/util/u_atomic.h`.cwd(path);
                }

                // MSVC's CRT math.h only defines M_PI/M_LOG2E/etc. when
                // _USE_MATH_DEFINES is set before it's included; NIR's builtin
                // builder relies on them being available unconditionally.
                const preArgsOld = `'-DPACKAGE_BUGREPORT="https://gitlab.freedesktop.org/mesa/mesa/-/issues"',`,
                    preArgsNew = `${preArgsOld}\n  '-D_USE_MATH_DEFINES',`;

                await $`sd -s -- ${preArgsOld} ${preArgsNew} meson.build`.cwd(path);
            }

            if (WIN) {
                // include/meson.build only installs the Khronos GL/GLES/EGL headers
                // (EGL/egl.h, eglext.h, eglplatform.h, ...) when the host isn't
                // Windows - the non-upstream eglext_angle.h/eglmesaext.h pair a few
                // lines down has no such guard, so a Windows build ends up with
                // those two but not the base egl.h that consumers (e.g. libultrahdr's
                // find_package(EGL)) actually look for. Drop the Windows exclusion so
                // the full header set gets installed everywhere with_egl is on.
                await $`sd -s -- ${"if not with_glvnd and host_machine.system() != 'windows'"} ${"if not with_glvnd"} include/meson.build`.cwd(
                    path,
                );
            }
        },
        openexr: async () => {
            await $`sd -s -- "add_subdirectory(website/src)" "" CMakeLists.txt`.cwd(path);
        },
        pcre2: async () => {
            await $`git submodule update --depth 1 --init sljit`.cwd(`${path}/deps`);
        },
        projectm: async () => {
            await $`git submodule update --depth 1 --init --recursive`.cwd(path);
        },
        upx: async () => {
            await $`git submodule update --depth 1 --init --recursive`.cwd(path);
        },
        xz: async () => {
            if (toolchainState().toolchain === "msvc") {
                await $`sd -s -- "if(NOT MSVC AND NOT CYGWIN)" "if (NOT (MSVC OR (CMAKE_C_SIMULATE_ID STREQUAL "MSVC")) AND NOT CYGWIN)" CMakeLists.txt`.cwd(
                    path,
                );
            }
        },
        "zlib-ng": async () => {
            await $`sd -s -- "set(NOLTOFLAG \${ZNOLTOFLAG})" "" CMakeLists.txt`.cwd(path);
        },
        zstd: async () => {
            if (toolchainState().toolchain === "msvc") {
                await $`git apply ${`${ROOT}/patches/zstd-lib-cmakelists.patch`}`.cwd(path);
            }
        },
    };
    if (table[name]) {
        await table[name]();
    }
}

async function buildAutoconf(
    path: string,
    isDebug: boolean,
    prefix: string,
    configureArgs = "",
    extraEnv = "",
    configureCommand = "./configure",
) {
    const libtool = !path.includes("ffmpeg") && !path.includes("icu"),
        msysPath = toMsysPath(path),
        { toolchain } = toolchainState();
    const configurePath = `${path}/configure`;
    let libs = "";

    if (WIN) {
        libs = "-ladvapi32 -luser32";

        if (toolchain !== "msvc") {
            libs += `-lclang_rt.builtins-x86_64 ${process.env.CFLAGS!.includes("-fsanitize=address") ? "-lclang_rt.asan_dynamic-x86_64 -lclang_rt.asan_dynamic_runtime_thunk-x86_64" : ""} -lole32 -lcfgmgr32`;
        }
    }

    const buildType = isDebug ? "--enable-shared --disable-static" : "--disable-shared --enable-static",
        libtoolFlags = libtool
            ? `--disable-dependency-tracking --with-gnu-ld ${WIN ? "--build=x86_64-w64-mingw32 --host=x86_64-w64-mingw32" : ""} lt_cv_deplibs_check_method="pass_all" lt_cv_prog_gnu_ld=yes`
            : "";

    if (libtool) {
        if (toolchain === "msvc") {
            await $`sd -s -- ${"-Fe$tool_output_objdir$soname"} ${"-o $tool_output_objdir$soname"} ${configurePath}`;
            await $`sd -s -- ${"-Fe$output_objdir/$soname"} ${"-o $output_objdir/$soname"} ${configurePath}`;
            await $`sd -s -- '-link -EXPORT' "-Xlinker -EXPORT" ${configurePath}`;
        }
    }

    const libsArg = !path.includes("ffmpeg") ? `LIBS="${libs}"` : "";

    // Archive-sourced libraries (e.g. libraw) build in-tree and are never `git clean`ed between variants, so make
    // would reuse the other variant's objects (debug's -DLIBRAW_BUILDLIB ones in a "static" release build).
    await bash`cd ${msysPath} && make distclean`.noThrow(); // fails harmlessly on a fresh tree

    await bash`cd ${msysPath} && ${extraEnv} ${libsArg} ${configureCommand} ${configureArgs} ${buildType} --prefix=${toMsysPath(prefix)} ${libtoolFlags}`;

    if (libtool) {
        const libtoolPath = `${path}/libtool`;
        await $`sd -s -- "-fuse-ld=*|" "-f*|--target=*|-march=*|-mtune=*|-D*|-g*|-w*|" ${libtoolPath}`.noThrow();

        if (toolchain === "msvc") {
            await $`sd -s -- 'wl=""' 'wl="-Wl,"' ${libtoolPath}`;
        }
    }

    await bash`cd ${msysPath} && ${extraEnv} ${path.includes("icu") && toolchain === "msvc" ? `MSYS2_ARG_CONV_EXCL="*"` : ""} make -j4 && make install`;
}

async function buildPlain(
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
                emitPdb = isMsvc && toolchainState().useCodeview,
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

            if (emitPdb) {
                await $`cp ${pdbName} ${`${prefix}/bin/${pdbName}`}`.cwd(path);
            }
        } else {
            const soName = `lib${baseName}.so`;

            await bash`cd ${msysPath} && ${toolchainState().tools.cc} -shared -o ${ldFlags} ${soName} *.o`;

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

export async function buildCMake(name: string, path: string, sourceSubdir: string, isDebug: boolean) {
    const cwd = sourceSubdir ? `${path}/${sourceSubdir}` : path,
        dir = buildDir(isDebug),
        toolchainFile = isDebug ? DEBUG_TOOLCHAIN : RELEASE_TOOLCHAIN;
    await $`cmake -B ${dir} -S . -G Ninja --toolchain ${toolchainFile} --fresh -DBUILD_TOOLS=OFF -DBUILD_DOCS=OFF -DBUILD_DOC=OFF -DBUILD_EXAMPLE=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF -DBUILD_TESTS=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=${cmakeVal(isDebug)} ${raw(arghook(name, isDebug))}`.cwd(
        cwd,
    );
    await $`cmake --build ${dir} -j`.cwd(cwd);
    await $`cmake --install ${dir}`.cwd(cwd);
}

export async function buildMeson(name: string, path: string, isDebug: boolean) {
    const dir = buildDir(isDebug),
        native = isDebug ? DEBUG_NATIVE : RELEASE_NATIVE;

    await $`uv run --with mako,setuptools,pyyaml meson setup ${dir} --native-file=${native} ${raw(arghook(name, isDebug))}`.cwd(
        path,
    );
    await $`uv run --with mako,setuptools,pyyaml meson compile -C ${dir}`.cwd(path);
    await $`uv run --with mako,setuptools,pyyaml meson install -C ${dir}`.cwd(path);
}

export async function buildRust(name: string, path: string, isDebug: boolean) {
    await $`cargo cinstall ${raw(isDebug ? "--library-type=cdylib" : "--library-type=staticlib")} ${raw(isDebug ? "--profile win-debug" : "--profile win-release")} --no-default-features ${raw(arghook(name, isDebug))} --prefix=${isDebug ? DBG_ROOT : REL_ROOT}`.cwd(
        path,
    );
}
