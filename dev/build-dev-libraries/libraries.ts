export const LIBRARIES: Library[] = [
    // --- Tier 0: no dependencies on anything else in this list ---
    { name: "opencl-headers", tag: "v2026.05.29", url: "https://github.com/KhronosGroup/OpenCL-Headers" },
    { tag: "v9.0.0", url: "https://github.com/stephenberry/glaze" },
    { tag: "v8.3.1", url: "https://github.com/fastfloat/fast_float" },
    { tag: "0.5.0", url: "https://github.com/ZXShady/enchantum" },
    { tag: "0.11.25", url: "https://github.com/mackron/miniaudio" },

    { tag: "v3.5.4", url: "https://github.com/microsoft/mimalloc" },
    { build: "Custom", tag: "v2.6.2", url: "https://github.com/autotools-mirror/libtool" },
    { build: "Custom", tag: "bzip2-1.0.8", url: "https://sourceware.org/git/bzip2", version: "1.0.8" },

    { tag: "v3.4.0", url: "https://github.com/google/double-conversion" },
    { tag: "2.3.3", url: "https://github.com/zlib-ng/zlib-ng" },
    { sourceSubdir: "build/cmake", tag: "v1.5.7", url: "https://github.com/facebook/zstd" },
    { tag: "v1.2.0", url: "https://github.com/google/brotli" },
    { tag: "1.4.0", url: "https://github.com/google/highway" },
    { tag: "v5.8.4", url: "https://github.com/tukaani-project/xz" },
    { tag: "v1.26", url: "https://github.com/ebiggers/libdeflate" },

    { tag: "release-0.5.3", url: "https://github.com/mity/md4c" },
    { archPkg: "quickjs-ng", tag: "v0.17.0", url: "https://github.com/quickjs-ng/quickjs" },
    { tag: "pcre2-10.49", url: "https://github.com/PCRE2Project/pcre2", version: "10.49" },
    { archPkg: "openjpeg2", tag: "v2.5.4", url: "https://github.com/uclouvain/openjpeg" },
    { tag: "0.32.0", url: "https://github.com/aous72/OpenJPH" },
    { tag: "v3.2.3", url: "https://github.com/AcademySoftwareFoundation/imath" },
    { name: "lcms2", tag: "lcms2.19.1", url: "https://github.com/mm2/Little-CMS" },
    { build: "Meson", tag: "v2.6.0", url: "https://github.com/cisco/openh264" },
    { build: "Meson", tag: "1.5.4", url: "https://code.videolan.org/videolan/dav1d" },
    { tag: "v2.3.2", url: "https://github.com/ultravideo/kvazaar" },
    { build: "Rust", tag: "v0.8.1", url: "https://github.com/xiph/rav1e" },
    { archPkg: "glfw", tag: "3.5.1", url: "https://github.com/glfw/glfw" },
    { build: "Custom", tag: "release-78.3", url: "https://github.com/unicode-org/icu" },
    { tag: "v1.1.3", url: "https://github.com/strukturag/libde265" },
    { tag: "v1.6.0", url: "https://github.com/webmproject/libwebp" },

    // --- Tier 1: depend only on Tier 0 libs ---
    {
        archPkg: "ocl-icd",
        name: "opencl-icd",
        tag: "v2026.05.29",
        url: "https://github.com/KhronosGroup/OpenCL-ICD-Loader",
    },
    { tag: "v0.7.4", url: "https://github.com/randy408/libspng" },
    // TODO: Switch to new release when it comes out, fixes CMakeLists dependency discovery
    { tag: "main", url: "https://github.com/libjpeg-turbo/libjpeg-turbo" },
    // TODO: Switch to v4.2.0 when it comes out
    { archPkg: "libprojectm", tag: "master", url: "https://github.com/projectM-visualizer/projectm" },
    { tag: "v1.6.59", url: "https://github.com/pnggroup/libpng" },
    { tag: "v5.1.9", url: "https://github.com/nuspell/nuspell" },
    {
        archiveSubdir: "LibRaw-0.22.2",
        build: "Custom",
        name: "libraw",
        tag: "",
        url: "https://www.libraw.org/data/LibRaw-0.22.2-Win64.zip",
        version: "0.22.2",
    },
    { tag: "v2.15.4", url: "https://gitlab.gnome.org/GNOME/libxml2" },
    { tag: "v1.11.4", url: "https://github.com/nih-at/libzip/" },
    { tag: "v4.7.2", url: "https://gitlab.com/libtiff/libtiff" },
    { tag: "v3.5.2", url: "https://github.com/AcademySoftwareFoundation/openexr" },
    { archPkg: "freetype2", tag: "VER-2-14-3", url: "https://gitlab.freedesktop.org/freetype/freetype" },
    { tag: "v1.9.7", url: "https://github.com/libgit2/libgit2" },

    // --- Tier 2: depend on Tier 1 libs ---
    { tag: "release-1.4.5", url: "https://github.com/fltk/fltk" },
    { tag: "14.6.0", url: "https://github.com/harfbuzz/harfbuzz" },
    { tag: "v0.12.0", url: "https://github.com/libjxl/libjxl" },
    { tag: "v3.8.9", url: "https://github.com/libarchive/libarchive" },

    // --- Tier 3: depends on Tier 2/1 ---
    { tag: "v1.23.6", url: "https://github.com/strukturag/libheif" },
    { build: "Meson", tag: "mesa-26.2.4", url: "https://gitlab.freedesktop.org/mesa/mesa" },
    { tag: "v2.0.2", url: "https://github.com/google/libultrahdr" },

    // --- End-user apps, excluded from dependency ordering ---
    { build: "Custom", tag: "n8.1.3", url: "https://github.com/FFmpeg/FFmpeg" },
    { build: "Custom", tag: "7.1.2-32", url: "https://github.com/imagemagick/imagemagick" },
    { archPkg: "qt6-base", build: "Custom", tag: "v6.12.0", url: "https://github.com/qt/qt5" },
    { archPkg: "upx", tag: "devel", url: "https://github.com/upx/upx" },
];

export function resolveLibraryName(library: Library) {
    return library.name ?? library.url.replace(/\/+$/, "").split("/").pop()!.toLowerCase();
}

export function getPin(library: Library): string {
    if (library.archiveSubdir) {
        return library.url;
    }
    return library.tag;
}

export function shouldBuildLibrary(name: string, options: CliOptions): boolean {
    const key = name.toLowerCase();
    if (options.only) {
        return options.only.has(key);
    }
    return !options.exclude.has(key);
}
