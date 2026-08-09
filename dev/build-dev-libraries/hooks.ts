import $ from "dax";
import { cp, writeFile } from "node:fs/promises";

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

export async function customBuild(name: string, p: string, isDebug: boolean) {
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
                    "--enable-decoder=aac,mp3,mp3float,opus,vorbis,flac,alac,ac3,eac3,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le --enable-demuxer=mov,matroska,ogg,wav,flac,mp3,aac,ac3,avi --enable-parser=aac,ac3,flac,mpegaudio,opus,vorbis --enable-filter=aformat,firequalizer,aresample,alimiter",
                common = `--target-os=${WIN ? (toolchain === "msvc" ? "win64" : "mingw32") : "linux"} --arch=x86_64 ${toolchain === "msvc" ? "--toolchain=msvc" : ""} --stdc=gnu17 --stdcxx=gnu++23 --cc=${CC} --cxx=${CXX} --ar=${AR} --strip=${STRIP} --ld=${CC} --ranlib=${RANLIB} --nm=${NM} --windres=${WINDRES} --disable-autodetect --disable-all --enable-asm --enable-protocol=file --enable-avformat --enable-avcodec --enable-avfilter --enable-swscale --enable-swresample --extra-cflags="${CFLAGS}" --extra-ldflags="${LDFLAGS}" --extra-cxxflags="${CXXFLAGS}" --optflags="${CFLAGS}"`,
                rpgCodecs =
                    "--enable-demuxer=ogg,mov --enable-decoder=vorbis,theora,aac,opus,h264,vp9 --enable-parser=aac,h264,vp9";

            let variants;

            if (isDebug) {
                variants = [
                    { codecs: audioCodecs, isDebug, prefix: `${DBG_ROOT}/ffmpeg-rap` },
                    { codecs: rpgCodecs, isDebug, prefix: `${DBG_ROOT}/ffmpeg-rpgmtranslate` },
                ];
            } else {
                variants = [
                    { codecs: audioCodecs, isDebug, prefix: `${REL_ROOT}/ffmpeg-rap` },
                    { codecs: rpgCodecs, isDebug, prefix: `${REL_ROOT}/ffmpeg-rpgmtranslate` },
                ];
            }

            for (const v of variants) {
                await bash`cd ${p} && make clean`.noThrow();
                const buildType = v.isDebug
                    ? "--disable-optimizations --enable-debug --disable-stripping"
                    : "--enable-optimizations --disable-debug --enable-stripping";
                await buildAutoconf(p, v.isDebug, v.prefix, `${common} ${buildType} ${v.codecs}`);
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
                `ICU_DATA_FILTER_FILE=filters.json CPPFLAGS="-DUCONFIG_NO_COLLATION=1 -DUCONFIG_NO_FORMATTING=1 -DUCONFIG_NO_TRANSLITERATION=1 -DUCONFIG_NO_REGULAR_EXPRESSIONS=1 -DUCONFIG_NO_SERVICE=1 -DUCONFIG_NO_IDNA=1 -DUCONFIG_NO_CONVERSION=0 -DUCONFIG_NO_LEGACY_CONVERSION=0 -DUCONFIG_NO_NORMALIZATION=0"`,
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

            await buildAutoconf(
                p,
                isDebug,
                libRoot,
                `--disable-dependency-tracking --disable-legacy-support ${isDebug ? "--enable-assert" : "--disable-assert"} --enable-openmp --enable-opencl --with-threads --with-quantum-depth=8 --without-modules --without-utilities --disable-docs --disable-hdri --disable-deprecated --without-perl --with-ltdl ` +
                    "--with-bzlib --without-fftw --with-freetype --with-heic --without-jbig --with-jpeg --with-jxl --with-lcms --with-lzma --with-openexr --with-openjp2 --with-png --with-raw --with-tiff --with-webp --with-xml --with-zip --with-zlib --with-zstd --without-autotrace --without-djvu --without-dps --without-flif --without-fpx --without-fontconfig --without-gslib --without-gvc --without-dmr --without-lqr --without-pango --without-raqm --without-rsvg --without-uhdr --without-wmf --without-x --without-gdi32",
            );
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
                common = `-no-guess-compiler -cmake-generator Ninja -c++std c++23 -gui -widgets -submodules ${submodules.join(",")} -pch -qpa "${WIN ? "windows" : "xcb;wayland"}" ${toolchainState().toolchain === "msvc" ? "" : "-reduce-exports"} -disable-deprecated-up-to 0x060213 -nomake tests -nomake examples -nomake benchmarks -nomake manual-tests -nomake minimal-static-tests -nomake doc-snippets  -no-emojisegmenter -no-appstore-compliant -no-sbom -no-sbom-json -no-sbom-verify -no-system-proxies -no-mimetype-database -no-icu -no-gif -no-dbus -no-ssl -no-openssl -no-schannel -no-libb2 -system-harfbuzz -system-freetype -system-libpng -system-libjpeg -system-webp -system-zlib -system-doubleconversion -system-pcre -system-libmd4c -no-tiff -no-jasper -no-mng -no-zstd ${!WIN ? "-no-glib -no-evdev -no-mtdev -no-tslib -no-eglfs -no-linuxfb -no-gtk -xcb-xlib -libudev -libinput -opengl -egl" : "-no-opengl"}`,
                featureToggles = `-feature-accessibility -feature-animation -feature-calendarwidget -feature-cborstreamreader -feature-cborstreamwriter -feature-datetimeedit -feature-datetimeparser -feature-designer -feature-dom -feature-draganddrop -feature-imageformat_jpeg -feature-imageformat_png -feature-imageformat_xpm -feature-linguist -feature-rubberband -feature-style-stylesheet ${WIN ? "-feature-style-windows -feature-style-windows11 -feature-style-windowsvista" : ""} -feature-texthtmlparser -feature-textmarkdownreader -feature-wizard -no-feature-androiddeployqt -no-feature-appstore-compliant -no-feature-assistant -no-feature-brotli -no-feature-distancefieldgenerator -no-feature-dnslookup -no-feature-dtls -no-feature-effects -no-feature-emojisegmenter -no-feature-fullqthelp -no-feature-gestures -no-feature-gssapi -no-feature-hijricalendar -no-feature-imageformat_bmp -no-feature-imageformat_ppm -no-feature-imageformat_xbm -no-feature-islamiccivilcalendar -no-feature-jalalicalendar -no-feature-kmap2qmap -no-feature-macdeployqt -no-feature-movie -no-feature-ocsp -no-feature-openssl-hash -no-feature-pdf -no-feature-pixeltool -no-feature-printsupport -no-feature-qdbus -no-feature-qdoc -no-feature-qdoc_coverage -no-feature-qmake -no-feature-qtattributionsscanner -no-feature-qtdiag -no-feature-qtplugininfo -no-feature-run-opengl-tests -no-feature-sessionmanager -no-feature-socks5 -no-feature-splashscreen -no-feature-sql -no-feature-sspi -no-feature-tabletevent -no-feature-testlib -no-feature-textmarkdownwriter -no-feature-textodfwriter -no-feature-timezone -no-feature-timezone_locale -no-feature-timezone_tzdb -no-feature-topleveldomain -no-feature-tuiotouch -no-feature-udpsocket -no-feature-wasm-exceptions -no-feature-wasm-jspi -no-feature-wasm-simd128 -no-feature-wasmdeployqt -no-feature-windeployqt ${!WIN ? "-no-feature-wayland-client-wl-shell -no-feature-liburing -no-feature-xlib -feature-system-xcb-xinput -no-feature-vnc" : ""}`;

            await $`git submodule update --init --depth 1 ${submodules}`.cwd(p);
            await $`git submodule update --init --recursive --depth 1`.cwd(`${p}/qttools`);

            if (isDebug) {
                if (toolchainState().toolchain === "msvc") {
                    await $`sd -s "add_dependencies(Core qmodule_pri)" ${`add_dependencies(Core qmodule_pri)\ntarget_link_options(Core PRIVATE "-Wl,-FORCE:UNRESOLVED")`} qtbase/src/corelib/CMakeLists.txt`.cwd(
                        p,
                    );
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
        brotli: `-DBROTLI_EMSCRIPTEN=0 -DBROTLI_BUILD_TOOLS=0`,
        dav1d: "-Denable_asm=true -Denable_tools=false -Denable_examples=false -Denable_tests=false -Denable_seek_stress=false -Denable_docs=false -Dlogging=false -Dtestdata_tests=false -Dfuzzing_engine=none -Dtrim_dsp=true",
        fltk: `-DFLTK_BUILD_SHARED_LIBS=0 -DFLTK_USE_SYSTEM_ZLIB=1 -DFLTK_USE_SYSTEM_LIBPNG=1 -DFLTK_USE_SYSTEM_LIBJPEG=1 -DFLTK_OPTION_SVG=0 -DFLTK_BUILD_FLUID=0 -DFLTK_BUILD_FLTK_OPTIONS=0 -DFLTK_BUILD_GL=1 -DFLTK_BUILD_FORMS=0 -DFLTK_BUILD_TEST=0 -DFLTK_BUILD_HTML_DOCS=0 -DFLTK_OPTION_PEN_SUPPORT=0 -DFLTK_OPTION_LARGE_FILE=0 -DFLTK_OPTION_PRINT_SUPPORT=0 -DFLTK_OPTION_FILESYSTEM_SUPPORT=0 -DFLTK_OPTION_STD=0 -DFLTK_GRAPHICS_GDIPLUS=0 -DFLTK_MSVC_RUNTIME_DLL=${isDebug}`,
        freetype: `-DFT_DISABLE_ZLIB=0 -DFT_REQUIRE_ZLIB=1 -DFT_DISABLE_BZIP2=0 -DFT_REQUIRE_BZIP2=1 -DFT_DISABLE_PNG=0 -DFT_REQUIRE_PNG=1 -DFT_DISABLE_HARFBUZZ=1 -DFT_DYNAMIC_HARFBUZZ=0 -DFT_REQUIRE_HARFBUZZ=0 -DFT_DISABLE_BROTLI=1 -DFT_REQUIRE_BROTLI=0 -DDISABLE_FORCE_DEBUG_POSTFIX=1`,
        glaze: "-Dglaze_ENABLE_FUZZING=0 -Dglaze_DEVELOPER_MODE=0",
        glew: "-DBUILD_UTILS=0 -DGLEW_X11=0",
        glfw: `-DGLFW_BUILD_EXAMPLES=0 -DGLFW_BUILD_TESTS=0 -DGLFW_BUILD_DOCS=0 -DGLFW_INSTALL=1 -DGLFW_LIBRARY_TYPE=${isDebug ? "SHARED" : "STATIC"}`,
        googletest: "-DBUILD_GMOCK=0",
        harfbuzz: `-DHB_BUILD_UTILS=0 -DHB_BUILD_RASTER=0 -DHB_BUILD_VECTOR=0 -DHB_BUILD_GPU=0 -DHB_BUILD_TESTS=0 -DHB_HAVE_CAIRO=OFF -DHB_HAVE_FREETYPE=ON -DHB_HAVE_GRAPHITE2=OFF -DHB_HAVE_GLIB=OFF -DHB_HAVE_ICU=OFF -DHB_HAVE_UNISCRIBE=OFF -DHB_HAVE_GDI=OFF -DHB_HAVE_DIRECTWRITE=ON -DHB_HAVE_GOBJECT=OFF -DHB_HAVE_INTROSPECTION=OFF`,
        highway: `-DHWY_ENABLE_CONTRIB=0 -DHWY_ENABLE_EXAMPLES=0 -DHWY_ENABLE_TESTS=0 -DHWY_FORCE_STATIC_LIBS=${!isDebug}`,
        imath: `-DPYTHON=0 -DPYBIND11=0 -DBUILD_WEBSITE=0 -DIMATH_HALF_USE_LOOKUP_TABLE=1 -DIMATH_USE_DEFAULT_VISIBILITY=0 -DIMATH_ENABLE_LARGE_STACK=0 -DIMATH_USE_NOEXCEPT=0 -DIMATH_INSTALL_PKG_CONFIG=1`,
        lcms2: `-DLCMS2_BUILD_TOOLS=0 -DLCMS2_BUILD_TESTS=0 -DLCMS2_BUILD_JPGICC=0 -DLCMS2_BUILD_TIFICC=0 -DLCMS2_BUILD_TIFDIFF=0 -DLCMS2_BUILD_SHARED=${isDebug} -DLCMS2_BUILD_STATIC=${!isDebug}`,
        libarchive: `-DENABLE_MBEDTLS=0 -DENABLE_NETTLE=0 -DENABLE_OPENSSL=0 -DENABLE_LIBB2=0 -DENABLE_LZ4=0 -DENABLE_LZO=0 -DENABLE_LZMA=1 -DENABLE_ZSTD=0 -DENABLE_ZLIB=0 -DENABLE_BZip2=0 -DENABLE_LIBXML2=0 -DENABLE_EXPAT=0 -DENABLE_WIN32_XMLLITE=0 -DENABLE_PCREPOSIX=0 -DENABLE_PCRE2POSIX=0 -DENABLE_LIBGCC=0 -DENABLE_CNG=1 -DENABLE_TAR=0 -DENABLE_CPIO=0 -DENABLE_CAT=0 -DENABLE_UNZIP=0 -DENABLE_XATTR=0 -DENABLE_ACL=0 -DENABLE_ICONV=0 -DENABLE_TEST=0 -DENABLE_COVERAGE=0 -DENABLE_WERROR=0 -DPOSIX_REGEX_LIB=NONE`,
        libde265: `-DUSE_IWYU=0 -DENABLE_SDL=0 -DENABLE_SIMD=1 -DENABLE_AVX2=1 -DENABLE_AVX512=0 -DENABLE_DECODER=0 -DENABLE_ENCODER=0 -DENABLE_SHERLOCK265=0 -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=0 -DWITH_FUZZERS=0 -DFORCE_FULL_VISIBILITY=0`,
        libdeflate: `-DLIBDEFLATE_COMPRESSION_SUPPORT=1 -DLIBDEFLATE_DECOMPRESSION_SUPPORT=1 -DLIBDEFLATE_ZLIB_SUPPORT=1 -DLIBDEFLATE_GZIP_SUPPORT=0 -DLIBDEFLATE_BUILD_GZIP=0 -DLIBDEFLATE_BUILD_TESTS=0 -DLIBDEFLATE_BUILD_STATIC_LIB=${!isDebug} -DLIBDEFLATE_BUILD_SHARED_LIB=${isDebug}`,
        libgit2: `-DBUILD_CLI=OFF -DBUILD_FUZZERS=OFF -DUSE_THREADS=ON -DUSE_NSEC=ON -DUSE_SSH=OFF -DUSE_HTTPS=ON -DREGEX_BACKEND=pcre2 -DDEPRECATE_HARD=ON`,
        libheif: `-DWITH_EXAMPLES=0 -DWITH_EXAMPLE_HEIF_THUMB=0 -DWITH_EXAMPLE_HEIF_VIEW=0 -DWITH_GDK_PIXBUF=0 -DENABLE_PLUGIN_LOADING=0 -DWITH_LIBDE265=1 -DWITH_X265=0 -DWITH_KVAZAAR=0 -DWITH_UVG266=0 -DWITH_VVDEC=0 -DWITH_VVENC=0 -DWITH_X264=0 -DWITH_OpenH264_DECODER=1 -DWITH_DAV1D=1 -DWITH_AOM_DECODER=0 -DWITH_AOM_ENCODER=0 -DWITH_SvtEnc=0 -DWITH_RAV1E=0 -DWITH_JPEG_DECODER=1 -DWITH_JPEG_ENCODER=0 -DWITH_OpenJPEG_ENCODER=0 -DWITH_OpenJPEG_DECODER=1 -DWITH_FFMPEG_DECODER=0 -DWITH_OPENJPH_ENCODER=0 -DWITH_UNCOMPRESSED_CODEC=0 -DWITH_WEBCODECS=0 -DWITH_LIBSHARPYUV=1 -DBUILD_DOCUMENTATION=0`,
        "libjpeg-turbo": `-DWITH_ARITH_DEC=1 -DWITH_ARITH_ENC=1 -DWITH_JAVA=0 -DWITH_JPEG7=0 -DWITH_JPEG8=0 -DWITH_SIMD=1 -DWITH_TURBOJPEG=1 -DWITH_TOOLS=0 -DWITH_TESTS=0 -DWITH_FUZZ=0 -DFORCE_INLINE=1 -DENABLE_SHARED=${isDebug} -DENABLE_STATIC=${!isDebug} -DWITH_SYSTEM_SPNG=1 -DWITH_SYSTEM_ZLIB=1`,
        libjxl: `-DJPEGXL_ENABLE_FUZZERS=0 -DJPEGXL_ENABLE_DEVTOOLS=0 -DJPEGXL_ENABLE_TESTS=0 -DJPEGXL_ENABLE_DOXYGEN=0 -DJPEGXL_ENABLE_MANPAGES=0 -DJPEGXL_ENABLE_BENCHMARK=0 -DJPEGXL_ENABLE_EXAMPLES=0 -DJPEGXL_BUNDLE_LIBPNG=0 -DJPEGXL_ENABLE_JNI=0 -DJPEGXL_ENABLE_SJPEG=0 -DJPEGXL_ENABLE_OPENEXR=1 -DJPEGXL_ENABLE_SKCMS=0 -DJPEGXL_ENABLE_VIEWERS=0 -DJPEGXL_ENABLE_TCMALLOC=0 -DJPEGXL_ENABLE_PLUGINS=0 -DJPEGXL_ENABLE_COVERAGE=0 -DJPEGXL_ENABLE_TRANSCODE_JPEG=1 -DJPEGXL_ENABLE_BOXES=1 -DJPEGXL_WARNINGS_AS_ERRORS=0 -DJPEGXL_TEST_TOOLS=0 -DJPEGXL_ENABLE_WASM_THREADS=0 -DJPEGXL_FORCE_SYSTEM_BROTLI=1 -DJPEGXL_FORCE_SYSTEM_GTEST=1 -DJPEGXL_FORCE_SYSTEM_LCMS2=1 -DJPEGXL_FORCE_SYSTEM_HWY=1 -DJPEGXL_STATIC=${!isDebug}`,
        libpng: `-DPNG_TESTS=0 -DPNG_TOOLS=0 -DPNG_EXECUTABLES=0 -DPNG_HARDWARE_OPTIMIZATIONS=1 -DPNG_BUILD_ZLIB=0 -DPNG_SHARED=${isDebug} -DPNG_STATIC=${!isDebug} -DPNG_DEBUG_POSTFIX=""`,
        libspng: `-DENABLE_OPT=ON -DSPNG_SHARED=${isDebug} -DSPNG_STATIC=${!isDebug}`,
        libtiff: `-Dtiff-tools=0 -Dtiff-tests=0 -Dtiff-contrib=0 -Dtiff-docs=0 -Dtiff-deprecated=0 -Dtiff-static=${!isDebug} -Dlerc=0 -Djbig=0 -DTIFF_STATIC_LIBS_DEFAULT=${!isDebug}`,
        libwebp: `-DWEBP_ENABLE_SIMD=1 -DWEBP_BUILD_ANIM_UTILS=0 -DWEBP_BUILD_CWEBP=0 -DWEBP_BUILD_DWEBP=0 -DWEBP_BUILD_GIF2WEBP=0 -DWEBP_BUILD_IMG2WEBP=0 -DWEBP_BUILD_VWEBP=0 -DWEBP_BUILD_WEBPINFO=0 -DWEBP_BUILD_LIBWEBPMUX=1 -DWEBP_BUILD_WEBPMUX=0 -DWEBP_BUILD_EXTRAS=0 -DWEBP_BUILD_FUZZTEST=0 -DWEBP_USE_THREAD=1 -DWEBP_NEAR_LOSSLESS=1 -DWEBP_ENABLE_SWAP_16BIT_CSP=0 -DWEBP_ENABLE_WUNUSED_RESULT=0 -DWEBP_BUILD_WEBP_JS=0 -DWEBP_UNICODE=0 -DWEBP_LINK_STATIC=${!isDebug}`,
        libxml2: `-DLIBXML2_WITH_CATALOG=0 -DLIBXML2_WITH_DEBUG=0 -DLIBXML2_WITH_DOCS=0 -DLIBXML2_WITH_HTML=0 -DLIBXML2_WITH_HTTP=0 -DLIBXML2_WITH_ICONV=0 -DLIBXML2_WITH_ICU=0 -DLIBXML2_WITH_ISO8859X=1 -DLIBXML2_WITH_LEGACY=0 -DLIBXML2_WITH_MODULES=0 -DLIBXML2_WITH_OUTPUT=1 -DLIBXML2_WITH_PATTERN=0 -DLIBXML2_WITH_PROGRAMS=0 -DLIBXML2_WITH_PUSH=1 -DLIBXML2_WITH_PYTHON=0 -DLIBXML2_WITH_READLINE=0 -DLIBXML2_WITH_REGEXPS=0 -DLIBXML2_WITH_SAX1=1 -DLIBXML2_WITH_TESTS=0 -DLIBXML2_WITH_TLS=0 -DLIBXML2_WITH_VALID=0 -DLIBXML2_WITH_XINCLUDE=0 -DLIBXML2_WITH_XPATH=0 -DLIBXML2_WITH_ZLIB=1 -DLIBXML2_WITH_C14N=0 -DLIBXML2_WITH_HISTORY=0 -DLIBXML2_WITH_READER=1 -DLIBXML2_WITH_SCHEMAS=0 -DLIBXML2_WITH_SCHEMATRON=0 -DLIBXML2_WITH_THREAD_ALLOC=1 -DLIBXML2_WITH_WRITER=1 -DLIBXML2_WITH_XPTR=0 -DLIBXML2_WITH_RELAXNG=0 -DLIBXML2_WITH_THREADS=1`,
        libzip: `-DENABLE_COMMONCRYPTO=0 -DENABLE_GNUTLS=0 -DENABLE_MBEDTLS=0 -DENABLE_OPENSSL=0 -DENABLE_WINDOWS_CRYPTO=0 -DENABLE_BZIP2=1 -DENABLE_LZMA=1 -DENABLE_ZSTD=1 -DENABLE_FDOPEN=1 -DBUILD_REGRESS=0 -DBUILD_OSSFUZZ=0`,
        md4c: "-DBUILD_MD2HTML_EXECUTABLE=0",
        "opencl-headers": `-DOPENCL_HEADERS_BUILD_TESTING=0 -DOPENCL_HEADERS_BUILD_CXX_TESTS=0`,
        "opencl-icd": `-DOPENCL_ICD_LOADER_BUILD_TESTING=0 -DENABLE_OPENCL_LAYERINFO=0`,
        openexr: `-DOPENEXR_INSTALL_DOCS=0 -DBUILD_WEBSITE=0 -DOPENEXR_ENABLE_THREADING=1 -DOPENEXR_USE_TBB=0 -DOPENEXR_USE_DEFAULT_VISIBILITY=0 -DOPENEXR_ENABLE_LARGE_STACK=0 -DOPENEXR_BUILD_TOOLS=0 -DOPENEXR_INSTALL_TOOLS=0 -DOPENEXR_INSTALL_DEVELOPER_TOOLS=0 -DOPENEXR_BUILD_EXAMPLES=0 -DOPENEXR_BUILD_PYTHON=0 -DOPENEXR_BUILD_OSS_FUZZ=0 -DOPENEXR_TEST_LIBRARIES=0 -DOPENEXR_TEST_TOOLS=0 -DOPENEXR_TEST_PYTHON=0 -DOPENEXR_USE_CLANG_TIDY=0 -DOPENEXR_FORCE_INTERNAL_DEFLATE=0 -DOPENEXR_FORCE_INTERNAL_OPENJPH=0 -DOPENEXR_FORCE_INTERNAL_IMATH=0 -DOPENEXR_INSTALL_PKG_CONFIG=1`,
        openh264: "-Dtests=disabled",
        openjpeg: `-DBUILD_LUTS_GENERATOR=0 -DBUILD_UNIT_TESTS=0 -DBUILD_CODEC=0 -DBUILD_JPIP=0 -DBUILD_VIEWER=0 -DBUILD_JAVA=0 -DBUILD_STATIC_LIBS=${!isDebug}`,
        openjph: `-DOJPH_ENABLE_TIFF_SUPPORT=OFF -DOJPH_DISABLE_AVX512=1 -DOJPH_BUILD_EXECUTABLES=OFF`,
        pcre2: `-DPCRE2_BUILD_PCRE2_8=1 -DPCRE2_BUILD_PCRE2_16=1 -DPCRE2_BUILD_PCRE2_32=0 -DPCRE2_STATIC_PIC=0 -DPCRE2_DEBUG=0 -DPCRE2_DISABLE_PERCENT_ZT=1 -DPCRE2_EBCDIC=0 -DPCRE2_EBCDIC_NL25=0 -DPCRE2_EBCDIC_IGNORING_COMPILER=0 -DPCRE2_REBUILD_CHARTABLES=0 -DPCRE2_NEWLINE=LF -DPCRE2_SUPPORT_JIT=1 -DPCRE2_BUILD_PCRE2GREP=0 -DPCRE2_BUILD_TESTS=0 -DPCRE2_SUPPORT_BSR_ANYCRLF=1 -DPCRE2_SUPPORT_UNICODE=1 -DPCRE2GREP_SUPPORT_JIT=0 -DPCRE2GREP_SUPPORT_CALLOUT=0 -DPCRE2GREP_SUPPORT_CALLOUT_FORK=0 -DBUILD_STATIC_LIBS=${!isDebug} -DLIB_POSTFIX=""`,
        projectm: "-DENABLE_DEBUG_POSTFIX=0 -DENABLE_PLAYLIST=0",
        quickjs: `-DQJS_ENABLE_ASAN=0`,
        xz: `-DXZ_NLS=0 -DXZ_SMALL=0 -DXZ_TOOL_XZDEC=0 -DXZ_TOOL_LZMADEC=0 -DXZ_TOOL_LZMAINFO=0 -DXZ_TOOL_XZ=0 -DXZ_DOC=0`,
        "zlib-ng": `-DWITH_GTEST=0 -DWITH_FUZZERS=0 -DWITH_BENCHMARKS=0 -DWITH_BENCHMARK_APPS=0 -DWITH_GZFILEOP=0 -DZLIB_COMPAT=1 -DZLIB_ALIASES=1 -DWITH_OPTIM=1 -DWITH_ALL_FALLBACKS=0 -DWITH_REDUCED_MEM=0 -DWITH_NEW_STRATEGIES=1 -DWITH_CRC32_CHORBA=1 -DWITH_NATIVE_INSTRUCTIONS=0 -DWITH_MAINTAINER_WARNINGS=0 -DWITH_CODE_COVERAGE=0 -DWITH_INFLATE_STRICT=0 -DWITH_INFLATE_ALLOW_INVALID_DIST=0 -DINSTALL_UTILS=0`,
        zstd: `-DZSTD_LEGACY_SUPPORT=1 -DZSTD_MULTITHREAD_SUPPORT=1 -DZSTD_BUILD_PROGRAMS=0 -DZSTD_BUILD_CONTRIB=0 -DZSTD_BUILD_TESTS=0 -DZSTD_BUILD_STATIC=${!isDebug} -DZSTD_BUILD_SHARED=${isDebug} -DZSTD_USE_STATIC_RUNTIME=${!isDebug}`,
    };
    return table[name] ?? "";
}

export async function posthook(name: string, path: string, options: CliOptions) {
    const builtDebug = !options.onlyRelease,
        builtRelease = !options.onlyDebug;
    const table: Record<string, () => Promise<void>> = {
        dav1d: async () => {
            if (WIN) {
                if (builtRelease && toolchainState().toolchain === "msvc") {
                    await $`cp ${`${REL_ROOT}/lib/libdav1d.a`} ${`${REL_ROOT}/lib/dav1d.lib`}`;
                }
            }
        },
        fltk: async () => {
            if (builtRelease && WIN) {
                await stripDllImport(`${REL_ROOT}/include/FL/Fl_Export.H`);
            }
        },
        icu: async () => {
            if (builtRelease) {
                if (WIN) {
                    if (toolchainState().toolchain === "msvc") {
                        await $`mv ${`${REL_ROOT}/bin/icudt.lib`} ${`${REL_ROOT}/lib/icudt.lib`}`;

                        await $`mv ${`${REL_ROOT}/lib/icudt.lib`} ${`${REL_ROOT}/lib/cicudt.lib`}`;
                        await $`mv ${`${REL_ROOT}/lib/icuuc.lib`} ${`${REL_ROOT}/lib/cicuuc.lib`}`;
                        await $`mv ${`${REL_ROOT}/lib/icuin.lib`} ${`${REL_ROOT}/lib/cicuin.lib`}`;
                        await $`mv ${`${REL_ROOT}/lib/icutest.lib`} ${`${REL_ROOT}/lib/cicutest.lib`}`;
                        await $`mv ${`${REL_ROOT}/lib/icutu.lib`} ${`${REL_ROOT}/lib/cicutu.lib`}`;
                    } else {
                        await $`mv ${`${REL_ROOT}/bin/libicudt.a`} ${`${REL_ROOT}/lib/libicudt.a`}`;
                    }

                    await stripDllImport(`${REL_ROOT}/include/unicode/platform.h`);
                }
            }

            if (builtDebug) {
                if (WIN) {
                    if (toolchainState().toolchain === "msvc") {
                        if (toolchainState().useCodeview) {
                            await $`mv *.pdb ${`${DBG_ROOT}/bin`}`.cwd(`${path}/icu4c/source/bin`);
                            await $`mv *.pdb ${`${DBG_ROOT}/bin`}`.cwd(`${path}/icu4c/source/lib`);
                        }

                        await $`mv ${`${DBG_ROOT}/lib/icudt.lib`} ${`${DBG_ROOT}/lib/cicudt.lib`}`;
                        await $`mv ${`${DBG_ROOT}/lib/icuuc.lib`} ${`${DBG_ROOT}/lib/cicuuc.lib`}`;
                        await $`mv ${`${DBG_ROOT}/lib/icuin.lib`} ${`${DBG_ROOT}/lib/cicuin.lib`}`;
                        await $`mv ${`${DBG_ROOT}/lib/icutest.lib`} ${`${DBG_ROOT}/lib/cicutest.lib`}`;
                        await $`mv ${`${DBG_ROOT}/lib/icutu.lib`} ${`${DBG_ROOT}/lib/cicutu.lib`}`;
                    }
                }
            }
        },
        imagemagick: async () => {
            if (builtDebug && toolchainState().toolchain === "msvc") {
                if (toolchainState().useCodeview) {
                    await $`mv *.pdb ${`${DBG_ROOT}/bin`}`.cwd(`${path}/MagickCore/.libs`);
                    await $`mv *.pdb ${`${DBG_ROOT}/bin`}`.cwd(`${path}/MagickWand/.libs`);
                    await $`mv *.pdb ${`${DBG_ROOT}/bin`}`.cwd(`${path}/Magick++/lib/.libs`);
                }

                await $`cp "Magick++-7.Q8.dll.lib" "Magick++-7.Q8.lib"`.cwd(`${DBG_ROOT}/lib`);
                await $`cp "MagickCore-7.Q8.dll.lib" "MagickCore-7.Q8.lib"`.cwd(`${DBG_ROOT}/lib`);
                await $`cp "MagickWand-7.Q8.dll.lib" "MagickWand-7.Q8.lib"`.cwd(`${DBG_ROOT}/lib`);
            }
        },
        imath: async () => {
            if (WIN && toolchainState().toolchain !== "msvc" && builtDebug) {
                await $`sd -s "/// @cond Doxygen_Suppress" "/*" ${`${DBG_ROOT}/include/Imath/ImathVec.h`}`;
                await $`sd -s "/// @endcond Doxygen_Suppress" "*/" ${`${DBG_ROOT}/include/Imath/ImathVec.h`}`;
            }
        },
        libarchive: async () => {
            if (WIN && builtRelease) {
                await stripDllImport(`${REL_ROOT}/include/archive.h`);
            }
        },
        libde265: async () => {
            if (WIN && builtRelease) {
                await stripDllImport(`${REL_ROOT}/include/libde265/de265.h`);
            }
        },
        libheif: async () => {
            if (builtRelease && WIN) {
                await stripDllImport(`${REL_ROOT}/include/libheif/heif_export.h`);
            }
        },
        "libjpeg-turbo": async () => {
            if (toolchainState().toolchain === "msvc" && builtRelease) {
                await copyLib(REL_ROOT, "jpeg-static.lib", "jpeg.lib");
            }
        },
        libjxl: async () => {
            if (builtRelease && WIN) {
                await stripDllImport(`${REL_ROOT}/include/jxl/jxl_export.h`);
            }
        },
        libpng: async () => {
            if (builtDebug) {
                if (WIN) {
                    if (toolchainState().toolchain === "msvc") {
                        await copyLib(DBG_ROOT, "libpng16.lib", "png16.lib");
                    } else {
                        await copyLib(DBG_ROOT, "libpng16.dll.a", "libpng.dll.a");
                    }
                }
            }

            if (builtRelease) {
                if (WIN) {
                    if (toolchainState().toolchain === "msvc") {
                        await copyLib(REL_ROOT, "libpng.lib", "png16.lib");
                    }
                }
            }
        },
        libraw: async () => {
            if (builtDebug) {
                if (toolchainState().toolchain === "msvc") {
                    if (toolchainState().useCodeview) {
                        await $`mv *.pdb ${`${DBG_ROOT}/bin`}`.cwd(`${path}/lib/.libs`);
                    }

                    await $`cp "raw.dll.lib" "raw.lib"`.cwd(`${DBG_ROOT}/lib`);
                    await $`cp "raw_r.dll.lib" "raw_r.lib"`.cwd(`${DBG_ROOT}/lib`);
                }

                await $`sd -s -- "-lstdc++" "" ${`${DBG_ROOT}/lib/pkgconfig/libraw.pc`}`;
                await $`sd -s -- "-lstdc++" "" ${`${DBG_ROOT}/lib/pkgconfig/libraw_r.pc`}`;
            }

            if (builtRelease) {
                await $`sd -s -- "-lstdc++" "" ${`${REL_ROOT}/lib/pkgconfig/libraw.pc`}`;
                await $`sd -s -- "-lstdc++" "" ${`${REL_ROOT}/lib/pkgconfig/libraw_r.pc`}`;

                await stripDllImport(`${REL_ROOT}/include/libraw/libraw_types.h`);
            }
        },
        libspng: async () => {
            if (builtDebug) {
                await $`sd -s -- "find_dependency(ZLIB REQUIRED)" "include(CMakeFindDependencyMacro)\nfind_dependency(ZLIB REQUIRED)" ${`${DBG_ROOT}/lib/cmake/spng/SPNGConfig.cmake`}`;
            }
            if (builtRelease) {
                await $`sd -s -- "find_dependency(ZLIB REQUIRED)" "include(CMakeFindDependencyMacro)\nfind_dependency(ZLIB REQUIRED)" ${`${REL_ROOT}/lib/cmake/spng/SPNGConfig.cmake`}`;
            }
        },
        libtool: async () => {
            if (WIN && builtDebug) {
                await $`sd -s -- "defined LIBLTDL_DLL_IMPORT" "1" ${`${DBG_ROOT}/include/libltdl/lt_system.h`}`;
            }
        },
        libxml2: async () => {
            if (toolchainState().toolchain === "msvc") {
                if (builtDebug) {
                    await copyLib(DBG_ROOT, "libxml2.lib", "xml2.lib");
                }
                if (builtRelease) {
                    await copyLib(REL_ROOT, "libxml2.lib", "xml2.lib");
                }
            }
        },
        "opencl-icd": async () => {
            if (WIN) {
                if (builtRelease) {
                    if (toolchainState().toolchain !== "msvc") {
                        await $`cp ${`${REL_ROOT}/lib/OpenCL.a`} ${`${REL_ROOT}/lib/libOpenCL.a`}`;
                    }
                }
            }
        },
        openh264: async () => {
            if (WIN) {
                if (builtRelease && toolchainState().toolchain === "msvc") {
                    await $`cp ${`${REL_ROOT}/lib/libopenh264.a`} ${`${REL_ROOT}/lib/openh264.lib`}`;
                }
            }
        },
        pcre2: async () => {
            if (WIN && builtRelease) {
                await stripDllImport(`${REL_ROOT}/include/pcre2.h`);
                await $`sd -s -- "STATIC IMPORTED" "STATIC IMPORTED GLOBAL" ${`${REL_ROOT}/lib/cmake/pcre2/pcre2-targets.cmake`}`;
            }

            if (builtDebug) {
                // for libgit2
                if (toolchainState().toolchain === "msvc") {
                    await $`cp ${`${DBG_ROOT}/lib/pcre2-8d.lib`} ${`${DBG_ROOT}/lib/pcre2-8.lib`}`;
                    await $`cp ${`${DBG_ROOT}/lib/pcre2-16d.lib`} ${`${DBG_ROOT}/lib/pcre2-16.lib`}`;
                    await $`cp ${`${DBG_ROOT}/lib/pcre2-posixd.lib`} ${`${DBG_ROOT}/lib/pcre2-posix.lib`}`;
                } else {
                    await $`cp ${`${DBG_ROOT}/lib/libpcre2-8d.dll.a`} ${`${DBG_ROOT}/lib/libpcre2-8.dll.a`}`;
                    await $`cp ${`${DBG_ROOT}/lib/libpcre2-16d.dll.a`} ${`${DBG_ROOT}/lib/libpcre2-16.dll.a`}`;
                    await $`cp ${`${DBG_ROOT}/lib/libpcre2-posixd.dll.a`} ${`${DBG_ROOT}/lib/libpcre2-posix.dll.a`}`;
                }
            }
        },
        xz: async () => {
            if (WIN && builtRelease) {
                await stripDllImport(`${REL_ROOT}/include/lzma.h`);
            }
        },
        "zlib-ng": async () => {
            if (builtDebug) {
                if (WIN) {
                    if (toolchainState().toolchain === "msvc") {
                        await $`cp ${`${DBG_ROOT}/lib/zlib.lib`} ${`${DBG_ROOT}/lib/z.lib`}`;
                    } else {
                        await $`cp ${`${DBG_ROOT}/lib/libzlib.dll.a`} ${`${DBG_ROOT}/lib/libz.dll.a`}`;
                    }
                }
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
            }
        },
        "double-conversion": async () => {
            await $`sd -s "if(BUILD_SHARED_LIBS AND MSVC)" "if(BUILD_SHARED_LIBS AND (MSVC OR (CMAKE_CXX_SIMULATE_ID STREQUAL "MSVC")))" CMakeLists.txt`.cwd(
                path,
            );
        },
        ffmpeg: async () => {
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
        glew: async () => {
            if (WIN) {
                if (toolchainState().toolchain === "msvc") {
                    await $`sd -s "target_compile_options (glew PRIVATE -fno-builtin -fno-stack-protector)" "" build/cmake/CMakeLists.txt`.cwd(
                        path,
                    );
                    await $`sd -s "target_compile_options (glew_s PRIVATE -fno-builtin -fno-stack-protector)" "" build/cmake/CMakeLists.txt`.cwd(
                        path,
                    );

                    await $`sd -s "target_link_libraries (glew LINK_PRIVATE -nostdlib)" "target_link_libraries (glew LINK_PRIVATE -lmsvcrt -lvcruntime)" build/cmake/CMakeLists.txt`.cwd(
                        path,
                    );
                }

                await $`sd -s "set (requireslib glu)" "# " build/cmake/CMakeLists.txt`.cwd(path);
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
        openexr: async () => {
            await $`sd -s -- "add_subdirectory(website/src)" "" CMakeLists.txt`.cwd(path);
        },
        pcre2: async () => {
            await $`git submodule update --depth 1 --init sljit`.cwd(`${path}/deps`);
        },
        projectm: async () => {
            await $`git submodule update --depth 1 --init --recursive`.cwd(path);
        },
        xz: async () => {
            if (toolchainState().toolchain === "msvc") {
                await $`sd -s -- "if(NOT MSVC AND NOT CYGWIN)" "if (NOT (MSVC OR (CMAKE_COMPILER_SIMULATE_ID STREQUAL "MSVC")) AND NOT CYGWIN)" CMakeLists.txt`.cwd(
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

    await bash`cd ${msysPath} && ${extraEnv} ${libsArg} ${configureCommand} ${configureArgs} ${buildType} --prefix=${toMsysPath(prefix)} ${libtoolFlags}`;

    if (libtool) {
        const libtoolPath = `${path}/libtool`;
        await $`sd -s -- "-fuse-ld=*|" "-f*|--target=*|-march=*|-mtune=*|-D*|-g*|-w*|" ${libtoolPath}`.noThrow();

        if (toolchain === "msvc") {
            await $`sd -s -- 'wl=""' 'wl="-Wl,"' ${libtoolPath}`;
        }
    }

    await bash`cd ${msysPath} && ${extraEnv} ${path.includes("icu") && toolchain === "msvc" ? `MSYS2_ARG_CONV_EXCL="*"` : ""} make -j2 && make install`;
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

    await bash`cd ${msysPath} && rm -f *.o *.a *.dll *.lib *.exp *.so *.pdb *.def`;
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
    await $`cmake -B ${dir} -S . -G Ninja --toolchain ${toolchainFile} --fresh -DBUILD_TOOLS=0 -DBUILD_DOCS=0 -DBUILD_DOC=0 -DBUILD_EXAMPLE=0 -DBUILD_EXAMPLES=0 -DBUILD_TESTING=0 -DBUILD_TESTS=0 -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=${isDebug} ${raw(arghook(name, isDebug))}`.cwd(
        cwd,
    );
    await $`cmake --build ${dir} -j`.cwd(cwd);
    await $`cmake --install ${dir}`.cwd(cwd);
}

export async function buildMeson(name: string, path: string, isDebug: boolean) {
    const dir = buildDir(isDebug),
        native = isDebug ? DEBUG_NATIVE : RELEASE_NATIVE;

    await $`meson setup ${dir} --native-file=${native} ${raw(arghook(name, isDebug))}`.cwd(path);
    await $`meson compile -C ${dir}`.cwd(path);
    await $`meson install -C ${dir}`.cwd(path);
}
