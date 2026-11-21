// PGO trainer for FFmpeg's decoders, demuxers, swscale, swresample, the audio filter graph and libavutil's transforms,
// run once per shipped variant. The apps only decode: vu plays video and animations (decode, then sws_scale to RGBA),
// rap decodes audio and rpgmtranslate audio and video previews. What each does with the frames is mirrored here:
// - rap converts to packed float without changing the rate or layout (swr), and with its equalizer on runs the decoder's
//   frames through firequalizer (fft2, hamming), alimiter and aformat; its spectrum is a 4096-point real FFT (av_tx).
// - vu converts every frame to full-size RGBA with bicubic swscale; rpgmtranslate to RGB24 with bilinear.
// argv: [--require=a,b] media files (patches/pgo/fixtures/ffmpeg); a variant doesn't have every demuxer and decoder, and
// skips what it can't read without a message. --require lists the files the variant must decode (at least one frame):
// anything else about them failing is a failure of the run, so a mistake in a variant's decoder list can't go unnoticed.

#include <libavcodec/avcodec.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/tx.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <stdio.h>
#include <string.h>

enum { MAX_STREAMS = 8, SPECTRUM_SIZE = 4096, SPECTRUM_RUNS = 3000, MAX_FILES = 64 };

static int skipped;

static void skip(const char *what, int err) {
    char msg[AV_ERROR_MAX_STRING_SIZE] = "failed";
    if (err < 0) {
        av_strerror(err, msg, sizeof msg);
    }
    printf("skip: %s: %s\n", what, msg);
    ++skipped;
}

typedef struct {
    AVCodecContext *ctx;
    struct SwsContext *full;
    struct SwsContext *small;
    SwrContext *swr;
    AVFilterGraph *graph;
    AVFilterContext *src;
    AVFilterContext *sink;
    uint8_t *packed;
    int packedSize;
    unsigned audioFrames;
    int graphFailed;
    long frames;
} Stream;

// rap's equalizer graph, stage by stage as AudioStreamer::buildGraph creates it.
static int initGraph(Stream *stream) {
    static const char GAINS[] = "entry(31,2);entry(62,1);entry(125,0);entry(250,-1);entry(500,0);entry(1000,2);"
                                "entry(2000,3);entry(4000,1);entry(8000,-2);entry(16000,-3)";
    const AVCodecContext *codec = stream->ctx;
    char equalizer[256];
    snprintf(equalizer, sizeof equalizer, "gain_entry='%s':fft2=on:wfunc=hamming:accuracy=10", GAINS);

    stream->graph = avfilter_graph_alloc();
    if (!stream->graph) {
        return AVERROR(ENOMEM);
    }
    stream->src = avfilter_graph_alloc_filter(stream->graph, avfilter_get_by_name("abuffer"), "source");
    AVBufferSrcParameters *parameters = stream->src ? av_buffersrc_parameters_alloc() : NULL;
    if (!parameters) {
        avfilter_graph_free(&stream->graph);
        return AVERROR(ENOMEM);
    }
    parameters->format = codec->sample_fmt;
    parameters->sample_rate = codec->sample_rate;
    parameters->time_base = (AVRational){1, codec->sample_rate};
    parameters->ch_layout = codec->ch_layout;
    int err = av_buffersrc_parameters_set(stream->src, parameters);
    av_free(parameters);
    if (err >= 0) {
        err = avfilter_init_str(stream->src, NULL);
    }

    static const struct {
        const char *filter, *name;
    } STAGES[] = {{"firequalizer", "equalizer"}, {"alimiter", "limiter"}, {"aformat", "format"}, {"abuffersink", "sink"}};
    AVFilterContext *previous = stream->src;
    for (int i = 0; i < 4 && err >= 0; ++i) {
        const char *args = i == 0 ? equalizer : i == 2 ? "sample_fmts=flt" : NULL;
        AVFilterContext *context = NULL;
        err = avfilter_graph_create_filter(&context, avfilter_get_by_name(STAGES[i].filter), STAGES[i].name, args, NULL,
                                           stream->graph);
        if (err >= 0) {
            err = avfilter_link(previous, 0, context, 0);
            previous = context;
        }
    }
    if (err >= 0) {
        err = avfilter_graph_config(stream->graph, NULL);
    }
    if (err < 0) {
        avfilter_graph_free(&stream->graph);
        return err;
    }
    stream->sink = previous;
    return 0;
}

// Feeds the equalizer graph a frame, as AudioStreamer::process does, and drains what comes out.
static void filterAudio(Stream *stream, AVFrame *frame, AVFrame *out) {
    if (stream->graphFailed) {
        return;
    }
    if (!stream->graph) {
        const int err = initGraph(stream);
        if (err < 0) {
            // A variant without the filters (vu, rpgmtranslate) can't build it; say so once.
            stream->graphFailed = 1;
            skip("equalizer graph", err);
            return;
        }
    }
    if (av_buffersrc_add_frame_flags(stream->src, frame, AV_BUFFERSRC_FLAG_KEEP_REF) >= 0) {
        while (av_buffersink_get_frame(stream->sink, out) >= 0) {
            av_frame_unref(out);
        }
    }
}

// rap without the equalizer: only the sample format changes (same layout and rate), straight into packed float.
static void convertAudio(Stream *stream, const AVFrame *frame) {
    const AVCodecContext *codec = stream->ctx;
    if (codec->sample_fmt == AV_SAMPLE_FMT_FLT) {
        return;
    }
    if (!stream->swr) {
        if (swr_alloc_set_opts2(&stream->swr, &codec->ch_layout, AV_SAMPLE_FMT_FLT, codec->sample_rate, &codec->ch_layout,
                                codec->sample_fmt, codec->sample_rate, 0, NULL) < 0 ||
            swr_init(stream->swr) < 0) {
            swr_free(&stream->swr);
            return;
        }
    }
    const int size = frame->nb_samples * codec->ch_layout.nb_channels * (int)sizeof(float);
    if (size > stream->packedSize) {
        av_free(stream->packed);
        stream->packed = av_malloc((size_t)size);
        stream->packedSize = stream->packed ? size : 0;
    }
    if (stream->packed) {
        swr_convert(stream->swr, &stream->packed, frame->nb_samples, (const uint8_t **)frame->extended_data,
                    frame->nb_samples);
    }
}

// What vu does with a video frame (full-size RGBA), rpgmtranslate (scaled RGB24) and the audio apps with an audio one.
static void consume(Stream *stream, AVFrame *frame, AVFrame *tmp) {
    ++stream->frames;
    if (stream->ctx->codec_type == AVMEDIA_TYPE_VIDEO) {
        uint8_t *data[4];
        int lines[4];
        const int width = frame->width, height = frame->height, half = width / 2 > 0 ? width / 2 : 1, hhalf = height / 2 > 0 ? height / 2 : 1;
        stream->full = sws_getCachedContext(stream->full, width, height, frame->format, width, height, AV_PIX_FMT_RGBA,
                                            SWS_BICUBIC, NULL, NULL, NULL);
        if (stream->full && av_image_alloc(data, lines, width, height, AV_PIX_FMT_RGBA, 1) >= 0) {
            sws_scale(stream->full, (const uint8_t *const *)frame->data, frame->linesize, 0, height, data, lines);
            av_freep(&data[0]);
        }
        stream->small = sws_getCachedContext(stream->small, width, height, frame->format, half, hhalf, AV_PIX_FMT_RGB24,
                                             SWS_BILINEAR, NULL, NULL, NULL);
        if (stream->small && av_image_alloc(data, lines, half, hhalf, AV_PIX_FMT_RGB24, 1) >= 0) {
            sws_scale(stream->small, (const uint8_t *const *)frame->data, frame->linesize, 0, height, data, lines);
            av_freep(&data[0]);
        }
    } else if (stream->ctx->codec_type == AVMEDIA_TYPE_AUDIO) {
        convertAudio(stream, frame);
        // The equalizer is an option, and the costliest part of the chain: a quarter of the frames go through it.
        if ((stream->audioFrames++ & 3) == 0) {
            filterAudio(stream, frame, tmp);
        }
    }
}

static void decodePackets(AVFormatContext *fmt, Stream *streams, AVPacket *pkt, AVFrame *frame, AVFrame *tmp, int limit) {
    for (int count = 0; (limit <= 0 || count < limit) && av_read_frame(fmt, pkt) >= 0; ++count) {
        Stream *stream = pkt->stream_index < MAX_STREAMS ? &streams[pkt->stream_index] : NULL;
        if (stream && stream->ctx && avcodec_send_packet(stream->ctx, pkt) >= 0) {
            while (avcodec_receive_frame(stream->ctx, frame) >= 0) {
                consume(stream, frame, tmp);
                av_frame_unref(frame);
            }
        }
        av_packet_unref(pkt);
    }
}

// Opens `path`, decodes every stream, then seeks back and decodes a few more packets as a player does. Returns the
// frames decoded.
static long decodeFile(const char *path) {
    AVFormatContext *fmt = NULL;
    Stream streams[MAX_STREAMS] = {0};
    long total = 0;
    int err = avformat_open_input(&fmt, path, NULL, NULL);
    if (err < 0) {
        return 0;
    }
    if ((err = avformat_find_stream_info(fmt, NULL)) < 0) {
        skip(path, err);
    }
    for (unsigned i = 0; i < fmt->nb_streams && i < MAX_STREAMS; ++i) {
        const AVCodecParameters *par = fmt->streams[i]->codecpar;
        const AVCodec *codec = par->codec_id == AV_CODEC_ID_AV1 ? avcodec_find_decoder_by_name("libdav1d")
                                                                : avcodec_find_decoder(par->codec_id);
        if (!codec) {
            continue;
        }
        streams[i].ctx = avcodec_alloc_context3(codec);
        if (!streams[i].ctx || avcodec_parameters_to_context(streams[i].ctx, par) < 0 ||
            avcodec_open2(streams[i].ctx, codec, NULL) < 0) {
            avcodec_free_context(&streams[i].ctx);
        }
    }
    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc(), *tmp = av_frame_alloc();
    if (pkt && frame && tmp) {
        decodePackets(fmt, streams, pkt, frame, tmp, 0);
        if (av_seek_frame(fmt, -1, 0, AVSEEK_FLAG_BACKWARD) >= 0) {
            for (int i = 0; i < MAX_STREAMS; ++i) {
                if (streams[i].ctx) {
                    avcodec_flush_buffers(streams[i].ctx);
                }
            }
            decodePackets(fmt, streams, pkt, frame, tmp, 20);
        }
        // Drain the decoders' delayed frames.
        for (int i = 0; i < MAX_STREAMS; ++i) {
            if (streams[i].ctx && avcodec_send_packet(streams[i].ctx, NULL) >= 0) {
                while (avcodec_receive_frame(streams[i].ctx, frame) >= 0) {
                    consume(&streams[i], frame, tmp);
                    av_frame_unref(frame);
                }
            }
        }
    }
    for (int i = 0; i < MAX_STREAMS; ++i) {
        total += streams[i].frames;
        avcodec_free_context(&streams[i].ctx);
        sws_freeContext(streams[i].full);
        sws_freeContext(streams[i].small);
        swr_free(&streams[i].swr);
        av_free(streams[i].packed);
        avfilter_graph_free(&streams[i].graph);
    }
    av_packet_free(&pkt);
    av_frame_free(&frame);
    av_frame_free(&tmp);
    avformat_close_input(&fmt);
    return total;
}

// rap's spectrum: a real FFT of the Hann-windowed 75 ms of the signal, many times a second.
static void spectrum(void) {
    AVTXContext *transform = NULL;
    av_tx_fn fft = NULL;
    const float scale = 1.0F;
    if (av_tx_init(&transform, &fft, AV_TX_FLOAT_RDFT, 0, SPECTRUM_SIZE, &scale, 0) < 0) {
        skip("av_tx_init", -1);
        return;
    }
    float *input = av_malloc(SPECTRUM_SIZE * sizeof(float));
    AVComplexFloat *output = av_malloc((SPECTRUM_SIZE / 2 + 1) * sizeof(AVComplexFloat));
    if (input && output) {
        for (int run = 0; run < SPECTRUM_RUNS; ++run) {
            for (int i = 0; i < SPECTRUM_SIZE; ++i) {
                input[i] = (float)((i * 31 + run * 17) % 2001) / 1000.0F - 1.0F;
            }
            fft(transform, output, input, sizeof(float));
        }
    }
    av_free(input);
    av_free(output);
    av_tx_uninit(&transform);
}

int main(int argc, char **argv) {
    const char *files[MAX_FILES], *required = NULL;
    int count = 0, failed = 0;
    long frames[MAX_FILES];
    av_log_set_level(AV_LOG_ERROR);
    for (int i = 1; i < argc && count < MAX_FILES; ++i) {
        if (strncmp(argv[i], "--require=", 10) == 0) {
            required = argv[i] + 10;
        } else {
            files[count] = argv[i];
            frames[count] = decodeFile(argv[i]);
            ++count;
        }
    }
    spectrum();

    // Every required file must have produced frames.
    for (const char *at = required; at && *at;) {
        const char *end = strchr(at, ',');
        const size_t length = end ? (size_t)(end - at) : strlen(at);
        int found = 0;
        for (int i = 0; i < count; ++i) {
            const size_t path = strlen(files[i]);
            if (path >= length && strncmp(files[i] + path - length, at, length) == 0 && frames[i] > 0) {
                found = 1;
            }
        }
        if (!found) {
            fprintf(stderr, "ffmpeg: required file decoded no frames: %.*s\n", (int)length, at);
            ++failed;
        }
        at += length + (end ? 1 : 0);
    }
    printf("ffmpeg: %d skipped, %d required files failed\n", skipped, failed);
    return failed ? 1 : 0;
}
