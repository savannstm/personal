// PGO trainer for libarchive and liblzma: packs a project-like set of files (text, JSON, structured and noisy binary data)
// into LZMA-compressed zips and unpacks them again, all in memory.

#include <archive.h>
#include <archive_entry.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { FILES = 24 };

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

int main(void) {
    const size_t capacity = 64u << 20;
    unsigned char *zip = malloc(capacity), *file = malloc(4u << 20), *read = malloc(4u << 20);
    if (!zip || !file || !read) {
        fprintf(stderr, "archive: out of memory\n");
        return 1;
    }

    size_t unpacked = 0;
    for (int round = 0; round < 3; ++round) {
        // Pack.
        struct archive *writer = archive_write_new();
        archive_write_set_format_zip(writer);
        if (archive_write_set_options(writer, round == 2 ? "zip:compression=lzma,zip:compression-level=9" : "zip:compression=lzma") != ARCHIVE_OK) {
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

        // Unpack, twice: zips get read more often than written.
        for (int pass = 0; pass < 2; ++pass) {
            struct archive *reader = archive_read_new();
            archive_read_support_format_zip(reader);
            if (archive_read_open_memory(reader, zip, used) != ARCHIVE_OK) {
                fprintf(stderr, "archive: %s\n", archive_error_string(reader));
                return 1;
            }
            struct archive_entry *entry;
            while (archive_read_next_header(reader, &entry) == ARCHIVE_OK) {
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

    printf("archive: %zu bytes unpacked\n", unpacked);
    free(zip);
    free(file);
    free(read);
    return 0;
}
