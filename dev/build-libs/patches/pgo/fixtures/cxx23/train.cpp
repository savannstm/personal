// PGO training translation unit for clang: the C++23 patterns of vu, yuri, rpgmtranslate-qt and revolutionary-audio-player
// that LLVM's own C++17 sources never exercise (concepts, constexpr/consteval-heavy metaprogramming, ranges pipelines,
// enchantum reflection, glaze (de)serialization, std::expected/format/variant). Self-contained: libc++, glaze from CLANG64
// and the enchantum header next to this file. Only compiled, never run.
#include "enchantum_single_header.hpp"

#include <glaze/glaze.hpp>
#include <glaze/toml.hpp>

#include <algorithm>
#include <array>
#include <charconv>
#include <climits>
#include <concepts>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <format>
#include <map>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

using namespace enchantum::bitwise_operators;
using namespace std::literals::string_view_literals;

using usize = std::size_t;
using u8 = std::uint8_t;
using u16 = std::uint16_t;
using u32 = std::uint32_t;
using u64 = std::uint64_t;
using i32 = std::int32_t;
using f64 = double;
using std::array;
using std::optional;
using std::span;
using std::string;
using std::string_view;
using std::variant;
using std::vector;

namespace ranges = std::ranges;
namespace views = std::views;

// ---- Result-style errors -------------------------------------------------------------------------------------------

template <typename T>
using Result = std::expected<T, string>;

[[nodiscard]] inline auto Err(string message) -> std::unexpected<string> {
    return std::unexpected(std::move(message));
}

// ---- Enums for enchantum ------------------------------------------------------------------------------------------

enum class TextureCompression : u8 { None, Bc1, Bc3, Bc7, Astc4x4, Astc8x8 };
enum class HdrDisplayFormat : u8 { Auto, Srgb, Hdr10, Scrgb, Linear };
enum class SortOrder : u8 { Name, Date, Size, Type, Random };
enum class Interpolation : u8 { Nearest, Bilinear, Bicubic, Lanczos, Mitchell, Hermite };
enum class EffectSpeed : u8 { Fast, Slow, Heaviest };

enum class Filter : u32 {
    None = 0,
    Images = 1U << 0,
    Video = 1U << 1,
    Audio = 1U << 2,
    Text = 1U << 3,
    Archives = 1U << 4,
    Hidden = 1U << 5,
};

template <typename Enum>
[[nodiscard]] constexpr auto enumOptions() -> span<const string_view> {
    return enchantum::names<Enum>;
}

template <typename Enum>
[[nodiscard]] constexpr auto enumInitial(const Enum value) -> i32 {
    return static_cast<i32>(*enchantum::enum_to_index(value));
}

template <typename Enum>
[[nodiscard]] auto parseEnum(const string_view text, const Enum fallback) -> Enum {
    if (const optional<Enum> parsed = enchantum::cast<Enum>(text)) {
        return *parsed;
    }

    return fallback;
}

template <typename Enum>
[[nodiscard]] auto describeEnum() -> string {
    string out;

    for (const auto [value, name] : enchantum::entries<Enum>) {
        out += std::format("{}={} ", name, static_cast<u32>(value));
    }

    return out;
}

[[nodiscard]] constexpr auto speedLabel(const EffectSpeed speed) -> string_view {
    switch (speed) {
        case EffectSpeed::Fast:
            return "fast";
        case EffectSpeed::Slow:
            return "slow";
        case EffectSpeed::Heaviest:
            return "very slow";
    }

    std::unreachable();
}

// ---- Concept-constrained string builder (StringBuilder.hpp) -------------------------------------------------------

template <typename T>
concept StringViewConvertible = std::convertible_to<T, string_view> && !std::same_as<std::remove_cvref_t<T>, char>;

template <typename T>
concept Arithmetic = (std::integral<std::remove_cvref_t<T>> || std::floating_point<std::remove_cvref_t<T>>) &&
                     !std::same_as<std::remove_cvref_t<T>, bool> && !std::same_as<std::remove_cvref_t<T>, char>;

template <typename T>
concept ExprNode = requires(const T& node, char* out) {
    { node.size() } -> std::convertible_to<usize>;
    { node.write(out) } -> std::same_as<char*>;
};

struct StrLeaf {
    string_view sv;

    [[nodiscard]] constexpr auto size() const noexcept -> usize { return sv.size(); }

    constexpr auto write(char* out) const noexcept -> char* {
        return std::char_traits<char>::copy(out, sv.data(), sv.size()) + sv.size();
    }
};

struct CharLeaf {
    char c;

    [[nodiscard]] static constexpr auto size() noexcept -> usize { return 1; }

    constexpr auto write(char* out) const noexcept -> char* {
        *out = c;
        return out + 1;
    }
};

template <Arithmetic T>
struct NumLeaf {
    array<char, 32> buffer{};
    usize length = 0;

    explicit NumLeaf(const T val) noexcept {
        const auto result = std::to_chars(buffer.data(), buffer.data() + buffer.size(), val);
        length = static_cast<usize>(result.ptr - buffer.data());
    }

    [[nodiscard]] auto size() const noexcept -> usize { return length; }

    auto write(char* out) const noexcept -> char* {
        return std::char_traits<char>::copy(out, buffer.data(), length) + length;
    }
};

template <ExprNode L, ExprNode R>
struct Cat {
    L lhs;
    R rhs;

    [[nodiscard]] constexpr auto size() const noexcept -> usize { return lhs.size() + rhs.size(); }

    constexpr auto write(char* out) const noexcept -> char* { return rhs.write(lhs.write(out)); }
};

template <typename T>
concept IsNode = ExprNode<std::remove_cvref_t<T>>;

template <typename T>
concept IsBuilder = requires { typename std::remove_cvref_t<T>::sb_builder_tag; };

template <typename T>
constexpr auto makeLeaf(T&& val) {
    using D = std::remove_cvref_t<T>;

    if constexpr (IsBuilder<D>) {
        return std::forward<T>(val).node;
    } else if constexpr (IsNode<T>) {
        return std::forward<T>(val);
    } else if constexpr (std::same_as<D, char>) {
        return CharLeaf{ val };
    } else if constexpr (StringViewConvertible<D>) {
        return StrLeaf{ string_view(val) };
    } else if constexpr (Arithmetic<D>) {
        return NumLeaf<D>(val);
    } else {
        static_assert(!sizeof(T*), "unsupported type for string builder");
    }
}

template <typename T>
concept LeafConvertible =
    StringViewConvertible<std::remove_cvref_t<T>> || std::same_as<std::remove_cvref_t<T>, char> || Arithmetic<T>;

template <ExprNode Node>
struct Builder {
    using sb_builder_tag = void;
    Node node;

    [[nodiscard]] operator string() const {
        string result;
        const usize size = node.size();
        result.resize_and_overwrite(size, [&](char* buf, usize) -> usize {
            node.write(buf);
            return size;
        });
        return result;
    }
};

template <typename L, typename R>
    requires(
        (IsBuilder<L> || LeafConvertible<L>) && (IsBuilder<R> || LeafConvertible<R>) &&
        (IsBuilder<L> || IsBuilder<R> || !(Arithmetic<L> && Arithmetic<R>))
    )
[[nodiscard]] constexpr auto operator%(L&& lhs, R&& rhs) {
    auto lhsLeaf = makeLeaf(std::forward<L>(lhs));
    auto rhsLeaf = makeLeaf(std::forward<R>(rhs));
    using LN = decltype(lhsLeaf);
    using RN = decltype(rhsLeaf);
    return Builder<Cat<LN, RN>>{ Cat<LN, RN>{ std::move(lhsLeaf), std::move(rhsLeaf) } };
}

template <typename... Ts>
[[nodiscard]] auto cat(Ts&&... args) -> string {
    std::tuple leaves{ makeLeaf(std::forward<Ts>(args))... };
    const usize total = std::apply([](const auto&... leaf) -> usize { return (leaf.size() + ... + usize{ 0 }); }, leaves);

    string result;
    result.resize_and_overwrite(total, [&](char* buf, usize) -> usize {
        char* ptr = buf;
        std::apply([&](const auto&... leaf) -> void { ((ptr = leaf.write(ptr)), ...); }, leaves);
        return total;
    });
    return result;
}

// ---- Packed bit fields with NTTP names (PackedBits.hpp) -----------------------------------------------------------

namespace packed_detail {
template <usize N>
struct fixed_string {
    array<char, N> data;

    constexpr fixed_string(const char (&str)[N]) { std::copy_n(str, N, data.data()); }
};

template <usize N, usize M>
constexpr auto operator==(const fixed_string<N>& lhs, const fixed_string<M>& rhs) noexcept -> bool {
    if constexpr (N != M) {
        return false;
    } else {
        for (usize i = 0; i < N; ++i) {
            if (lhs.data[i] != rhs.data[i]) {
                return false;
            }
        }
        return true;
    }
}

constexpr auto mask_for(usize width) noexcept -> u64 {
    return width >= 64 ? ~u64{ 0 } : (u64{ 1 } << width) - 1;
}

template <usize Bits>
using scalar_storage_t = std::
    conditional_t<(Bits <= 8), u8, std::conditional_t<(Bits <= 16), u16, std::conditional_t<(Bits <= 32), u32, u64>>>;
}  // namespace packed_detail

template <packed_detail::fixed_string Name, typename T, usize Bits>
struct Field {
    static constexpr auto name = Name;
    using type = T;
    static constexpr usize bits = Bits;

    static_assert(Bits >= 1 && Bits <= (sizeof(u64) * CHAR_BIT), "Field width must be in [1, 64]");
};

template <typename... Fields>
class PackedBits {
    static constexpr usize total_bits = (Fields::bits + ...);
    using storage_type = packed_detail::scalar_storage_t<total_bits>;

    storage_type storage{};

    template <packed_detail::fixed_string Name, typename First, typename... Rest>
    static consteval auto offset_impl() -> usize {
        if constexpr (First::name == Name) {
            return 0;
        } else if constexpr (sizeof...(Rest) > 0) {
            return First::bits + offset_impl<Name, Rest...>();
        } else {
            static_assert(First::name == Name, "no field with that name");
            return 0;
        }
    }

    template <packed_detail::fixed_string Name, typename First, typename... Rest>
    static consteval auto find_field_impl() {
        if constexpr (First::name == Name) {
            return First{};
        } else if constexpr (sizeof...(Rest) > 0) {
            return find_field_impl<Name, Rest...>();
        } else {
            static_assert(First::name == Name, "no field with that name");
            return First{};
        }
    }

    template <packed_detail::fixed_string Name>
    using field_t = decltype(find_field_impl<Name, Fields...>());

   public:
    template <packed_detail::fixed_string Name>
    [[nodiscard]] constexpr auto get() const noexcept {
        using F = field_t<Name>;
        constexpr usize off = offset_impl<Name, Fields...>();
        const u64 raw = (static_cast<u64>(storage) >> off) & packed_detail::mask_for(F::bits);
        return static_cast<typename F::type>(raw);
    }

    template <packed_detail::fixed_string Name>
    constexpr void set(typename field_t<Name>::type value) noexcept {
        using F = field_t<Name>;
        constexpr usize off = offset_impl<Name, Fields...>();
        constexpr u64 fieldMask = packed_detail::mask_for(F::bits) << off;
        const u64 merged = (static_cast<u64>(storage) & ~fieldMask) | ((static_cast<u64>(value) << off) & fieldMask);
        storage = static_cast<storage_type>(merged);
    }
};

using ViewFlags = PackedBits<
    Field<"fit", bool, 1>,
    Field<"filter", Interpolation, 3>,
    Field<"compression", TextureCompression, 3>,
    Field<"zoom", u16, 12>,
    Field<"speed", EffectSpeed, 2>,
    Field<"loop", bool, 1>>;

[[nodiscard]] constexpr auto packFlags() -> ViewFlags {
    ViewFlags flags;
    flags.set<"fit">(true);
    flags.set<"filter">(Interpolation::Lanczos);
    flags.set<"compression">(TextureCompression::Bc7);
    flags.set<"zoom">(1500);
    flags.set<"speed">(EffectSpeed::Slow);
    return flags;
}

static_assert(packFlags().get<"zoom">() == 1500 && packFlags().get<"filter">() == Interpolation::Lanczos);

// ---- constexpr tables (hash/lookup tables built at compile time) --------------------------------------------------

template <usize N>
[[nodiscard]] consteval auto makeCrcTable() -> array<u32, N> {
    array<u32, N> table{};

    for (usize i = 0; i < N; ++i) {
        u32 crc = static_cast<u32>(i);

        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc & 1U) != 0 ? (crc >> 1) ^ 0xEDB88320U : crc >> 1;
        }

        table[i] = crc;
    }

    return table;
}

inline constexpr auto CRC_TABLE = makeCrcTable<256>();

[[nodiscard]] constexpr auto fnv1a(const string_view text) noexcept -> u64 {
    u64 hash = 0xCBF29CE484222325ULL;

    for (const char chr : text) {
        hash = (hash ^ static_cast<u8>(chr)) * 0x100000001B3ULL;
    }

    return hash;
}

[[nodiscard]] constexpr auto crc32(const string_view text) noexcept -> u32 {
    u32 crc = ~0U;

    for (const char chr : text) {
        crc = CRC_TABLE[(crc ^ static_cast<u8>(chr)) & 0xFFU] ^ (crc >> 8);
    }

    return ~crc;
}

static_assert(fnv1a("vu") != fnv1a("yuri") && crc32("rpgmtranslate") != 0);

// ---- glaze reflection and (de)serialization -----------------------------------------------------------------------

struct Config {
    string background_color = "#101010";
    string texture_compression = "None";
    string sort_order = "Name";
    string interpolation_filter = "Lanczos";
    vector<string> associated_types;
    std::map<string, u64> hashes;
    optional<string> last_applied_executable;
    u32 checker_size = 8;
    u32 memory_budget_percent = 50;
    f64 volume = 0.8;
    bool auto_hide_menu_bar = false;
    bool loop_animations = true;
};

struct Equalizer {
    array<f64, 10> bands{};
    string preset = "flat";
    bool enabled = true;
};

struct LintRule {
    string id;
    string pattern;
    vector<string> categories;
};

template <>
struct glz::meta<Equalizer> {
    using T = Equalizer;
    static constexpr auto value = glz::object(
        "bands",
        &T::bands,
        "preset",
        &T::preset,
        "enabled",
        &T::enabled
    );
};

template <>
struct glz::meta<LintRule> {
    static constexpr auto value = glz::object("id", &LintRule::id, "pattern", &LintRule::pattern, "categories", &LintRule::categories);
};

struct Project {
    Config config;
    Equalizer equalizer;
    vector<LintRule> rules;
    variant<std::monostate, string, u32> selection;
};

template <typename T>
[[nodiscard]] auto readLenient(const string_view json) -> glz::expected<T, glz::error_ctx> {
    auto value = T{};
    const glz::error_ctx error = glz::read<glz::opts{ .error_on_unknown_keys = false }>(value, json);

    if (error) {
        return glz::unexpected(error);
    }

    return value;
}

[[nodiscard]] auto loadProject(const string_view json) -> Result<Project> {
    auto project = readLenient<Project>(json);

    if (!project) {
        return Err(glz::format_error(project.error(), json));
    }

    return std::move(*project);
}

[[nodiscard]] auto saveProject(const Project& project) -> Result<string> {
    string out;

    if (const glz::error_ctx error = glz::write<glz::opts{ .prettify = true }>(project, out)) {
        return Err(glz::format_error(error, out));
    }

    return out;
}

[[nodiscard]] auto loadToml(const string_view document) -> Result<Config> {
    Config config;

    if (const glz::error_ctx error =
            glz::read<glz::opts{ .format = glz::TOML, .error_on_unknown_keys = false }>(config, document)) {
        return Err(glz::format_error(error, document));
    }

    return config;
}

[[nodiscard]] auto saveToml(const Config& config) -> Result<string> {
    string out;

    if (const glz::error_ctx error = glz::write_toml(config, out)) {
        return Err(glz::format_error(error, out));
    }

    return out;
}

// ---- ranges pipelines and variant visitation ----------------------------------------------------------------------

struct Entry {
    string name;
    u64 size;
    Filter kind;
};

[[nodiscard]] auto largestNames(const span<const Entry> entries, const Filter mask) -> vector<string> {
    auto matching = entries | views::filter([mask](const Entry& entry) -> bool { return (entry.kind & mask) != Filter::None; }) |
                    views::transform([](const Entry& entry) -> const Entry& { return entry; });

    vector<const Entry*> sorted;

    for (const Entry& entry : matching) {
        sorted.push_back(&entry);
    }

    ranges::sort(sorted, [](const Entry* lhs, const Entry* rhs) -> bool { return lhs->size > rhs->size; });

    return sorted | views::take(8) | views::transform([](const Entry* entry) -> string { return entry->name; }) |
           ranges::to<vector<string>>();
}

[[nodiscard]] auto joinNames(const span<const Entry> entries) -> string {
    return entries | views::transform(&Entry::name) | views::join_with(", "sv) | ranges::to<string>();
}

using EffectValue = variant<f64, bool, i32, string>;

[[nodiscard]] auto formatValues(const span<const EffectValue> values) -> string {
    string out;

    for (const auto [index, value] : values | views::enumerate) {
        out += std::visit(
            [index](const auto& item) -> string {
                using Item = std::remove_cvref_t<decltype(item)>;

                if constexpr (std::same_as<Item, string>) {
                    return std::format("{}: \"{}\"\n", index, item);
                } else {
                    return std::format("{}: {}\n", index, item);
                }
            },
            value
        );
    }

    return out;
}

[[nodiscard]] auto scanDirectory(const std::filesystem::path& root) -> Result<vector<Entry>> {
    std::error_code error;
    vector<Entry> entries;

    for (const auto& item : std::filesystem::recursive_directory_iterator(root, error)) {
        entries.push_back({ .name = item.path().filename().string(), .size = item.file_size(error), .kind = Filter::Images });
    }

    if (error) {
        return Err(error.message());
    }

    return entries;
}

// The entry point keeps everything alive and instantiated.
auto trainEntry(const int argc, const char* const* const argv) -> int {
    const string label = cat("vu ", argc, ' ', 1.5, " ") % string_view(argv[0]) % '!';
    const Result<Project> project = loadProject(R"({"config":{"checker_size":16},"rules":[{"id":"a","pattern":"b","categories":["c"]}]})");
    const Result<Config> toml = loadToml("checker_size = 4\nloop_animations = false\n");

    const array<Entry, 3> entries{ { { "a.png", 10, Filter::Images }, { "b.mkv", 30, Filter::Video }, { "c.txt", 5, Filter::Text } } };
    const array<EffectValue, 3> values{ 1.5, true, string("x") };

    return static_cast<int>(label.size() + describeEnum<SortOrder>().size() + describeEnum<HdrDisplayFormat>().size() +
                            joinNames(entries).size() + largestNames(entries, Filter::Images | Filter::Video).size() +
                            formatValues(values).size() + speedLabel(EffectSpeed::Heaviest).size() +
                            enumOptions<TextureCompression>().size() + enumInitial(Interpolation::Mitchell) +
                            static_cast<usize>(parseEnum("Bc7"sv, TextureCompression::None)) + packFlags().get<"zoom">() +
                            (project ? saveProject(*project)->size() : 0) + (toml ? saveToml(*toml)->size() : 0) +
                            crc32(label) + fnv1a(label) + scanDirectory(".").value_or(vector<Entry>{}).size() +
                            std::string_view(enchantum::to_string(Interpolation::Bicubic)).size());
}
