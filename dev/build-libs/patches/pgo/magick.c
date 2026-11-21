// PGO training workload for ImageMagick's coders and the libraries behind them. The matrix mirrors what vu reads and
// writes (its save dialog's formats, pixel layouts and options): every row is encoded once and then decoded several
// times, because a viewer decodes far more than it encodes and the hot/cold split is judged over the whole merged
// profile. Each decode does what vu does with a decoded image: ping, export to 8-bit RGBA, and a thumbnail.
// Failures are skipped on purpose (a missing encoder or system file must not stop the rest of the workload), but they
// are counted in the summary line.
// Inputs carry what camera files carry: an EXIF block (with an orientation, which the decode applies), an ICC profile and
// XMP, so the metadata code that runs on every read is trained too. Half of the encodes go to a file rather than a memory
// blob, as vu's saves do.
// argv[1..]: photographs (PNG); the matrix runs on every one, in the shapes its rows ask for. An optional leading
// --only=a,b limits the run to those formats (lower case) and works (animation, ora, uhdr, icc, svg, raw, htj2k, heicgrid,
// large), which pgo.ts uses to weight the groups against each other. Any failed row is a failure of the run.
#include <MagickWand/MagickWand.h>
#include <openexr.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <libheif/heif.h>
#include <zip.h>

enum { DECODES = 4, MAX_PHOTOS = 4, THUMBNAIL_EDGE = 128, LARGE_DECODES = 2 };

// What the source image looks like when it reaches the encoder.
typedef enum { SHAPE_RGB, SHAPE_RGBA, SHAPE_GRAY, SHAPE_GRAYA, SHAPE_BILEVEL, SHAPE_PALETTE, SHAPE_CMYK, SHAPE_COUNT } Shape;

typedef struct {
    const char *format;
    CompressionType compression; // Undefined: the coder's default
    size_t quality;              // 0: the coder's default (PNG: 75 = adaptive row filters, level 7)
    size_t depth;                // 0: the source's own 8 bits
    InterlaceType interlace;     // Undefined: none (PNG: Adam7, JPEG: progressive, GIF: interlaced)
    Shape shape;
    size_t fit;                  // largest edge the format allows (ICO), 0: unlimited
    int raw;                     // headerless pixels: decoding needs the size, depth and format up front
    const char *options[4];      // "key=value" passed to MagickSetOption before encoding
} Codec;

static const Codec CODECS[] = {
    // PNG
    {.format = "PNG", .options = {"png:color-type=2"}},
    {.format = "PNG", .interlace = PNGInterlace, .options = {"png:color-type=2"}},
    {.format = "PNG", .options = {"png:color-type=2", "png:compression-level=1"}},
    {.format = "PNG", .options = {"png:color-type=2", "png:compression-level=4"}},
    {.format = "PNG", .options = {"png:color-type=2", "png:compression-level=9", "png:compression-filter=5"}},
    {.format = "PNG", .options = {"png:color-type=2", "png:compression-filter=2"}},
    {.format = "PNG", .options = {"png:color-type=2", "png:compression-filter=4", "png:compression-strategy=3"}},
    {.format = "PNG", .depth = 16, .options = {"png:color-type=2"}},
    {.format = "PNG", .shape = SHAPE_RGBA, .options = {"png:color-type=6"}},
    {.format = "PNG", .shape = SHAPE_RGBA, .depth = 16, .options = {"png:color-type=6"}},
    {.format = "PNG", .shape = SHAPE_GRAY, .options = {"png:color-type=0"}},
    {.format = "PNG", .shape = SHAPE_GRAY, .depth = 16, .options = {"png:color-type=0"}},
    {.format = "PNG", .shape = SHAPE_GRAYA, .options = {"png:color-type=4"}},
    {.format = "PNG", .shape = SHAPE_GRAYA, .depth = 16, .options = {"png:color-type=4"}},
    {.format = "PNG", .shape = SHAPE_PALETTE, .options = {"png:color-type=3"}},
    {.format = "PNG", .shape = SHAPE_BILEVEL, .depth = 1, .options = {"png:color-type=0"}},

    // JPEG: IM picks 4:4:4 from quality 90 up and libjpeg's 4:2:0 below.
    {.format = "JPEG", .quality = 75},
    {.format = "JPEG", .quality = 40},
    {.format = "JPEG", .quality = 90},
    {.format = "JPEG", .quality = 85, .options = {"jpeg:sampling-factor=2x1"}},
    {.format = "JPEG", .quality = 75, .interlace = JPEGInterlace},
    {.format = "JPEG", .quality = 75, .options = {"jpeg:optimize-coding=true"}},
    {.format = "JPEG", .quality = 75, .shape = SHAPE_GRAY},
    {.format = "JPEG", .quality = 75, .shape = SHAPE_CMYK},
    {.format = "JPEG", .quality = 90, .depth = 12, .options = {"jpeg:high-bit-depth=true"}},

    // WebP
    {.format = "WEBP", .quality = 75},
    {.format = "WEBP", .quality = 75, .options = {"webp:method=6"}},
    {.format = "WEBP", .quality = 40, .options = {"webp:method=0"}},
    {.format = "WEBP", .quality = 75, .options = {"webp:image-hint=photo"}},
    {.format = "WEBP", .quality = 75, .shape = SHAPE_RGBA},
    {.format = "WEBP", .quality = 100, .options = {"webp:lossless=true"}},
    {.format = "WEBP", .quality = 100, .shape = SHAPE_RGBA, .options = {"webp:lossless=true"}},
    {.format = "WEBP", .quality = 100, .options = {"webp:lossless=true", "webp:near-lossless=60"}},

    // TIFF
    {.format = "TIFF", .compression = NoCompression},
    {.format = "TIFF", .compression = LZWCompression},
    {.format = "TIFF", .compression = LZWCompression, .options = {"tiff:predictor=2"}},
    {.format = "TIFF", .compression = ZipCompression},
    {.format = "TIFF", .compression = ZipCompression, .options = {"tiff:predictor=2"}},
    {.format = "TIFF", .compression = ZipCompression, .depth = 16, .options = {"tiff:predictor=2"}},
    {.format = "TIFF", .compression = RLECompression},
    {.format = "TIFF", .compression = JPEGCompression, .quality = 85},
    {.format = "TIFF", .compression = LZMACompression},
    {.format = "TIFF", .compression = ZstdCompression},
    {.format = "TIFF", .compression = WebPCompression, .quality = 85},
    {.format = "TIFF", .compression = LZWCompression, .options = {"tiff:rows-per-strip=16", "tiff:endian=msb"}},
    {.format = "TIFF", .compression = ZipCompression, .options = {"tiff:tile-geometry=128x128"}},
    {.format = "TIFF", .compression = LZWCompression, .shape = SHAPE_RGBA},
    {.format = "TIFF", .compression = ZipCompression, .shape = SHAPE_CMYK},
    {.format = "TIFF", .compression = LZWCompression, .shape = SHAPE_GRAY},
    {.format = "TIFF", .compression = ZipCompression, .shape = SHAPE_GRAY, .depth = 16},
    {.format = "TIFF", .compression = LZWCompression, .shape = SHAPE_PALETTE},
    {.format = "TIFF", .compression = Group4Compression, .shape = SHAPE_BILEVEL},
    {.format = "TIFF", .compression = FaxCompression, .shape = SHAPE_BILEVEL},

    // OpenEXR (half floats); the rest of the HTJ2K family is written below through the core API.
    {.format = "EXR", .compression = NoCompression},
    {.format = "EXR", .compression = RLECompression},
    {.format = "EXR", .compression = ZipSCompression},
    {.format = "EXR", .compression = ZipCompression},
    {.format = "EXR", .compression = PizCompression},
    {.format = "EXR", .compression = Pxr24Compression},
    {.format = "EXR", .compression = B44Compression},
    {.format = "EXR", .compression = B44ACompression},
    {.format = "EXR", .compression = DWAACompression},
    {.format = "EXR", .compression = DWABCompression},
    {.format = "EXR", .compression = ZipCompression, .shape = SHAPE_RGBA},

    // JPEG XL
    {.format = "JXL", .quality = 90, .options = {"jxl:effort=3"}},
    {.format = "JXL", .quality = 75},
    {.format = "JXL", .quality = 90, .options = {"jxl:decoding-speed=3"}},
    {.format = "JXL", .quality = 100, .options = {"jxl:effort=5"}},
    {.format = "JXL", .quality = 90, .shape = SHAPE_RGBA, .depth = 16},
    {.format = "JXL", .quality = 100, .depth = 16},
    {.format = "JXL", .quality = 90, .shape = SHAPE_GRAY},
    {.format = "JXL", .quality = 90, .depth = 32},

    // JPEG 2000
    {.format = "JP2", .quality = 80},
    {.format = "JP2", .quality = 100},
    {.format = "JP2", .quality = 80, .options = {"jp2:progression-order=RPCL"}},
    {.format = "JP2", .quality = 80, .shape = SHAPE_RGBA},
    {.format = "JP2", .quality = 80, .shape = SHAPE_GRAY, .depth = 16},
    {.format = "JP2", .quality = 80, .depth = 12},
    {.format = "J2K", .quality = 80},

    // libheif: kvazaar only encodes 8-bit HEVC and has no "speed" parameter (ImageMagick fails the write if it's set); AV1
    // (rav1e) does 8, 10 and 12 bits and every chroma format.
    {.format = "HEIC", .quality = 75},
    {.format = "HEIC", .quality = 75, .shape = SHAPE_RGBA},
    {.format = "AVIF", .quality = 75, .options = {"heic:speed=9"}},
    {.format = "AVIF", .quality = 75, .depth = 10, .options = {"heic:speed=9"}},
    {.format = "AVIF", .quality = 75, .depth = 12, .options = {"heic:speed=9"}},
    {.format = "AVIF", .quality = 75, .shape = SHAPE_RGBA, .options = {"heic:speed=9"}},
    {.format = "AVIF", .quality = 75, .options = {"heic:speed=9", "heic:chroma=444"}},
    {.format = "AVIF", .quality = 75, .options = {"heic:speed=9", "heic:chroma=422"}},

    // ImageMagick's own coders
    {.format = "GIF", .shape = SHAPE_PALETTE},
    {.format = "GIF", .shape = SHAPE_PALETTE, .interlace = GIFInterlace},
    {.format = "MIFF", .compression = NoCompression},
    {.format = "MIFF", .compression = RLECompression},
    {.format = "MIFF", .compression = LZWCompression},
    {.format = "MIFF", .compression = ZipCompression, .depth = 16},
    {.format = "MIFF", .compression = BZipCompression},
    {.format = "MIFF", .compression = LZMACompression},
    {.format = "MIFF", .compression = ZstdCompression},
    {.format = "BMP", .options = {"bmp:format=bmp3"}},
    {.format = "BMP", .shape = SHAPE_RGBA},
    {.format = "BMP", .shape = SHAPE_PALETTE, .compression = NoCompression},
    {.format = "BMP", .shape = SHAPE_PALETTE, .compression = RLECompression},
    {.format = "BMP", .shape = SHAPE_BILEVEL, .depth = 1},
    {.format = "TGA"},
    {.format = "TGA", .compression = RLECompression},
    {.format = "TGA", .compression = RLECompression, .shape = SHAPE_RGBA, .options = {"tga:write-footer=true"}},
    {.format = "TGA", .shape = SHAPE_GRAY},
    {.format = "PPM", .compression = RLECompression},
    {.format = "PPM", .compression = NoCompression},
    {.format = "PPM", .compression = RLECompression, .depth = 16},
    {.format = "PGM", .compression = RLECompression, .shape = SHAPE_GRAY},
    {.format = "PGM", .compression = NoCompression, .shape = SHAPE_GRAY},
    {.format = "PGM", .compression = RLECompression, .shape = SHAPE_GRAY, .depth = 16},
    {.format = "PBM", .compression = RLECompression, .shape = SHAPE_BILEVEL},
    {.format = "PBM", .compression = NoCompression, .shape = SHAPE_BILEVEL},
    {.format = "ICO", .compression = ZipCompression, .shape = SHAPE_RGBA, .fit = 256, .options = {"icon:auto-resize=256,48,32,16"}},
    {.format = "ICO", .compression = RLECompression, .shape = SHAPE_RGBA, .fit = 256},
    {.format = "DDS", .shape = SHAPE_RGBA, .options = {"dds:compression=dxt5", "dds:mipmaps=4"}},
    {.format = "DDS", .shape = SHAPE_RGBA, .options = {"dds:compression=dxt5", "dds:cluster-fit=true"}},
    {.format = "DDS", .options = {"dds:compression=dxt1"}},
    {.format = "DDS", .shape = SHAPE_RGBA, .options = {"dds:compression=none"}},
    {.format = "PCX", .compression = NoCompression, .shape = SHAPE_PALETTE},
    {.format = "PCX", .compression = RLECompression},
    {.format = "QOI"},
    {.format = "QOI", .shape = SHAPE_RGBA},
    {.format = "XPM", .shape = SHAPE_PALETTE},
    {.format = "HDR"},
    {.format = "PSD", .compression = RLECompression},
    {.format = "PSD", .compression = ZipCompression},
    {.format = "PSD", .compression = RLECompression, .shape = SHAPE_RGBA, .depth = 16},
    {.format = "RGB", .raw = 1, .depth = 8},
    {.format = "GRAY", .raw = 1, .depth = 8, .shape = SHAPE_GRAY},
};

static unsigned codecsRun, codecsFailed;
static unsigned char *pixels;
static size_t pixelsSize;

static const char *only; // the --only= list, NULL: everything

static int wanted(const char *name) {
    if (!only) {
        return 1;
    }
    const size_t length = strlen(name);
    for (const char *at = only; *at;) {
        const char *end = strchr(at, ',');
        const size_t part = end ? (size_t)(end - at) : strlen(at);
        if (part == length && strncasecmp(at, name, length) == 0) {
            return 1;
        }
        at += part + (end ? 1 : 0);
    }
    return 0;
}

static void report(const char *what, MagickWand *wand) {
    ExceptionType severity;
    char *reason = MagickGetException(wand, &severity);
    fprintf(stderr, "skip: %s (%s)\n", what, reason);
    MagickRelinquishMemory(reason);
}

/** Exports the current image to 8-bit RGBA, as vu does for every image it shows. */
static void exportRgba(MagickWand *wand) {
    const size_t width = MagickGetImageWidth(wand), height = MagickGetImageHeight(wand), need = width * height * 4;
    if (need > pixelsSize) {
        free(pixels);
        pixels = malloc(need);
        pixelsSize = pixels ? need : 0;
    }
    if (pixels) {
        MagickExportImagePixels(wand, 0, 0, width, height, "RGBA", CharPixel, pixels);
    }
}

/** vu's preview path: thumbnail to fit the box (sampling first when it is much larger), then export. */
static void thumbnailRgba(const MagickWand *src, size_t edge) {
    MagickWand *thumb = CloneMagickWand(src);
    const size_t width = MagickGetImageWidth(thumb), height = MagickGetImageHeight(thumb),
                 longest = width > height ? width : height;
    if (longest > edge) {
        const size_t newWidth = width * edge / longest, newHeight = height * edge / longest;
        MagickThumbnailImage(thumb, newWidth ? newWidth : 1, newHeight ? newHeight : 1);
    }
    exportRgba(thumb);
    DestroyMagickWand(thumb);
}

/** Reads a blob; formats without a magic number (TGA, ICO) need their name as a hint, as a file's extension is for vu. */
static MagickBooleanType readBlob(MagickWand *wand, const unsigned char *blob, size_t length, const Codec *codec) {
    if (MagickReadImageBlob(wand, blob, length) == MagickTrue) {
        return MagickTrue;
    }
    MagickClearException(wand);
    MagickSetFormat(wand, codec->format);
    return MagickReadImageBlob(wand, blob, length);
}

static void headerless(MagickWand *wand, const Codec *codec, size_t width, size_t height) {
    if (codec->raw) {
        MagickSetSize(wand, width, height);
        MagickSetDepth(wand, 8);
        MagickSetFormat(wand, codec->format);
    }
}

/** The shaped source: the photograph as the encoder will see it. */
static MagickWand *makeShape(const MagickWand *photo, Shape shape) {
    MagickWand *wand = CloneMagickWand(photo);
    const size_t width = MagickGetImageWidth(wand), height = MagickGetImageHeight(wand);
    switch (shape) {
        case SHAPE_RGB:
        case SHAPE_COUNT:
            break;
        case SHAPE_RGBA:
        case SHAPE_GRAYA: {
            // A radial fade with fully transparent and fully opaque regions, built from pixels so it doesn't depend on
            // how a compose operator treats a gradient.
            unsigned char *rgba = malloc(width * height * 4);
            if (rgba && MagickExportImagePixels(wand, 0, 0, width, height, "RGB", CharPixel, rgba) == MagickTrue) {
                // Expand in place from the back so the RGB triplets aren't overwritten.
                for (size_t i = width * height; i-- > 0;) {
                    const size_t x = i % width, y = i / width;
                    const double dx = ((double)x - (double)width / 2) / ((double)width / 2),
                                 dy = ((double)y - (double)height / 2) / ((double)height / 2),
                                 fade = 1.4 - (dx * dx + dy * dy) * 1.4;
                    const unsigned char red = rgba[i * 3], green = rgba[i * 3 + 1], blue = rgba[i * 3 + 2];
                    rgba[i * 4] = red;
                    rgba[i * 4 + 1] = green;
                    rgba[i * 4 + 2] = blue;
                    rgba[i * 4 + 3] = (unsigned char)(fade <= 0 ? 0 : fade >= 1 ? 255 : fade * 255);
                }
                MagickWand *alpha = NewMagickWand();
                if (MagickConstituteImage(alpha, width, height, "RGBA", CharPixel, rgba) == MagickTrue) {
                    DestroyMagickWand(wand);
                    wand = alpha;
                } else {
                    DestroyMagickWand(alpha);
                }
            }
            free(rgba);
            if (shape == SHAPE_GRAYA) {
                MagickSetImageType(wand, GrayscaleAlphaType);
            }
            break;
        }
        case SHAPE_GRAY:
            MagickSetImageType(wand, GrayscaleType);
            break;
        case SHAPE_BILEVEL:
            MagickSetImageType(wand, BilevelType);
            break;
        case SHAPE_PALETTE:
            MagickQuantizeImage(wand, 256, sRGBColorspace, 0, FloydSteinbergDitherMethod, MagickFalse);
            break;
        case SHAPE_CMYK:
            MagickTransformImageColorspace(wand, CMYKColorspace);
            break;
    }
    return wand;
}

// A camera's EXIF block: "Exif" and a little-endian TIFF with IFD0 (make, model, orientation, resolution, date and the
// Exif IFD pointer) and the Exif IFD (exposure, aperture, ISO, date, focal length, colour space, size).
static unsigned char exifBlob[312];
static int exifOrientation = 1;
static unsigned char *iccProfile;
static size_t iccLength;

static void le16(unsigned char *at, unsigned value) {
    at[0] = (unsigned char)value;
    at[1] = (unsigned char)(value >> 8);
}

static void le32(unsigned char *at, unsigned value) {
    le16(at, value & 0xffff);
    le16(at + 2, value >> 16);
}

static void tag(unsigned char *tiff, size_t at, unsigned id, unsigned type, unsigned count, unsigned value) {
    le16(tiff + at, id);
    le16(tiff + at + 2, type);
    le32(tiff + at + 4, count);
    if (type == 3) {
        le16(tiff + at + 8, value);
    } else {
        le32(tiff + at + 8, value);
    }
}

static void makeExif(int orientation) {
    unsigned char *tiff = exifBlob + 6;
    memset(exifBlob, 0, sizeof exifBlob);
    memcpy(exifBlob, "Exif" "\0\0", 6);
    memcpy(tiff, "II*" "\0", 4);
    le32(tiff + 4, 8);
    // IFD0 at 8: 8 entries, then its data at 110.
    le16(tiff + 8, 8);
    tag(tiff, 10, 271, 2, 6, 110);
    tag(tiff, 22, 272, 2, 8, 116);
    tag(tiff, 34, 274, 3, 1, (unsigned)orientation);
    tag(tiff, 46, 282, 5, 1, 124);
    tag(tiff, 58, 283, 5, 1, 132);
    tag(tiff, 70, 296, 3, 1, 2);
    tag(tiff, 82, 306, 2, 20, 140);
    tag(tiff, 94, 34665, 4, 1, 160);
    memcpy(tiff + 110, "Synth", 5);
    memcpy(tiff + 116, "Trainer", 7);
    le32(tiff + 124, 72);
    le32(tiff + 128, 1);
    le32(tiff + 132, 72);
    le32(tiff + 136, 1);
    memcpy(tiff + 140, "2024:05:17 12:34:56", 19);
    // Exif IFD at 160: 8 entries, then its data at 262.
    le16(tiff + 160, 8);
    tag(tiff, 162, 33434, 5, 1, 262);
    tag(tiff, 174, 33437, 5, 1, 270);
    tag(tiff, 186, 34855, 3, 1, 400);
    tag(tiff, 198, 36867, 2, 20, 278);
    tag(tiff, 210, 37386, 5, 1, 298);
    tag(tiff, 222, 40961, 3, 1, 1);
    tag(tiff, 234, 40962, 4, 1, 768);
    tag(tiff, 246, 40963, 4, 1, 512);
    le32(tiff + 262, 1);
    le32(tiff + 266, 250);
    le32(tiff + 270, 28);
    le32(tiff + 274, 10);
    memcpy(tiff + 278, "2024:05:17 12:34:56", 19);
    le32(tiff + 298, 350);
    le32(tiff + 302, 10);
}

static const char XMP[] =
    "<?xpacket begin='\xEF\xBB\xBF' id='W5M0MpCehiHzreSzNTczkc9d'?>"
    "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>"
    "<rdf:Description rdf:about='' xmlns:dc='http://purl.org/dc/elements/1.1/' xmlns:xmp='http://ns.adobe.com/xap/1.0/'>"
    "<dc:creator><rdf:Seq><rdf:li>Trainer</rdf:li></rdf:Seq></dc:creator>"
    "<dc:title><rdf:Alt><rdf:li xml:lang='x-default'>Synthetic</rdf:li></rdf:Alt></dc:title>"
    "<xmp:CreatorTool>PGO</xmp:CreatorTool><xmp:Rating>3</xmp:Rating></rdf:Description></rdf:RDF></x:xmpmeta>"
    "<?xpacket end='w'?>";

static unsigned char *readFile(const char *path, size_t *length);

/** Encodes to a memory blob, or, with `toFile`, through a file as vu's saves do. */
static unsigned char *encode(const MagickWand *shaped, const Codec *codec, size_t *length, int toFile) {
    MagickWand *wand = CloneMagickWand(shaped);
    if (codec->fit) {
        const size_t width = MagickGetImageWidth(wand), height = MagickGetImageHeight(wand),
                     longest = width > height ? width : height;
        if (longest > codec->fit) {
            MagickResizeImage(wand, width * codec->fit / longest, height * codec->fit / longest, LanczosFilter);
        }
    }
    MagickSetImageFormat(wand, codec->format);
    if (codec->compression != UndefinedCompression) {
        MagickSetImageCompression(wand, codec->compression);
    }
    if (codec->quality) {
        MagickSetImageCompressionQuality(wand, codec->quality);
    }
    if (codec->depth) {
        MagickSetImageDepth(wand, codec->depth);
    }
    if (codec->interlace != UndefinedInterlace) {
        MagickSetInterlaceScheme(wand, codec->interlace);
    }
    for (size_t i = 0; i < sizeof codec->options / sizeof *codec->options && codec->options[i]; i++) {
        char key[64];
        const char *value = strchr(codec->options[i], '=');
        snprintf(key, sizeof key, "%.*s", (int)(value - codec->options[i]), codec->options[i]);
        MagickSetOption(wand, key, value + 1);
    }
    // Metadata, as a camera file has it. The profile is attached, not applied. Gray and CMYK pixels don't take an sRGB profile.
    MagickSetImageProfile(wand, "exif", exifBlob, sizeof exifBlob);
    MagickSetImageProfile(wand, "xmp", XMP, sizeof XMP - 1);
    if (iccProfile && (codec->shape == SHAPE_RGB || codec->shape == SHAPE_RGBA)) {
        MagickSetImageProfile(wand, "icc", iccProfile, iccLength);
    }
    unsigned char *blob;
    if (toFile) {
        char target[64];
        snprintf(target, sizeof target, "%s:train-out.tmp", codec->format);
        blob = MagickWriteImage(wand, target) == MagickTrue ? readFile("train-out.tmp", length) : NULL;
        remove("train-out.tmp");
    } else {
        blob = MagickGetImageBlob(wand, length);
    }
    if (!blob) {
        report(codec->format, wand);
    }
    DestroyMagickWand(wand);
    return blob;
}

static void roundtrip(MagickWand *shaped, const Codec *codec, int decodes, int toFile) {
    size_t length = 0;
    unsigned char *blob = encode(shaped, codec, &length, toFile);
    ++codecsRun;
    if (!blob) {
        ++codecsFailed;
        return;
    }
    const size_t width = MagickGetImageWidth(shaped), height = MagickGetImageHeight(shaped);

    // A directory scan pings the file before anything else.
    MagickWand *probe = NewMagickWand();
    headerless(probe, codec, width, height);
    if (MagickPingImageBlob(probe, blob, length) != MagickTrue) {
        MagickClearException(probe);
        MagickSetFormat(probe, codec->format);
        MagickPingImageBlob(probe, blob, length);
    }
    DestroyMagickWand(probe);

    for (int round = 0; round < decodes; round++) {
        MagickWand *back = NewMagickWand();
        headerless(back, codec, width, height);
        if (readBlob(back, blob, length, codec) == MagickTrue) {
            MagickAutoOrientImage(back);
            exportRgba(back);
            if (round % 2 == 1) {
                thumbnailRgba(back, THUMBNAIL_EDGE);
            }
        } else {
            if (round == 0) {
                ++codecsFailed;
                report(codec->format, back);
            }
            DestroyMagickWand(back);
            break;
        }
        DestroyMagickWand(back);
    }
    MagickRelinquishMemory(blob);
}

// Animations: vu decodes GIF and WebP up front through ImageMagick when FFmpeg isn't there, one coalesced frame at a time.
static void animationWork(const MagickWand *photo) {
    static const char *const FORMATS[] = {"GIF", "WEBP", "APNG", "JXL", "TIFF"};
    enum { FRAMES = 8, FRAME_WIDTH = 256, FRAME_HEIGHT = 192 };
    MagickWand *animation = NewMagickWand();
    for (int i = 0; i < FRAMES; i++) {
        MagickWand *frame = CloneMagickWand(photo);
        MagickCropImage(frame, FRAME_WIDTH, FRAME_HEIGHT, i * 40, i * 20);
        MagickResetImagePage(frame, "0x0+0+0");
        MagickSetImageDelay(frame, 8);
        MagickAddImage(animation, frame);
        DestroyMagickWand(frame);
    }
    MagickSetImageIterations(animation, 0);

    for (size_t f = 0; f < sizeof FORMATS / sizeof *FORMATS; f++) {
        ++codecsRun;
        MagickWand *copy = CloneMagickWand(animation);
        MagickSetFormat(copy, FORMATS[f]);
        size_t length = 0;
        unsigned char *blob = MagickGetImagesBlob(copy, &length);
        if (!blob) {
            ++codecsFailed;
            report(FORMATS[f], copy);
            DestroyMagickWand(copy);
            continue;
        }
        DestroyMagickWand(copy);

        MagickWand *probe = NewMagickWand();
        MagickPingImageBlob(probe, blob, length);
        DestroyMagickWand(probe);

        for (int round = 0; round < DECODES; round++) {
            MagickWand *back = NewMagickWand();
            if (MagickReadImageBlob(back, blob, length) != MagickTrue) {
                if (round == 0) {
                    ++codecsFailed;
                    report(FORMATS[f], back);
                }
                DestroyMagickWand(back);
                break;
            }
            MagickWand *frames = MagickCoalesceImages(back);
            if (frames) {
                MagickResetIterator(frames);
                while (MagickNextImage(frames) == MagickTrue) {
                    exportRgba(frames);
                }
                DestroyMagickWand(frames);
            }
            DestroyMagickWand(back);
        }
        MagickRelinquishMemory(blob);
    }
    DestroyMagickWand(animation);
}

static unsigned char *readFile(const char *path, size_t *length) {
    FILE *file = fopen(path, "rb");
    if (!file) {
        return NULL;
    }
    fseek(file, 0, SEEK_END);
    *length = (size_t)ftell(file);
    rewind(file);
    unsigned char *data = malloc(*length);
    if (fread(data, 1, *length, file) != *length) {
        free(data);
        data = NULL;
    }
    fclose(file);
    return data;
}

// libraw: a synthetic uncompressed 16-bit RGGB DNG (smooth gradient plus noise), decoded and demosaiced by libraw. Compressed
// DNGs (lossless JPEG) aren't covered: libraw only inflates floating-point DNGs and nothing here writes lossless JPEG.
enum { DNG_WIDTH = 512, DNG_HEIGHT = 384, DNG_ENTRIES = 19 };

static void put16(unsigned char *buf, size_t at, unsigned value) {
    buf[at] = (unsigned char)value;
    buf[at + 1] = (unsigned char)(value >> 8);
}

static void put32(unsigned char *buf, size_t at, unsigned value) {
    put16(buf, at, value & 0xffff);
    put16(buf, at + 2, value >> 16);
}

static unsigned char *makeDng(size_t *length) {
    static const char make[] = "Synth", model[] = "Trainer", unique[] = "Synth Trainer";
    // XYZ -> camera RGB (sRGB primaries), times 10000.
    static const int matrix[9] = {32406, -15372, -4986, -9689, 18758, 415, 557, -2040, 10570};
    const size_t ifdSize = 2 + DNG_ENTRIES * 12 + 4, makeAt = 8 + ifdSize, modelAt = makeAt + sizeof make,
                 uniqueAt = modelAt + sizeof model, matrixAt = (uniqueAt + sizeof unique + 3) & ~(size_t)3,
                 neutralAt = matrixAt + sizeof matrix * 2, pixelsAt = neutralAt + 24,
                 pixelBytes = (size_t)DNG_WIDTH * DNG_HEIGHT * 2;
    unsigned char *buf = calloc(1, pixelsAt + pixelBytes);
    size_t entry = 8 + 2;
    memcpy(buf, "II*\0", 4);
    put32(buf, 4, 8);
    put16(buf, 8, DNG_ENTRIES);

#define TAG(id, type, count, value)                                                                                    \
    do {                                                                                                               \
        put16(buf, entry, id);                                                                                         \
        put16(buf, entry + 2, type);                                                                                   \
        put32(buf, entry + 4, count);                                                                                  \
        put32(buf, entry + 8, value);                                                                                  \
        entry += 12;                                                                                                   \
    } while (0)
    // type 1 byte, 2 ascii, 3 short, 4 long, 5 rational, 10 srational; values that fit in 4 bytes are stored inline.
    TAG(254, 4, 1, 0);
    TAG(256, 4, 1, DNG_WIDTH);
    TAG(257, 4, 1, DNG_HEIGHT);
    TAG(258, 3, 1, 16);
    TAG(259, 3, 1, 1);
    TAG(262, 3, 1, 32803); // CFA
    TAG(271, 2, sizeof make, makeAt);
    TAG(272, 2, sizeof model, modelAt);
    TAG(273, 4, 1, pixelsAt);
    TAG(274, 3, 1, 1);
    TAG(277, 3, 1, 1);
    TAG(278, 4, 1, DNG_HEIGHT);
    TAG(279, 4, 1, pixelBytes);
    TAG(33421, 3, 2, 2 | (2 << 16));  // CFARepeatPatternDim
    TAG(33422, 1, 4, 0x02010100);     // CFAPattern: R G / G B
    TAG(50706, 1, 4, 0x00000401);     // DNGVersion 1.4.0.0
    TAG(50708, 2, sizeof unique, uniqueAt);
    TAG(50717, 3, 1, 65535);          // WhiteLevel
    TAG(50721, 10, 9, matrixAt);      // ColorMatrix1
#undef TAG
    // TIFF requires tags in ascending order; 50728/50778 would follow, but DNG_ENTRIES stops at ColorMatrix1 and libraw
    // falls back to a neutral white balance and D65 without them.
    memcpy(buf + makeAt, make, sizeof make);
    memcpy(buf + modelAt, model, sizeof model);
    memcpy(buf + uniqueAt, unique, sizeof unique);
    for (size_t i = 0; i < 9; i++) {
        put32(buf, matrixAt + i * 8, (unsigned)matrix[i]);
        put32(buf, matrixAt + i * 8 + 4, 10000);
    }
    unsigned seed = 12345;
    for (size_t y = 0; y < DNG_HEIGHT; y++) {
        for (size_t x = 0; x < DNG_WIDTH; x++) {
            seed = seed * 1664525u + 1013904223u;
            unsigned value = (unsigned)(x * 60 + y * 80) % 52000 + 4000 + ((seed >> 24) & 0x3ff);
            put16(buf, pixelsAt + (y * DNG_WIDTH + x) * 2, value);
        }
    }
    *length = pixelsAt + pixelBytes;
    return buf;
}

static void rawWork(void) {
    size_t length = 0;
    unsigned char *dng = makeDng(&length);
    for (int round = 0; round < DECODES; round++) {
        MagickWand *wand = NewMagickWand();
        MagickSetFormat(wand, "DNG");
        if (MagickReadImageBlob(wand, dng, length) == MagickTrue) {
            exportRgba(wand);
            if (round % 2 == 1) {
                thumbnailRgba(wand, THUMBNAIL_EDGE);
            }
        } else {
            ++codecsFailed;
            report("dng", wand);
            DestroyMagickWand(wand);
            break;
        }
        DestroyMagickWand(wand);
    }
    ++codecsRun;
    free(dng);
}

// openjph: ImageMagick can't write HTJ2K EXR, so a lossless HTJ2K one is written through OpenEXR's core API, then decoded by ImageMagick.
enum { HT_WIDTH = 512, HT_HEIGHT = 384 };

static unsigned char *makeHtj2kExr(const char *path, size_t *length) {
    const size_t plane = (size_t)HT_WIDTH * HT_HEIGHT;
    float *planes = malloc(3 * plane * sizeof(float)); // B, G, R: the encoder sorts channels by name
    unsigned seed = 4321;
    for (size_t i = 0; i < 3 * plane; i++) {
        seed = seed * 1664525u + 1013904223u;
        planes[i] = (float)((i % HT_WIDTH) * (i / plane + 1) % 512) / 512.0f + (float)(seed >> 24) / 4096.0f;
    }

    exr_context_t ctx;
    int part = 0;
    int32_t step = 1;
    exr_result_t rc = exr_start_write(&ctx, path, EXR_WRITE_FILE_DIRECTLY, NULL);
    if (rc != EXR_ERR_SUCCESS) {
        free(planes);
        return NULL;
    }
    rc = exr_add_part(ctx, "main", EXR_STORAGE_SCANLINE, &part);
    if (rc == EXR_ERR_SUCCESS) {
        rc = exr_initialize_required_attr_simple(ctx, part, HT_WIDTH, HT_HEIGHT, EXR_COMPRESSION_HTJ2K256);
    }
    for (const char *name = "BGR"; rc == EXR_ERR_SUCCESS && *name; name++) {
        const char channel[2] = {*name, '\0'};
        rc = exr_add_channel(ctx, part, channel, EXR_PIXEL_FLOAT, EXR_PERCEPTUALLY_LOGARITHMIC, 1, 1);
    }
    if (rc == EXR_ERR_SUCCESS) {
        rc = exr_write_header(ctx);
    }
    if (rc == EXR_ERR_SUCCESS) {
        rc = exr_get_scanlines_per_chunk(ctx, part, &step);
    }
    for (int y = 0; rc == EXR_ERR_SUCCESS && y < HT_HEIGHT; y += step) {
        exr_chunk_info_t chunk;
        exr_encode_pipeline_t encoder = EXR_ENCODE_PIPELINE_INITIALIZER;
        rc = exr_write_scanline_chunk_info(ctx, part, y, &chunk);
        if (rc == EXR_ERR_SUCCESS) {
            rc = exr_encoding_initialize(ctx, part, &chunk, &encoder);
        }
        if (rc != EXR_ERR_SUCCESS) {
            break;
        }
        for (int c = 0; c < encoder.channel_count; c++) {
            const char name = encoder.channels[c].channel_name[0];
            encoder.channels[c].encode_from_ptr = (const uint8_t *)(planes + (name == 'R' ? 2 : name == 'G') * plane + (size_t)y * HT_WIDTH);
            encoder.channels[c].user_pixel_stride = sizeof(float);
            encoder.channels[c].user_line_stride = HT_WIDTH * sizeof(float);
        }
        rc = exr_encoding_choose_default_routines(ctx, part, &encoder);
        if (rc == EXR_ERR_SUCCESS) {
            rc = exr_encoding_run(ctx, part, &encoder);
        }
        exr_encoding_destroy(ctx, &encoder);
    }
    exr_finish(&ctx);
    free(planes);
    return rc == EXR_ERR_SUCCESS ? readFile(path, length) : NULL;
}

static void htj2kWork(void) {
    static const char path[] = "train-htj2k.exr";
    size_t length = 0;
    unsigned char *exr = makeHtj2kExr(path, &length);
    remove(path);
    ++codecsRun;
    if (!exr) {
        ++codecsFailed;
        fprintf(stderr, "skip: htj2k exr write\n");
        return;
    }
    for (int round = 0; round < DECODES; round++) {
        MagickWand *wand = NewMagickWand();
        if (MagickReadImageBlob(wand, exr, length) == MagickTrue) {
            exportRgba(wand);
        } else {
            ++codecsFailed;
            report("htj2k exr", wand);
            DestroyMagickWand(wand);
            break;
        }
        DestroyMagickWand(wand);
    }
    free(exr);
}

// libzip: ImageMagick only reads OpenRaster (mergedimage.png out of a ZIP), so the archive is written here with libzip itself.
static void oraWork(const MagickWand *src) {
    static const char path[] = "train.ora", mime[] = "image/openraster";
    static const char *const entries[] = {"mergedimage.png", "data/layer0.png"};
    MagickWand *png = CloneMagickWand(src);
    MagickSetImageFormat(png, "PNG");
    size_t length = 0;
    unsigned char *data = MagickGetImageBlob(png, &length);
    int zipError = 0;
    zip_t *archive = data ? zip_open(path, ZIP_CREATE | ZIP_TRUNCATE, &zipError) : NULL;
    if (archive) {
        // The sources must stay valid until zip_close; mimetype is stored, the PNGs deflated, like a real .ora.
        zip_source_t *source = zip_source_buffer(archive, mime, sizeof mime - 1, 0);
        zip_int64_t index = source ? zip_file_add(archive, "mimetype", source, ZIP_FL_ENC_UTF_8) : -1;
        if (index >= 0) {
            zip_set_file_compression(archive, (zip_uint64_t)index, ZIP_CM_STORE, 0);
        } else if (source) {
            zip_source_free(source);
        }
        for (size_t i = 0; i < sizeof entries / sizeof *entries; i++) {
            source = zip_source_buffer(archive, data, length, 0);
            if (source && zip_file_add(archive, entries[i], source, ZIP_FL_ENC_UTF_8) < 0) {
                zip_source_free(source);
            }
        }
        if (zip_close(archive) != 0) {
            zip_discard(archive);
        }
    }
    ++codecsRun;
    for (int pass = 0; pass < 3; pass++) {
        MagickWand *wand = NewMagickWand();
        const MagickBooleanType ok = MagickReadImage(wand, "ORA:train.ora");
        if (ok != MagickTrue) {
            report("ora", wand);
        }
        DestroyMagickWand(wand);
        if (ok != MagickTrue) {
            ++codecsFailed;
            fprintf(stderr, "skip: ora\n");
            break;
        }
    }
    remove(path);
    MagickRelinquishMemory(data);
    DestroyMagickWand(png);
}

// libultrahdr: an HDR intent (16-bit, PQ) frame plus an 8-bit SDR frame, encoded and decoded back.
static void uhdrWork(const MagickWand *src) {
    MagickWand *wand = CloneMagickWand(src);
    MagickWand *sdr = CloneMagickWand(src);
    MagickSetImageDepth(wand, 16);
    MagickSetImageDepth(sdr, 8);
    MagickAddImage(wand, sdr);
    MagickSetFormat(wand, "UHDR");
    MagickSetOption(wand, "uhdr:hdr-color-transfer", "pq");
    size_t length = 0;
    unsigned char *blob = MagickGetImagesBlob(wand, &length);
    ++codecsRun;
    if (blob) {
        for (int round = 0; round < DECODES; round++) {
            MagickWand *back = NewMagickWand();
            if (MagickReadImageBlob(back, blob, length) == MagickTrue) {
                exportRgba(back);
            }
            DestroyMagickWand(back);
        }
        MagickRelinquishMemory(blob);
    } else {
        ++codecsFailed;
        report("uhdr", wand);
    }
    DestroyMagickWand(sdr);
    DestroyMagickWand(wand);
}

// lcms2: sRGB -> CMYK (SWOP) -> sRGB with the ICC profiles that ship with Windows. vu never applies profiles itself, so
// this stays one pass; lcms2 is mostly reached through libjxl and libraw.
static void iccWork(const MagickWand *src) {
    size_t srgbLen = 0, cmykLen = 0;
    unsigned char *srgb = readFile("C:/Windows/System32/spool/drivers/color/sRGB Color Space Profile.icm", &srgbLen),
                  *cmyk = readFile("C:/Windows/System32/spool/drivers/color/RSWOP.icm", &cmykLen);
    ++codecsRun;
    if (srgb && cmyk) {
        static const RenderingIntent intents[] = {PerceptualIntent, RelativeIntent, SaturationIntent};
        for (size_t i = 0; i < sizeof intents / sizeof *intents; i++) {
            MagickWand *wand = CloneMagickWand(src);
            MagickSetImageRenderingIntent(wand, intents[i]);
            MagickProfileImage(wand, "icc", srgb, srgbLen);
            MagickProfileImage(wand, "icc", cmyk, cmykLen);
            MagickProfileImage(wand, "icc", srgb, srgbLen);
            DestroyMagickWand(wand);
        }
    } else {
        ++codecsFailed;
        fprintf(stderr, "skip: icc profiles\n");
    }
    free(srgb);
    free(cmyk);
}

// libxml2: parse an SVG through the MSVG coder.
static void svgWork(void) {
    static const char svg[] =
        "<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><rect width='256' height='256' fill='#246'/>"
        "<circle cx='128' cy='128' r='90' fill='#fc0' stroke='#fff' stroke-width='6'/>"
        "<path d='M20 230 L128 30 L236 230 Z' fill='none' stroke='#f40' stroke-width='4'/></svg>";
    MagickWand *wand = NewMagickWand();
    MagickSetFormat(wand, "MSVG");
    ++codecsRun;
    if (MagickReadImageBlob(wand, svg, sizeof svg - 1) != MagickTrue) {
        ++codecsFailed;
        fprintf(stderr, "skip: svg\n");
    }
    DestroyMagickWand(wand);
}

// libheif: phones write HEIC as a grid of tiles (and the viewer decodes it tile by tile), which ImageMagick's own encoder
// never produces, so a 2x2 grid of HEVC tiles is written through libheif's API, then decoded by ImageMagick.
typedef struct {
    unsigned char *data;
    size_t size;
} Sink;

static struct heif_error sinkWrite(struct heif_context *ctx, const void *data, size_t size, void *user) {
    (void)ctx;
    Sink *sink = user;
    unsigned char *grown = realloc(sink->data, sink->size + size);
    if (grown) {
        memcpy(grown + sink->size, data, size);
        sink->data = grown;
        sink->size += size;
    }
    const struct heif_error result = {grown ? heif_error_Ok : heif_error_Memory_allocation_error, heif_suberror_Unspecified, "Success"};
    return result;
}

static void heicGridWork(MagickWand *photo) {
    enum { TILE_COLUMNS = 2, TILE_ROWS = 2 };
    const size_t width = MagickGetImageWidth(photo) / TILE_COLUMNS * TILE_COLUMNS,
                 height = MagickGetImageHeight(photo) / TILE_ROWS * TILE_ROWS, tileWidth = width / TILE_COLUMNS,
                 tileHeight = height / TILE_ROWS;
    unsigned char *rgb = malloc(width * height * 3);
    struct heif_image *tiles[TILE_COLUMNS * TILE_ROWS] = {0};
    struct heif_context *context = heif_context_alloc();
    struct heif_encoder *encoder = NULL;
    struct heif_image_handle *grid = NULL;
    Sink sink = {0};
    int ok = rgb && MagickExportImagePixels(photo, 0, 0, width, height, "RGB", CharPixel, rgb) == MagickTrue &&
             heif_context_get_encoder_for_format(context, heif_compression_HEVC, &encoder).code == heif_error_Ok;
    ++codecsRun;
    if (ok) {
        heif_encoder_set_lossy_quality(encoder, 75);
        for (size_t tile = 0; ok && tile < TILE_COLUMNS * TILE_ROWS; tile++) {
            const size_t left = tile % TILE_COLUMNS * tileWidth, top = tile / TILE_COLUMNS * tileHeight;
            ok = heif_image_create((int)tileWidth, (int)tileHeight, heif_colorspace_RGB, heif_chroma_interleaved_RGB, &tiles[tile]).code == heif_error_Ok &&
                 heif_image_add_plane(tiles[tile], heif_channel_interleaved, (int)tileWidth, (int)tileHeight, 8).code == heif_error_Ok;
            if (ok) {
                size_t stride = 0;
                int planeStride = 0;
                unsigned char *plane = heif_image_get_plane(tiles[tile], heif_channel_interleaved, &planeStride);
                stride = (size_t)planeStride;
                for (size_t y = 0; y < tileHeight; y++) {
                    memcpy(plane + y * stride, rgb + ((top + y) * width + left) * 3, tileWidth * 3);
                }
            }
        }
        ok = ok && heif_context_encode_grid(context, tiles, TILE_ROWS, TILE_COLUMNS, encoder, NULL, &grid).code == heif_error_Ok;
        struct heif_writer writer = {1, sinkWrite};
        ok = ok && heif_context_write(context, &writer, &sink).code == heif_error_Ok;
    }
    for (size_t tile = 0; tile < TILE_COLUMNS * TILE_ROWS; tile++) {
        heif_image_release(tiles[tile]);
    }
    if (grid) {
        heif_image_handle_release(grid);
    }
    if (encoder) {
        heif_encoder_release(encoder);
    }
    heif_context_free(context);
    free(rgb);
    if (!ok || !sink.data) {
        ++codecsFailed;
        fprintf(stderr, "skip: heic grid write\n");
        free(sink.data);
        return;
    }
    for (int round = 0; round < DECODES; round++) {
        MagickWand *back = NewMagickWand();
        if (MagickReadImageBlob(back, sink.data, sink.size) == MagickTrue) {
            MagickAutoOrientImage(back);
            exportRgba(back);
            if (round % 2 == 1) {
                thumbnailRgba(back, THUMBNAIL_EDGE);
            }
        } else {
            ++codecsFailed;
            report("heic grid", back);
            DestroyMagickWand(back);
            break;
        }
        DestroyMagickWand(back);
    }
    free(sink.data);
}

// A large photograph, which decodes at a size where the pixel cache no longer fits its limits and lives on disk: with a
// small memory and map limit the cache goes to a file, as a 50 MP photo does on a modest machine.
static void largeWork(const MagickWand *photo) {
    static const Codec LARGE[] = {
        {.format = "PNG", .options = {"png:color-type=2"}},
        {.format = "JPEG", .quality = 75},
        {.format = "WEBP", .quality = 75},
        {.format = "TIFF", .compression = LZWCompression, .options = {"tiff:predictor=2"}},
    };
    MagickSetResourceLimit(MemoryResource, 32u << 20);
    MagickSetResourceLimit(MapResource, 32u << 20);
    MagickWand *big = CloneMagickWand(photo);
    MagickResizeImage(big, 3072, 2048, LanczosFilter);
    for (size_t i = 0; i < sizeof LARGE / sizeof *LARGE; i++) {
        roundtrip(big, &LARGE[i], LARGE_DECODES, (int)(i % 2));
    }
    DestroyMagickWand(big);
}

int main(int argc, char **argv) {
    MagickWandGenesis();
    size_t srgbLength = 0;
    iccProfile = readFile("C:/Windows/System32/spool/drivers/color/sRGB Color Space Profile.icm", &srgbLength);
    iccLength = srgbLength;

    static MagickWand *photos[MAX_PHOTOS];
    int photoCount = 0, first = 1;
    if (argc > 1 && strncmp(argv[1], "--only=", 7) == 0) {
        only = argv[1] + 7;
        first = 2;
    }
    for (int arg = first; arg < argc && photoCount < MAX_PHOTOS; arg++) {
        MagickWand *photo = NewMagickWand();
        if (MagickReadImage(photo, argv[arg]) == MagickTrue) {
            photos[photoCount++] = photo;
        } else {
            report(argv[arg], photo);
            DestroyMagickWand(photo);
        }
    }
    if (photoCount == 0) {
        fprintf(stderr, "usage: %s <photo.png>...\n", argv[0]);
        return 1;
    }

    for (int photo = 0; photo < photoCount; photo++) {
        // The second photograph is a portrait shot: its EXIF orientation makes every decode rotate it.
        exifOrientation = photo % 2 ? 6 : 1;
        makeExif(exifOrientation);
        MagickWand *shapes[SHAPE_COUNT] = {0};
        for (size_t i = 0; i < sizeof CODECS / sizeof *CODECS; i++) {
            const Codec *codec = &CODECS[i];
            if (!wanted(codec->format)) {
                continue;
            }
            if (!shapes[codec->shape]) {
                shapes[codec->shape] = makeShape(photos[photo], codec->shape);
            }
            roundtrip(shapes[codec->shape], codec, DECODES, photo == 0);
        }
        if (photo == 0) {
            if (wanted("animation")) {
                animationWork(photos[0]);
            }
            if (wanted("ora")) {
                oraWork(shapes[SHAPE_RGB] ? shapes[SHAPE_RGB] : photos[0]);
            }
            if (wanted("uhdr")) {
                uhdrWork(photos[0]);
            }
            if (wanted("icc")) {
                iccWork(photos[0]);
            }
            if (wanted("heicgrid")) {
                heicGridWork(photos[0]);
            }
        }
        for (int shape = 0; shape < SHAPE_COUNT; shape++) {
            if (shapes[shape]) {
                DestroyMagickWand(shapes[shape]);
            }
        }
    }

    if (wanted("svg")) {
        svgWork();
    }
    if (wanted("raw")) {
        rawWork();
    }
    if (wanted("htj2k")) {
        htj2kWork();
    }
    if (wanted("large")) {
        makeExif(1);
        largeWork(photos[0]);
    }

    printf("magick: %u runs, %u failed\n", codecsRun, codecsFailed);
    for (int photo = 0; photo < photoCount; photo++) {
        DestroyMagickWand(photos[photo]);
    }
    free(pixels);
    free(iccProfile);
    MagickWandTerminus();
    return codecsFailed ? 1 : 0;
}
