// PGO trainer for libarchive and liblzma: packs a project-like set of files (text, JSON, structured and noisy binary data)
// into the LZMA archives the apps create and read (zip with LZMA, tar.xz, 7z with LZMA2 and LZMA1) and unpacks them
// again, all in memory: once with format and filter auto-detection, once with the specific readers. The updaters
// extract to disk (archive_write_disk, as the apps do) and the Windows update is a 7z of an executable, which 7-Zip
// compresses with the BCJ x86 filter: argv[1] is such an archive (patches/pgo/fixtures/archive), read from its file.

#include <archive.h>
#include <archive_entry.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { FILES = 24 };

// What the apps' updaters pass: the time, no '..' in paths, replacing what is there.
#define EXTRACT_FLAGS (ARCHIVE_EXTRACT_TIME | ARCHIVE_EXTRACT_SECURE_NODOTDOT | ARCHIVE_EXTRACT_UNLINK)

static unsigned seed = 2463534242u;

static unsigned next(void) {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return seed;
}

// Kind 0: script-like text, 1: JSON, 2: structured binary (repeating records), 3: noise (already compressed data).
static size_t fill(unsigned char *data, size_t size, int kind) {
    static const char *const WORDS[] = {"dragon", "village", "knight", "potion", "\"name\":", "\"id\":", "ドラゴン", "騎士", "дракон", "\\C[2]"};
    size_t at = 0;
    while (at < size) {
        switch (kind) {
            case 0:
            case 1: {
                const char *word = WORDS[next() % (sizeof WORDS / sizeof *WORDS)];
                const size_t length = strlen(word);
                if (at + length + 2 > size) {
                    return at;
                }
                memcpy(data + at, word, length);
                at += length;
                data[at++] = kind == 1 && next() % 4 == 0 ? ',' : ' ';
                if (next() % 12 == 0) {
                    data[at++] = '\n';
                }
                break;
            }
            case 2:
                data[at] = (unsigned char)((at % 64) < 16 ? at / 64 : next() % 8);
                ++at;
                break;
            default:
                data[at++] = (unsigned char)next();
                break;
        }
    }
    return at;
}

typedef int (*Setup)(struct archive *);

typedef struct {
    Setup writeFormat;
    Setup writeFilter;  // NULL: the format compresses by itself
    const char *options;
    Setup readFormat;   // the specific reader of the second pass
    Setup readFilter;
} Kind;

static const Kind KINDS[] = {
    {archive_write_set_format_zip, NULL, "zip:compression=lzma", archive_read_support_format_zip, archive_read_support_filter_none},
    {archive_write_set_format_zip, NULL, "zip:compression=lzma,zip:compression-level=9", archive_read_support_format_zip, archive_read_support_filter_none},
    {archive_write_set_format_pax_restricted, archive_write_add_filter_xz, NULL, archive_read_support_format_tar, archive_read_support_filter_xz},
    {archive_write_set_format_7zip, NULL, "7zip:compression=lzma2", archive_read_support_format_7zip, archive_read_support_filter_none},
    {archive_write_set_format_7zip, NULL, "7zip:compression=lzma1", archive_read_support_format_7zip, archive_read_support_filter_none},
};

// Reads the archive file and extracts it into extract/, twice over, the way the updater does.
static int extractFixture(const char *path) {
    for (int round = 0; round < 3; ++round) {
        struct archive *reader = archive_read_new();
        archive_read_support_format_7zip(reader);
        archive_read_support_filter_none(reader);
        if (archive_read_open_filename(reader, path, 10240) != ARCHIVE_OK) {
            fprintf(stderr, "archive: %s: %s\n", path, archive_error_string(reader));
            return 1;
        }
        struct archive_entry *entry;
        while (archive_read_next_header(reader, &entry) == ARCHIVE_OK) {
            char target[256];
            snprintf(target, sizeof target, "extract/%s", archive_entry_pathname(entry));
            archive_entry_set_pathname(entry, target);
            if (archive_read_extract(reader, entry, EXTRACT_FLAGS) != ARCHIVE_OK) {
                fprintf(stderr, "archive: %s\n", archive_error_string(reader));
                return 1;
            }
        }
        archive_read_free(reader);
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <archive.7z>\n", argv[0]);
        return 1;
    }
    const size_t capacity = 64u << 20;
    unsigned char *zip = malloc(capacity), *file = malloc(4u << 20), *read = malloc(4u << 20);
    if (!zip || !file || !read) {
        fprintf(stderr, "archive: out of memory\n");
        return 1;
    }

    size_t unpacked = 0;
    for (size_t k = 0; k < sizeof KINDS / sizeof *KINDS; ++k) {
        const Kind *kind = &KINDS[k];

        // Pack.
        struct archive *writer = archive_write_new();
        kind->writeFormat(writer);
        if (kind->writeFilter) {
            kind->writeFilter(writer);
        }
        if (kind->options && archive_write_set_options(writer, kind->options) != ARCHIVE_OK) {
            fprintf(stderr, "archive: %s\n", archive_error_string(writer));
            return 1;
        }
        size_t used = 0;
        archive_write_open_memory(writer, zip, capacity, &used);
        for (int f = 0; f < FILES; ++f) {
            const size_t size = fill(file, (size_t)(4096u << (f % 10)), f % 4);
            char name[64];
            snprintf(name, sizeof name, "data/%02d/file%02d.%s", f % 5, f, (const char *[]){"txt", "json", "bin", "png"}[f % 4]);

            struct archive_entry *entry = archive_entry_new();
            archive_entry_set_pathname(entry, name);
            archive_entry_set_filetype(entry, AE_IFREG);
            archive_entry_set_perm(entry, 0644);
            archive_entry_set_size(entry, (la_int64_t)size);
            if (archive_write_header(writer, entry) != ARCHIVE_OK || archive_write_data(writer, file, size) < 0) {
                fprintf(stderr, "archive: %s\n", archive_error_string(writer));
                return 1;
            }
            archive_entry_free(entry);
        }
        archive_write_close(writer);
        archive_write_free(writer);

        // Unpack, twice: archives get read more often than written. The first reader detects the format and filter, the
        // second is the specific one.
        for (int pass = 0; pass < 2; ++pass) {
            struct archive *reader = archive_read_new();
            if (pass == 0) {
                archive_read_support_format_all(reader);
                archive_read_support_filter_all(reader);
            } else {
                kind->readFormat(reader);
                kind->readFilter(reader);
            }
            if (archive_read_open_memory(reader, zip, used) != ARCHIVE_OK) {
                fprintf(stderr, "archive: %s\n", archive_error_string(reader));
                return 1;
            }
            struct archive_entry *entry;
            while (archive_read_next_header(reader, &entry) == ARCHIVE_OK) {
                if (pass == 1 && k >= 2) {
                    // The specific readers of tar.xz and 7z extract to disk.
                    char target[256];
                    snprintf(target, sizeof target, "extract/%s", archive_entry_pathname(entry));
                    archive_entry_set_pathname(entry, target);
                    if (archive_read_extract(reader, entry, EXTRACT_FLAGS) != ARCHIVE_OK) {
                        fprintf(stderr, "archive: %s\n", archive_error_string(reader));
                        return 1;
                    }
                    continue;
                }
                la_ssize_t n;
                while ((n = archive_read_data(reader, read, 4u << 20)) > 0) {
                    unpacked += (size_t)n;
                }
                if (n < 0) {
                    fprintf(stderr, "archive: %s\n", archive_error_string(reader));
                    return 1;
                }
            }
            archive_read_free(reader);
        }
    }

    if (extractFixture(argv[1])) {
        return 1;
    }
    printf("archive: %zu bytes unpacked\n", unpacked);
    free(zip);
    free(file);
    free(read);
    return 0;
}
