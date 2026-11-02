#include "Filesystem.hpp"

#include <cerrno>
#include <cstdio>
#include <fstream>
#include <system_error>

#ifdef _WIN32
#include <io.h>
#include <process.h>
#else
#include <unistd.h>
#endif

namespace {
// errno reflects the CRT-level failure which is the only portable source of
// human-readable errors
auto fstreamError() -> string {
    return errno == 0 ? string("unknown I/O error") : std::error_code(errno, std::generic_category()).message();
}
}  // namespace

auto readFile(const path& file) -> Result<vector<char>, string> {
    std::ifstream input;
    errno = 0;
    input.open(file, std::ios::binary | std::ios::ate);

    if (!input) {
        return Err(fstreamError());
    }

    // a directory opens as a stream on POSIX and reports -1 here, which would
    // size the buffer to zero and put the terminator below its start
    errno = 0;
    const isize size = input.tellg();

    if (size < 0) {
        return Err(fstreamError());
    }

    auto buffer = vector<char>(static_cast<usize>(size) + 1);

    errno = 0;
    input.seekg(0);
    input.read(buffer.data(), size);

    // a short read leaves the tail zeroed, which would look like real data
    if (!input) {
        return Err(fstreamError());
    }

    buffer[size] = '\0';

    return buffer;
}

auto writeFile(const path& file, const span<const char> data) -> Result<void, string> {
    std::ofstream output;
    errno = 0;
    output.open(file, std::ios::binary);

    if (!output) {
        return Err(fstreamError());
    }

    output.write(data.data(), static_cast<std::streamsize>(data.size()));

    // small writes only fill the stream's buffer; a full disk shows up when close() flushes it
    output.close();

    if (!output) {
        return Err(fstreamError());
    }

    return {};
}

auto writeFileAtomic(const path& target, const span<const char> data) -> Result<void, string> {
    auto temporary = target;

#ifdef _WIN32
    const int processId = _getpid();
#else
    const int processId = getpid();
#endif

    temporary += format(".tmp{}", processId);

#ifdef _WIN32
    FILE* file = nullptr;
    const errno_t openError = _wfopen_s(&file, temporary.c_str(), L"wb");

    if (file == nullptr) {
        return Err(std::error_code(openError, std::generic_category()).message());
    }
#else
    errno = 0;
    FILE* const file = std::fopen(temporary.c_str(), "wb");

    if (file == nullptr) {
        return Err(fstreamError());
    }
#endif

    errno = 0;
    // fflush + fsync so a crash after the rename can't leave a renamed-but-empty
    // file
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
        // keep the existing file's permissions
        if (std::error_code ignored; fs::exists(target, ignored)) {
            fs::permissions(temporary, fs::status(target, ignored).permissions(), ignored);
        }

        fs::rename(temporary, target, code);

        if (!code) {
            return {};
        }

        error = code.message();
    }

    fs::remove(temporary, code);

    return Err(std::move(error));
}
