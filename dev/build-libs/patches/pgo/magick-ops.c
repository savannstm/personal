// PGO training workload for ImageMagick's own operations, as vu applies them: every resize filter it offers, the
// thumbnail and ping paths of its file panel and shell thumbnails, every colorspace conversion, and each effect of its
// effect table, on both an opaque image and one with an alpha channel (vu sets alpha on every preview). The coders and
// the libraries behind them are trained by magick.c; the effects here need no codec at all.
// argv[1..]: photographs (PNG). An optional leading --only=core|effects runs the operations vu uses constantly (ping, resize,
// thumbnails, colorspaces) or the effect table, which pgo.ts weights apart: effects are a rare, GPU-first path. A failed
// effect is a failure of the run.
#include <MagickWand/MagickWand.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MAX_PHOTOS = 4, WORK_EDGE = 256, RESIZE_EDGE = 512 };

static PixelWand *RED, *BLUE, *BLACK, *WHITE;
static KernelInfo *DIAMOND, *SEPIA_MATRIX, *GAUSSIAN;

// One function per effect, named after the Magick++ call vu makes. Parameters are the moderate ones a user picks first.
#define EFFECTS(X)                                                                                                     \
    X(blur, return MagickBlurImage(w, 0, 3);)                                                                          \
    X(gaussianBlur, return MagickGaussianBlurImage(w, 0, 3);)                                                          \
    X(adaptiveBlur, return MagickAdaptiveBlurImage(w, 0, 2);)                                                          \
    X(selectiveBlur, return MagickSelectiveBlurImage(w, 0, 2, 0.2 * QuantumRange);)                                    \
    X(bilateralBlur, return MagickBilateralBlurImage(w, 0, 2, 2, 2);)                                                  \
    X(motionBlur, return MagickMotionBlurImage(w, 0, 6, 45);)                                                          \
    X(rotationalBlur, return MagickRotationalBlurImage(w, 10);)                                                        \
    X(sharpen, return MagickSharpenImage(w, 0, 2);)                                                                    \
    X(adaptiveSharpen, return MagickAdaptiveSharpenImage(w, 0, 2);)                                                    \
    X(unsharpMask, return MagickUnsharpMaskImage(w, 0, 1.5, 1, 0.05);)                                                 \
    X(kuwahara, return MagickKuwaharaImage(w, 0, 2);)                                                                  \
    X(medianFilter, return MagickStatisticImage(w, MedianStatistic, 3, 3);)                                            \
    X(reduceNoise, return MagickStatisticImage(w, NonpeakStatistic, 2, 2);)                                            \
    X(mode, return MagickStatisticImage(w, ModeStatistic, 2, 2);)                                                      \
    X(meanShift,return MagickMeanShiftImage(w, 5, 5, 0.1 * QuantumRange);)                                            \
    X(despeckle, return MagickDespeckleImage(w);)                                                                      \
    X(waveletDenoise, return MagickWaveletDenoiseImage(w, 0.05 * QuantumRange, 0);)                                    \
    X(enhance, return MagickEnhanceImage(w);)                                                                          \
    X(edge, return MagickEdgeImage(w, 1);)                                                                             \
    X(cannyEdge, return MagickCannyEdgeImage(w, 0, 1, 0.1, 0.3);)                                                      \
    X(emboss, return MagickEmbossImage(w, 0, 1);)                                                                      \
    X(charcoal, return MagickCharcoalImage(w, 0, 1);)                                                                  \
    X(sketch, return MagickSketchImage(w, 0, 1, 45);)                                                                  \
    X(shade, return MagickShadeImage(w, MagickTrue, 30, 30);)                                                          \
    X(houghLine, return MagickHoughLineImage(w, 9, 9, 40);)                                                            \
    X(connectedComponents, CCObjectInfo *objects = NULL;                                                               \
      const MagickBooleanType ok = MagickConnectedComponentsImage(w, 4, &objects);                                     \
      if (objects) { RelinquishMagickMemory(objects); } return ok;)                                                    \
    X(dilate, return MagickMorphologyImage(w, DilateMorphology, 1, DIAMOND);)                                          \
    X(erode, return MagickMorphologyImage(w, ErodeMorphology, 1, DIAMOND);)                                            \
    X(open, return MagickMorphologyImage(w, OpenMorphology, 1, DIAMOND);)                                              \
    X(convolve, return MagickConvolveImage(w, GAUSSIAN);)                                                              \
    X(segment, return MagickSegmentImage(w, sRGBColorspace, MagickFalse, 1.0, 1.5);)                                   \
    X(level, return MagickLevelImage(w, 0.1 * QuantumRange, 1.2, 0.9 * QuantumRange);)                                 \
    X(levelColors, return MagickLevelImageColors(w, BLACK, WHITE, MagickFalse);)                                       \
    X(levelize, return MagickLevelizeImage(w, 0.1 * QuantumRange, 1.2, 0.9 * QuantumRange);)                           \
    X(contrast, return MagickContrastImage(w, MagickTrue);)                                                            \
    X(contrastStretch, return MagickContrastStretchImage(w, 0.01 * QuantumRange, 0.99 * QuantumRange);)                \
    X(linearStretch, return MagickLinearStretchImage(w, 0.01 * QuantumRange, 0.99 * QuantumRange);)                    \
    X(sigmoidalContrast, return MagickSigmoidalContrastImage(w, MagickTrue, 5, 0.5 * QuantumRange);)                   \
    X(brightnessContrast, return MagickBrightnessContrastImage(w, 10, 20);)                                            \
    X(localContrast, return MagickLocalContrastImage(w, 10, 50);)                                                      \
    X(clahe, return MagickCLAHEImage(w, 8, 8, 128, 3);)                                                                \
    X(gamma, return MagickGammaImage(w, 1.4);)                                                                         \
    X(autoGamma, return MagickAutoGammaImage(w);)                                                                      \
    X(autoLevel, return MagickAutoLevelImage(w);)                                                                      \
    X(equalize, return MagickEqualizeImage(w);)                                                                        \
    X(normalize, return MagickNormalizeImage(w);)                                                                      \
    X(whiteBalance, return MagickWhiteBalanceImage(w);)                                                                \
    X(modulate, return MagickModulateImage(w, 110, 120, 100);)                                                         \
    X(tint, return MagickTintImage(w, RED, BLUE);)                                                                     \
    X(colorize, return MagickColorizeImage(w, RED, BLUE);)                                                             \
    X(colorMatrix, return MagickColorMatrixImage(w, SEPIA_MATRIX);)                                                    \
    X(sepiaTone, return MagickSepiaToneImage(w, 0.8 * QuantumRange);)                                                  \
    X(solarize, return MagickSolarizeImage(w, 0.5 * QuantumRange);)                                                    \
    X(posterize, return MagickPosterizeImage(w, 4, NoDitherMethod);)                                                   \
    X(negate, return MagickNegateImage(w, MagickFalse);)                                                               \
    X(evaluate, return MagickEvaluateImage(w, MultiplyEvaluateOperator, 1.2);)                                         \
    X(fx, MagickWand *result = MagickFxImage(w, "u*1.1+0.02");                                                        \
      const MagickBooleanType ok = result ? MagickTrue : MagickFalse;                                                  \
      if (result) { DestroyMagickWand(result); } return ok;)                                                           \
    X(blueShift, return MagickBlueShiftImage(w, 1.5);)                                                                 \
    X(clamp, return MagickClampImage(w);)                                                                              \
    X(grayscale, return MagickTransformImageColorspace(w, GRAYColorspace);)                                            \
    X(threshold, return MagickThresholdImage(w, 0.5 * QuantumRange);)                                                  \
    X(blackThreshold, return MagickBlackThresholdImage(w, RED);)                                                       \
    X(whiteThreshold, return MagickWhiteThresholdImage(w, BLUE);)                                                      \
    X(adaptiveThreshold, return MagickAdaptiveThresholdImage(w, 15, 15, 0);)                                           \
    X(autoThreshold, return MagickAutoThresholdImage(w, OTSUThresholdMethod);)                                         \
    X(randomThreshold, return MagickRandomThresholdImage(w, 0.3 * QuantumRange, 0.7 * QuantumRange);)                  \
    X(orderedDither, return MagickOrderedDitherImage(w, "o8x8");)                                                      \
    X(quantizeRiemersma, return MagickQuantizeImage(w, 64, sRGBColorspace, 0, RiemersmaDitherMethod, MagickFalse);)    \
    X(quantizeFloyd, return MagickQuantizeImage(w, 16, sRGBColorspace, 0, FloydSteinbergDitherMethod, MagickFalse);)   \
    X(cycleColormap, MagickQuantizeImage(w, 32, sRGBColorspace, 0, NoDitherMethod, MagickFalse);                       \
      return MagickCycleColormapImage(w, 5);)                                                                          \
    X(swirl, return MagickSwirlImage(w, 90, BilinearInterpolatePixel);)                                                \
    X(implode, return MagickImplodeImage(w, 0.5, BilinearInterpolatePixel);)                                           \
    X(wave, return MagickWaveImage(w, 10, 80, BilinearInterpolatePixel);)                                              \
    X(spread, return MagickSpreadImage(w, BilinearInterpolatePixel, 3);)                                               \
    X(oilPaint, return MagickOilPaintImage(w, 3, 1);)                                                                  \
    X(addNoise, return MagickAddNoiseImage(w, GaussianNoise, 1.0);)                                                    \
    X(vignette, return MagickVignetteImage(w, 0, 10, 10, 10);)                                                         \
    X(shadow, return MagickShadowImage(w, 80, 3, 5, 5);)                                                               \
    X(shear, return MagickShearImage(w, BLACK, 10, 0);)                                                                \
    X(rotate, return MagickRotateImage(w, BLACK, 17);)                                                                 \
    X(deskew, return MagickDeskewImage(w, 0.4 * QuantumRange);)                                                        \
    X(roll, return MagickRollImage(w, 30, 20);)                                                                        \
    X(flip, return MagickFlipImage(w);)                                                                                \
    X(flop, return MagickFlopImage(w);)                                                                                \
    X(transpose, return MagickTransposeImage(w);)                                                                      \
    X(transverse, return MagickTransverseImage(w);)                                                                    \
    X(crop, return MagickCropImage(w, 120, 90, 20, 10);)                                                               \
    X(chop, return MagickChopImage(w, 20, 20, 30, 30);)                                                                \
    X(trim, return MagickTrimImage(w, 0);)                                                                             \
    X(shave, return MagickShaveImage(w, 10, 10);)                                                                      \
    X(splice, return MagickSpliceImage(w, 10, 10, 20, 20);)                                                            \
    X(extent, return MagickExtentImage(w, 300, 200, -10, -10);)                                                        \
    X(border, return MagickBorderImage(w, RED, 5, 5, OverCompositeOp);)                                                \
    X(frame, return MagickFrameImage(w, BLUE, 5, 5, 2, 2, OverCompositeOp);)                                           \
    X(raise, return MagickRaiseImage(w, 5, 5, 0, 0, MagickTrue);)                                                      \
    X(distortAffine, const double args[] = {0, 0, 10, 5, 100, 0, 110, 15, 0, 100, 5, 95};                              \
      return MagickDistortImage(w, AffineDistortion, 12, args, MagickFalse);)                                          \
    X(distortBarrel, const double args[] = {0.02, 0.0, 0.05, 0.93};                                                    \
      return MagickDistortImage(w, BarrelDistortion, 4, args, MagickFalse);)                                           \
    X(distortArc, const double args[] = {60};                                                                          \
      return MagickDistortImage(w, ArcDistortion, 1, args, MagickFalse);)                                              \
    X(adaptiveResize, return MagickAdaptiveResizeImage(w, 180, 120);)                                                  \
    X(sample, return MagickSampleImage(w, 90, 60);)                                                                    \
    X(scale, return MagickScaleImage(w, 90, 60);)                                                                      \
    X(magnify, return MagickMagnifyImage(w);)                                                                          \
    X(minify, return MagickMinifyImage(w);)                                                                            \
    X(separate, return MagickSeparateImage(w, GreenChannel);)                                                          \
    X(transparentPaint, return MagickTransparentPaintImage(w, BLACK, 0.5, 0.3 * QuantumRange, MagickFalse);)           \
    X(opaquePaint, return MagickOpaquePaintImage(w, BLACK, WHITE, 0.3 * QuantumRange, MagickFalse);)                   \
    X(uniqueColors, return MagickUniqueImageColors(w);)                                                                \
    X(forwardFourier, return MagickForwardFourierTransformImage(w, MagickTrue);)

#define DEFINE(name, ...) static MagickBooleanType effect_##name(MagickWand *w) { __VA_ARGS__ }
EFFECTS(DEFINE)
#undef DEFINE

typedef struct {
    const char *name;
    MagickBooleanType (*apply)(MagickWand *);
} Effect;

#define ENTRY(name, ...) {#name, effect_##name},
static const Effect EFFECT_TABLE[] = {EFFECTS(ENTRY)};
#undef ENTRY

static unsigned char *pixels;
static size_t pixelsSize;
static unsigned effectsRun, effectsFailed, resizesRun;

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

static void scaleToEdge(MagickWand *wand, size_t edge, FilterType filter) {
    const size_t width = MagickGetImageWidth(wand), height = MagickGetImageHeight(wand),
                 longest = width > height ? width : height;
    MagickResizeImage(wand, width * edge / longest, height * edge / longest, filter);
}

/** The photograph with a radial alpha fade, built from pixels so it doesn't depend on a compose operator. */
static MagickWand *withAlpha(MagickWand *rgb) {
    const size_t width = MagickGetImageWidth(rgb), height = MagickGetImageHeight(rgb);
    unsigned char *rgba = malloc(width * height * 4);
    MagickWand *out = CloneMagickWand(rgb);
    if (rgba && MagickExportImagePixels(rgb, 0, 0, width, height, "RGB", CharPixel, rgba) == MagickTrue) {
        // Expanded in place from the back so the RGB triplets aren't overwritten.
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
        // A clone, not a constituted image: ConstituteImage leaves image_info NULL, which MagnifyImage dereferences.
        MagickWand *alpha = CloneMagickWand(rgb);
        MagickSetImageAlphaChannel(alpha, ActivateAlphaChannel);
        if (MagickImportImagePixels(alpha, 0, 0, width, height, "RGBA", CharPixel, rgba) == MagickTrue) {
            DestroyMagickWand(out);
            out = alpha;
        } else {
            DestroyMagickWand(alpha);
        }
    }
    free(rgba);
    return out;
}

/** Every filter vu's resize offers (and IM's default pick), shrinking and enlarging, then the other scalers. */
static void resizeWork(MagickWand *base) {
    const size_t width = MagickGetImageWidth(base), height = MagickGetImageHeight(base);
    for (int filter = UndefinedFilter; filter < SentinelFilter; filter++) {
        static const double SCALES[] = {0.4, 1.5};
        for (size_t s = 0; s < sizeof SCALES / sizeof *SCALES; s++) {
            MagickWand *wand = CloneMagickWand(base);
            MagickResizeImage(wand, (size_t)((double)width * SCALES[s]), (size_t)((double)height * SCALES[s]), (FilterType)filter);
            exportRgba(wand);
            DestroyMagickWand(wand);
            ++resizesRun;
        }
    }
}

/** vu's thumbnails: a box that is far smaller than the image (sampled first), an ordinary one, and the shell's 256. */
static void thumbnailWork(MagickWand *photo) {
    static const size_t EDGES[] = {64, 128, 256};
    for (size_t e = 0; e < sizeof EDGES / sizeof *EDGES; e++) {
        MagickWand *wand = CloneMagickWand(photo);
        const size_t width = MagickGetImageWidth(wand), height = MagickGetImageHeight(wand),
                     longest = width > height ? width : height;
        MagickThumbnailImage(wand, width * EDGES[e] / longest, height * EDGES[e] / longest);
        MagickSetImageAlphaChannel(wand, ActivateAlphaChannel);
        exportRgba(wand);
        DestroyMagickWand(wand);
    }
}

static void colorspaceWork(MagickWand *work) {
    for (int space = UndefinedColorspace + 1; space <= DisplayP3Colorspace; space++) {
        MagickWand *wand = CloneMagickWand(work);
        MagickTransformImageColorspace(wand, (ColorspaceType)space);
        MagickTransformImageColorspace(wand, sRGBColorspace);
        exportRgba(wand);
        DestroyMagickWand(wand);
    }
}

static void effectsWork(MagickWand *const works[], size_t workCount) {
    for (size_t e = 0; e < sizeof EFFECT_TABLE / sizeof *EFFECT_TABLE; e++) {
        // Alternate the photographs; each effect runs on the opaque image and on the one with alpha.
        MagickWand *source = works[e % workCount];
        for (int alpha = 0; alpha < 2; alpha++) {
            MagickWand *wand = alpha ? withAlpha(source) : CloneMagickWand(source);
            ++effectsRun;
            if (EFFECT_TABLE[e].apply(wand) != MagickTrue) {
                ++effectsFailed;
                ExceptionType severity;
                char *reason = MagickGetException(wand, &severity);
                fprintf(stderr, "skip: %s%s (%s)\n", EFFECT_TABLE[e].name, alpha ? " +alpha" : "", reason);
                MagickRelinquishMemory(reason);
            } else {
                exportRgba(wand);
            }
            DestroyMagickWand(wand);
        }
    }
}

int main(int argc, char **argv) {
    MagickWandGenesis();

    int first = 1, core = 1, effects = 1;
    if (argc > 1 && strncmp(argv[1], "--only=", 7) == 0) {
        core = strcmp(argv[1] + 7, "core") == 0;
        effects = strcmp(argv[1] + 7, "effects") == 0;
        first = 2;
    }

    static MagickWand *photos[MAX_PHOTOS], *works[MAX_PHOTOS];
    const char *paths[MAX_PHOTOS];
    int photoCount = 0;
    for (int arg = first; arg < argc && photoCount < MAX_PHOTOS; arg++) {
        MagickWand *photo = NewMagickWand();
        if (MagickReadImage(photo, argv[arg]) == MagickTrue) {
            paths[photoCount] = argv[arg];
            photos[photoCount++] = photo;
        } else {
            fprintf(stderr, "skip: %s\n", argv[arg]);
            DestroyMagickWand(photo);
        }
    }
    if (photoCount == 0) {
        fprintf(stderr, "usage: %s <photo.png>...\n", argv[0]);
        return 1;
    }

    RED = NewPixelWand();
    BLUE = NewPixelWand();
    BLACK = NewPixelWand();
    WHITE = NewPixelWand();
    PixelSetColor(RED, "rgb(200,40,40)");
    PixelSetColor(BLUE, "rgb(40,60,200)");
    PixelSetColor(BLACK, "black");
    PixelSetColor(WHITE, "white");
    ExceptionInfo *exception = AcquireExceptionInfo();
    DIAMOND = AcquireKernelInfo("Diamond:1", exception);
    GAUSSIAN = AcquireKernelInfo("Gaussian:0x1.5", exception);
    SEPIA_MATRIX = AcquireKernelInfo("3x3: 0.393,0.769,0.189  0.349,0.686,0.168  0.272,0.534,0.131", exception);
    DestroyExceptionInfo(exception);
    if (!DIAMOND || !GAUSSIAN || !SEPIA_MATRIX) {
        fprintf(stderr, "kernels failed\n");
        return 1;
    }

    for (int p = 0; p < photoCount && core; p++) {
        // vu pings a file before reading it.
        MagickWand *probe = NewMagickWand();
        MagickPingImage(probe, paths[p]);
        DestroyMagickWand(probe);

        MagickWand *base = CloneMagickWand(photos[p]);
        scaleToEdge(base, RESIZE_EDGE, LanczosFilter);
        resizeWork(base);
        MagickWand *baseAlpha = withAlpha(base);
        resizeWork(baseAlpha);
        DestroyMagickWand(baseAlpha);
        DestroyMagickWand(base);

        thumbnailWork(photos[p]);
        MagickWand *photoAlpha = withAlpha(photos[p]);
        thumbnailWork(photoAlpha);
        DestroyMagickWand(photoAlpha);
    }

    for (int p = 0; p < photoCount; p++) {
        works[p] = CloneMagickWand(photos[p]);
        scaleToEdge(works[p], WORK_EDGE, LanczosFilter);
    }
    if (core) {
        colorspaceWork(works[0]);
    }
    if (effects) {
        effectsWork(works, (size_t)photoCount);
    }

    printf("magick-ops: %u effects (%u failed), %u resizes\n", effectsRun, effectsFailed, resizesRun);
    for (int p = 0; p < photoCount; p++) {
        DestroyMagickWand(works[p]);
        DestroyMagickWand(photos[p]);
    }
    free(pixels);
    MagickWandTerminus();
    return effectsFailed ? 1 : 0;
}
