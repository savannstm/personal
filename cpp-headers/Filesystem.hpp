#pragma once

#include "Aliases.hpp"

[[nodiscard]] auto readFile(const path& file) -> Result<vector<char>, string>;

[[nodiscard]] auto writeFile(const path& file, span<const char> data) -> Result<void, string>;

[[nodiscard]] auto writeFileAtomic(const path& target, span<const char> data) -> Result<void, string>;
