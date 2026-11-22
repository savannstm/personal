export interface FfmpegVariant {
    consumers: [string, string][];
    decoders: string;
    demuxers: string;
    parsers: string;
    extra?: string;
    filters?: string;
}

export const FFMPEG_VARIANTS: Record<string, FfmpegVariant> = {
    rap: {
        consumers: [["rap", "RAP_FFMPEG_ROOT"]],
        decoders:
            "aac,ac3,alac,dca,eac3,flac,mp3float,opus,pcm_f32be,pcm_f32le,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_u8,truehd,vorbis",
        demuxers: "aac,ac3,aiff,avi,caf,dts,eac3,flac,matroska,mov,mp3,ogg,truehd,wav",
        filters: "aformat,alimiter,aresample,firequalizer",
        parsers: "aac,ac3,dca,flac,mlp,mpegaudio,opus,vorbis",
    },
    trap: {
        consumers: [["rap", "TRAP_FFMPEG_ROOT"]],
        decoders: "aac,alac,flac,mp3float,opus,pcm_f32le,pcm_s16le,pcm_s24le,pcm_s32le,pcm_u8,vorbis",
        demuxers: "aac,aiff,avi,flac,matroska,mov,mp3,ogg,wav",
        filters: "aformat,alimiter,aresample,firequalizer",
        parsers: "aac,flac,mpegaudio,opus,vorbis",
    },
    rpgmtranslate: {
        consumers: [["rpgmtranslate", "FFMPEG_ROOT"]],
        decoders:
            "aac,adpcm_ima_wav,adpcm_ms,flac,h264,mjpeg,mp2float,mp3float,mpeg1video,mpeg2video,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,opus,pcm_f32be,pcm_f32le,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_u8,pcm_s8,pcm_mulaw,pcm_alaw,pcm_dvd,theora,vc1,vorbis,vp8,vp9,wmav1,wmav2,wmv1,wmv2,wmv3",
        demuxers: "asf,avi,flac,matroska,mov,mp3,mpegps,ogg,wav",
        parsers: "h264,mpeg4video,mpegvideo,vc1",
    },
    vu: {
        consumers: [["vu", "FFMPEG_ROOT"]],
        decoders: "libdav1d,h264,hevc,vp8,vp9,mpeg4,theora,gif,apng,webp,webp_anim",
        demuxers: "matroska,mov,avi,ogg,gif,apng,webp,webp_anim",
        extra: "--enable-libdav1d --enable-zlib",
        parsers: "av1,h264,hevc,vp8,vp9,mpeg4video,gif,png",
    },
};

export function ffmpegCodecArgs({ decoders, demuxers, extra, filters, parsers }: FfmpegVariant): string {
    const flags = [extra, `--enable-decoder=${decoders}`, `--enable-demuxer=${demuxers}`, `--enable-parser=${parsers}`];
    if (filters) {
        flags.push(`--enable-filter=${filters}`);
    }
    return flags.filter(Boolean).join(" ");
}
