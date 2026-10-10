#include "Filesystem.hpp"

#include <cerrno>
#include <cstdio>
#include <fstream>
#include <system_error>

#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

namespace {
// errno reflects the CRT-level failure which is the only portable source of human-readable errors
auto fstreamError() -> string {
    return errno == 0 ? string("unknown I/O error") : std::error_code(errno, std::generic_category()).message();
}
}  // namespace

template <Path P>
auto readFile(const P& path) -> Result<vector<char>, string> {
    std::ifstream input;
    errno = 0;

    if constexpr (std::is_same_v<P, fs::path>) {
        input.open(path, std::ios::binary | std::ios::ate);
    } else {
        input.open(fs::path(path), std::ios::binary | std::ios::ate);
    }

    if (!input) {
        return Err(fstreamError());
    }

    // a directory opens as a stream on POSIX and reports -1 here, which would size the buffer to
    // zero and put the terminator below its start
    errno = 0;
    const isize size = input.tellg();

    if (size < 0) {
        return Err(fstreamError());
    }

    auto buffer = vector<char>(scast<usize>(size) + 1);

    input.seekg(0);
    input.read(buffer.data(), size);
    buffer[size] = '\0';

    return buffer;
}

template <Path P>
auto writeFile(const P& path, const span<const char> data) -> Result<void, string> {
    std::ofstream output;
    errno = 0;

    if constexpr (std::is_same_v<P, fs::path>) {
        output.open(path, std::ios::binary);
    } else {
        output.open(fs::path(path), std::ios::binary);
    }

    if (!output) {
        return Err(fstreamError());
    }

    output.write(data.data(), scast<std::streamsize>(data.size()));

    if (!output) {
        return Err(fstreamError());
    }

    return {};
}

template <Path P>
auto writeFileAtomic(const P& target, const span<const char> data) -> Result<void, string> {
    const auto targetPath = fs::path(target);
    auto temporary = targetPath;
    temporary += ".tmp";

#ifdef _WIN32
    FILE* const file = _wfopen(temporary.c_str(), L"wb");
#else
    FILE* const file = std::fopen(temporary.c_str(), "wb");
#endif

    if (!file) {
        return Err(fstreamError());
    }

    errno = 0;
    // fflush + fsync so a crash after the rename can't leave a renamed-but-empty file
    const bool written = std::fwrite(data.data(), 1, data.size(), file) == data.size() && std::fflush(file) == 0 &&
#ifdef _WIN32
                         _commit(_fileno(file)) == 0;
#else
                         fsync(fileno(file)) == 0;
#endif
    string error;

    if (!written) {
        error = fstreamError();
    }

    std::fclose(file);

    std::error_code code;

    if (written) {
        // keep the existing file's permissions like QSaveFile does; a missing target is not an error
        if (std::error_code ignored; fs::exists(targetPath, ignored)) {
            fs::permissions(temporary, fs::status(targetPath, ignored).permissions(), ignored);
        }

        // replaces an existing target atomically on POSIX and via MoveFileExW(REPLACE_EXISTING) on Windows
        fs::rename(temporary, targetPath, code);

        if (!code) {
            return {};
        }

        error = code.message();
    }

    fs::remove(temporary, code);

    return Err(std::move(error));
}

template auto readFile<path>(const path&) -> Result<vector<char>, string>;
template auto readFile<string_view>(const string_view&) -> Result<vector<char>, string>;
template auto writeFile<path>(const path&, span<const char>) -> Result<void, string>;
template auto writeFile<string_view>(const string_view&, span<const char>) -> Result<void, string>;
template auto writeFileAtomic<path>(const path&, span<const char>) -> Result<void, string>;
template auto writeFileAtomic<string_view>(const string_view&, span<const char>) -> Result<void, string>;
