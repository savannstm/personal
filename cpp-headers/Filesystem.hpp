#pragma once

#include "Aliases.hpp"

template <typename T>
concept Path = std::is_same_v<T, path> || std::is_same_v<T, string_view>;

// Whole file as bytes, plus one trailing '\0' that is not counted by the caller's view of the data
// (size() is file size + 1).
template <Path P>
[[nodiscard]] auto readFile(const P& path) -> Result<vector<char>, string>;

template <Path P>
[[nodiscard]] auto writeFile(const P& path, span<const char> data) -> Result<void, string>;

// Writes to "<path>.tmp", fsyncs and renames over the target, so the target is either the old or the new
// content, never a partial one (QSaveFile semantics). Preserves existing permissions; breaks symlinks/hardlinks.
template <Path P>
[[nodiscard]] auto writeFileAtomic(const P& path, span<const char> data) -> Result<void, string>;