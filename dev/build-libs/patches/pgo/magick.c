// PGO training workload for ImageMagick and the libraries it links: every format round-trips through its codec library,
// plus resize/blur/Fourier/ICC work. Text is left out: freetype/harfbuzz are trained by text.c. Failures are skipped on purpose: a missing encoder (HEIC) or system file
// must not stop the rest of the workload from running.
#include <MagickWand/MagickWand.h>
#include <openexr.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zip.h>

typedef struct {
    const char *format;
    CompressionType compression;
    size_t quality;
    const char *option; // "key=value" passed to MagickSetOption before encoding, or NULL
    int raw;            // headerless pixels: encoded as 8-bit, and decoding needs the size, depth and format up front
} Codec;

static const Codec CODECS[] = {
    {"PNG", ZipCompression, 90, NULL},
    {"JPEG", JPEGCompression, 90, NULL},
    {"JPEG", JPEGCompression, 40, NULL},
    {"WEBP", UndefinedCompression, 80, NULL},
    {"WEBP", UndefinedCompression, 100, "webp:lossless=true"},
    {"JXL", UndefinedCompression, 85, NULL},
    {"JXL", UndefinedCompression, 100, "jxl:effort=5"},
    {"TIFF", ZipCompression, 90, NULL},
    {"TIFF", LZMACompression, 90, NULL},
    {"TIFF", ZstdCompression, 90, NULL},
    {"TIFF", JPEGCompression, 85, NULL},
    {"TIFF", WebPCompression, 85, NULL},
    {"EXR", ZipCompression, 90, NULL},
    {"JP2", UndefinedCompression, 80, NULL},
    {"HEIC", UndefinedCompression, 80, NULL},
    {"MIFF", BZipCompression, 90, NULL},
    {"MIFF", LZMACompression, 90, NULL},
    {"MIFF", ZipCompression, 90, NULL},
    {"MIFF", ZstdCompression, 90, NULL},
    {"QOI", UndefinedCompression, 90, NULL},
    {"BMP", UndefinedCompression, 90, NULL},
    {"PSD", RLECompression, 90, NULL},
    {"PSD", ZipCompression, 90, NULL},
    {"RGB", UndefinedCompression, 90, NULL, 1},
    {"GRAY", UndefinedCompression, 90, NULL, 1},
};

static unsigned char *encode(MagickWand *src, const Codec *codec, size_t *length) {
    MagickWand *wand = CloneMagickWand(src);
    MagickSetImageFormat(wand, codec->format);
    if (codec->compression != UndefinedCompression) {
        MagickSetImageCompression(wand, codec->compression);
    }
    MagickSetImageCompressionQuality(wand, codec->quality);
    if (codec->raw || strcmp(codec->format, "HEIC") == 0) {
        MagickSetImageDepth(wand, 8); // kvazaar only encodes 8-bit
    }
    if (codec->option) {
        char key[64];
        const char *value = strchr(codec->option, '=');
        snprintf(key, sizeof key, "%.*s", (int)(value - codec->option), codec->option);
        MagickSetOption(wand, key, value + 1);
    }
    unsigned char *blob = MagickGetImageBlob(wand, length);
    if (!blob) {
        ExceptionType severity;
        char *reason = MagickGetException(wand, &severity);
        fprintf(stderr, "encode %s failed: %s\n", codec->format, reason);
        MagickRelinquishMemory(reason);
    }
    DestroyMagickWand(wand);
    return blob;
}

static void roundtrip(MagickWand *src, const Codec *codec) {
    size_t length = 0;
    unsigned char *blob = encode(src, codec, &length);
    if (!blob) {
        fprintf(stderr, "skip: encode %s\n", codec->format);
        return;
    }
    MagickWand *back = NewMagickWand();
    if (codec->raw) {
        MagickSetSize(back, MagickGetImageWidth(src), MagickGetImageHeight(src));
        MagickSetDepth(back, 8);
        MagickSetFormat(back, codec->format);
    }
    if (MagickReadImageBlob(back, blob, length) == MagickTrue) {
        MagickResizeImage(back, MagickGetImageWidth(back) / 2, MagickGetImageHeight(back) / 2, LanczosFilter);
    } else {
        fprintf(stderr, "skip: decode %s\n", codec->format);
    }
    DestroyMagickWand(back);
    MagickRelinquishMemory(blob);
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

// libraw: a synthetic uncompressed 16-bit RGGB DNG (smooth gradient plus noise), decoded and demosaiced by libraw.
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
    MagickWand *wand = NewMagickWand();
    MagickSetFormat(wand, "DNG");
    if (MagickReadImageBlob(wand, dng, length) == MagickTrue) {
        MagickResizeImage(wand, DNG_WIDTH / 2, DNG_HEIGHT / 2, LanczosFilter);
    } else {
        ExceptionType severity;
        char *reason = MagickGetException(wand, &severity);
        fprintf(stderr, "skip: dng (%s)\n", reason);
        MagickRelinquishMemory(reason);
    }
    DestroyMagickWand(wand);
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
    if (!exr) {
        fprintf(stderr, "skip: htj2k exr write\n");
        return;
    }
    MagickWand *wand = NewMagickWand();
    if (MagickReadImageBlob(wand, exr, length) == MagickTrue) {
        MagickResizeImage(wand, HT_WIDTH / 2, HT_HEIGHT / 2, LanczosFilter);
    } else {
        fprintf(stderr, "skip: htj2k exr read\n");
    }
    DestroyMagickWand(wand);
    free(exr);
}

// libzip: ImageMagick only reads OpenRaster (mergedimage.png out of a ZIP), so the archive is written here with libzip itself.
static void oraWork(MagickWand *src) {
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
    for (int pass = 0; pass < 3; pass++) {
        MagickWand *wand = NewMagickWand();
        const MagickBooleanType ok = MagickReadImage(wand, "ORA:train.ora");
        DestroyMagickWand(wand);
        if (ok != MagickTrue) {
            fprintf(stderr, "skip: ora\n");
            break;
        }
    }
    remove(path);
    MagickRelinquishMemory(data);
    DestroyMagickWand(png);
}

// libultrahdr: an HDR intent (16-bit, PQ) frame plus an 8-bit SDR frame, encoded and decoded back.
static void uhdrWork(MagickWand *src) {
    MagickWand *wand = CloneMagickWand(src);
    MagickWand *sdr = CloneMagickWand(src);
    MagickSetImageDepth(sdr, 8);
    MagickAddImage(wand, sdr);
    MagickSetFormat(wand, "UHDR");
    MagickSetOption(wand, "uhdr:hdr-color-transfer", "pq");
    size_t length = 0;
    unsigned char *blob = MagickGetImagesBlob(wand, &length);
    if (blob) {
        MagickWand *back = NewMagickWand();
        MagickReadImageBlob(back, blob, length);
        DestroyMagickWand(back);
        MagickRelinquishMemory(blob);
    } else {
        ExceptionType severity;
        char *reason = MagickGetException(wand, &severity);
        fprintf(stderr, "skip: uhdr (%s)\n", reason);
        MagickRelinquishMemory(reason);
    }
    DestroyMagickWand(sdr);
    DestroyMagickWand(wand);
}

// lcms2: sRGB -> CMYK (SWOP) -> sRGB with the ICC profiles that ship with Windows.
static void iccWork(MagickWand *src) {
    size_t srgbLen = 0, cmykLen = 0;
    unsigned char *srgb = readFile("C:/Windows/System32/spool/drivers/color/sRGB Color Space Profile.icm", &srgbLen),
                  *cmyk = readFile("C:/Windows/System32/spool/drivers/color/RSWOP.icm", &cmykLen);
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
    if (MagickReadImageBlob(wand, svg, sizeof svg - 1) != MagickTrue) {
        fprintf(stderr, "skip: svg\n");
    }
    DestroyMagickWand(wand);
}

int main(void) {
    MagickWandGenesis();

    // Photo-like content (plasma) is what the lossy codecs and entropy coders behave on.
    MagickWand *photo = NewMagickWand();
    MagickSetSize(photo, 1024, 768);
    MagickReadImage(photo, "plasma:fractal");
    MagickWand *logo = NewMagickWand();
    MagickReadImage(logo, "logo:");
    MagickResizeImage(logo, 1280, 960, LanczosFilter);

    MagickWand *sources[] = {photo, logo};
    for (int pass = 0; pass < 2; pass++) {
        for (size_t src = 0; src < sizeof sources / sizeof *sources; src++) {
            for (size_t i = 0; i < sizeof CODECS / sizeof *CODECS; i++) {
                roundtrip(sources[src], &CODECS[i]);
            }
        }
    }

    iccWork(photo);
    svgWork();
    rawWork();
    htj2kWork();
    oraWork(photo);
    uhdrWork(photo);

    MagickWand *work = CloneMagickWand(photo);
    MagickBlurImage(work, 0, 3);
    MagickSharpenImage(work, 0, 2);
    MagickResizeImage(work, 512, 384, MitchellFilter);
    MagickQuantizeImage(work, 64, sRGBColorspace, 0, RiemersmaDitherMethod, MagickFalse);
    MagickTransformImageColorspace(work, GRAYColorspace);
    MagickCropImage(work, 512, 512, 0, 0);
    MagickForwardFourierTransformImage(work, MagickTrue);
    DestroyMagickWand(work);

    DestroyMagickWand(logo);
    DestroyMagickWand(photo);
    MagickWandTerminus();
}
