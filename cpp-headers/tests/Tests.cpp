// Tests for the headers in this directory. Opt-in: configure with -DCPP_HEADERS_BUILD_TESTS=ON.
// No framework: each CHECK reports its failure and the exit code is 1 if any failed.

#include "Filesystem.hpp"
#include "Hasher.hpp"
#include "Numbers.hpp"
#include "PackedBits.hpp"
#include "StringBuilder.hpp"

#include <cstdio>
#include <limits>

// Stand-in for the real gxhash (Rust); only Hasher's plumbing is under test here (FNV-1a).
extern "C" auto gxhash(const void* ptr, const usize len) -> u64 {
    u64 hash = 14695981039346656037ULL;
    for (const u8 byte : span(static_cast<const u8*>(ptr), len)) {
        hash = (hash ^ byte) * 1099511628211ULL;
    }
    return hash;
}

namespace {
int failures = 0;

#define CHECK(expr)                                                                       \
    do {                                                                                  \
        if (!(expr)) {                                                                    \
            ++failures;                                                                   \
            std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #expr); \
        }                                                                                 \
    } while (false)

enum class Mode : u8 { Off, On, Auto, Max = 7 };

void testHasher() {
    static constexpr Hasher HASH;
    const u32 seven = 7;
    CHECK(HASH(string("abc")) == gxhash("abc", 3));
    CHECK(HASH(string("abc")) == HASH(vector<char>{ 'a', 'b', 'c' }));
    CHECK(HASH(seven) == gxhash(&seven, sizeof(seven)));
    CHECK(HASH(string("abc")) != HASH(string("abd")));

    static_assert(ByteRange<string>);
    static_assert(ByteRange<vector<u8>>);
    static_assert(!ByteRange<vector<string>>);

    HashMap<string, i32> map;
    map.emplace("one", 1);
    map.emplace("two", 2);
    CHECK(map["one"] == 1);
    CHECK(map["two"] == 2);
    CHECK(map.size() == 2);

    HashSet<u32> set{ 1, 2, 3, 2 };
    CHECK(set.size() == 3);
    CHECK(set.contains(2));
    CHECK(!set.contains(9));
}

void testNumbers() {
    CHECK(itos(0).view() == "0");
    CHECK(itos(42).view() == "42");
    CHECK(itos(-42).view() == "-42");
    CHECK(itos(5, 3).view() == "  5");
    CHECK(itos(5, 3, '0').view() == "005");
    CHECK(itos(-5, 4, '0').view() == "-005");
    CHECK(itos(12345, 2).view() == "12345");
    CHECK(itos(std::numeric_limits<i64>::min()).view() == "-9223372036854775808");
    CHECK(itos(std::numeric_limits<u64>::max()).view() == "18446744073709551615");
    CHECK(itos(7).size() == 1);
    CHECK(itos(7).data()[1] == '\0');
    CHECK(itos<wchar>(123).view() == L"123");
    CHECK(string_view(itos(9)) == "9");

    CHECK(htos(u32{ 0 }).view() == "0");
    CHECK(htos(u32{ 255 }).view() == "ff");
    CHECK(htos(u32{ 255 }, 0, true).view() == "FF");
    CHECK(htos(u32{ 255 }, 6).view() == "0000ff");
    CHECK(htos(u8{ 0xAB }).view() == "ab");
    CHECK(htos(std::numeric_limits<u64>::max()).view() == "ffffffffffffffff");
    CHECK(htos(u8{ 1 }, 4).view() == "0001");  // padding wider than the type

    CHECK(ftos(1.5).view() == "1.5");
    CHECK(ftos(0.1).view() == "0.1");
    CHECK(ftos(1.5, 3).view() == "1.500");
    CHECK(ftos(3.0, 0).view() == "3");
    CHECK(ftos(1.5F).view() == "1.5");
    CHECK(ftos(1e300, 2).size() > 0);  // fixed form too large: falls back to the shortest one

    CHECK(stoa<i32>("123"sv) == 123);
    CHECK(stoa<i32>("-123"sv) == -123);
    CHECK(stoa<u32>("ff"sv, 16) == 255);
    CHECK(stoa<i32>("101"sv, 2) == 5);
    CHECK(stoa<f64>("1.25"sv) == 1.25);
    CHECK(stoa<f64>("-1e3"sv) == -1000.0);
    CHECK(!stoa<i32>(""sv));
    CHECK(!stoa<i32>("12x"sv));
    CHECK(!stoa<i32>("abc"sv));
    CHECK(!stoa<u8>("300"sv));
    CHECK(!stoa<f64>("1.5abc"sv));
    CHECK(!stoa<f64>("inf"sv));
    CHECK(!stoa<f64>("nan"sv));
    CHECK(stoa<i32>(L"77"sv) == 77);
}

void testPackedBits() {
    using Flags = PackedBits<Field<"on", bool, 1>, Field<"count", u8, 4>, Field<"delta", i8, 3>, Field<"mode", Mode, 3>>;
    static_assert(Flags::bit_count == 11);
    static_assert(Flags::size_bytes == 2);

    Flags flags;
    CHECK(!flags.get<"on">());
    CHECK(flags.get<"count">() == 0);

    flags.set<"on">(true);
    flags.set<"count">(9);
    flags.set<"delta">(-3);
    flags.set<"mode">(Mode::Max);
    CHECK(flags.get<"on">());
    CHECK(flags.get<"count">() == 9);
    CHECK(flags.get<"delta">() == -3);  // sign extension
    CHECK(flags.get<"mode">() == Mode::Max);

    flags.set<"count">(0x1F);  // masked to 4 bits, must not spill into the neighbor
    CHECK(flags.get<"count">() == 15);
    CHECK(flags.get<"delta">() == -3);
    flags.set<"on">(false);
    CHECK(!flags.get<"on">());
    CHECK(flags.get<"count">() == 15);

    constexpr Flags built(true, 5, -4, Mode::Auto);
    static_assert(built.get<"on">());
    static_assert(built.get<"count">() == 5);
    static_assert(built.get<"delta">() == -4);
    static_assert(built.get<"mode">() == Mode::Auto);

    // Wider than 64 bits: fields straddle word boundaries.
    using Wide = PackedBits<Field<"low", u64, 60>, Field<"mid", u32, 20>, Field<"top", i16, 12>, Field<"flag", bool, 1>>;
    static_assert(Wide::bit_count == 93);
    static_assert(Wide::size_bytes == 16);

    Wide wide;
    wide.set<"low">(0xFFFFFFFFFFFFFFFULL);
    wide.set<"mid">(0xABCDE);
    wide.set<"top">(-100);
    wide.set<"flag">(true);
    CHECK(wide.get<"low">() == 0xFFFFFFFFFFFFFFFULL);
    CHECK(wide.get<"mid">() == 0xABCDE);  // spans both words
    CHECK(wide.get<"top">() == -100);
    CHECK(wide.get<"flag">());
    wide.set<"mid">(0);
    CHECK(wide.get<"low">() == 0xFFFFFFFFFFFFFFFULL);
    CHECK(wide.get<"mid">() == 0);
    CHECK(wide.get<"top">() == -100);

    using Full = PackedBits<Field<"all", u64, 64>>;
    Full full;
    full.set<"all">(~u64{ 0 });
    CHECK(full.get<"all">() == ~u64{ 0 });

    using Signed64 = PackedBits<Field<"val", i64, 64>>;
    Signed64 signed64;
    signed64.set<"val">(-1);
    CHECK(signed64.get<"val">() == -1);

    static_assert(packed_detail::mask_for(0) == 0);
    static_assert(packed_detail::mask_for(8) == 0xFF);
    static_assert(packed_detail::mask_for(64) == ~u64{ 0 });
}

void testStringBuilder() {
    CHECK(string("a" % string("b")) == "ab");
    CHECK(string("a" % string_view("b") % 'c') == "abc");
    CHECK(string("n=" % string("x") % 42) == "n=x42");
    CHECK(string("n=" % 42 % ", f=" % 1.5) == "n=42, f=1.5");
    CHECK(string(1 % string("x")) == "1x");
    CHECK(("ab" % string("cd")).size() == 4);
    CHECK(("x" % string("y")).str() == "xy");

    const auto left = "a" % string("b");
    const auto right = "c" % string("d");
    CHECK(string(left % right) == "abcd");  // builder % builder
    CHECK(string(left % 'z') == "abz");

    CHECK(cat() == "");
    CHECK(cat("a", 'b', 3, string("c"), 2.5) == "ab3c2.5");

    string dst = "x";
    append(dst, "y", 1, 'z');
    CHECK(dst == "xy1z");
    append(dst);
    CHECK(dst == "xy1z");

    static_assert(Arithmetic<int>);
    static_assert(!Arithmetic<char>);
    static_assert(!Arithmetic<bool>);
    static_assert(StringViewConvertible<const char*>);
    static_assert(!StringViewConvertible<char>);
    static_assert(ExprNode<StrLeaf>);
    static_assert(IsBuilder<decltype("a" % string("b"))>);
}

void testFilesystem() {
    const path dir = fs::temp_directory_path() / "cpp_headers_tests";
    fs::remove_all(dir);
    fs::create_directories(dir);

    const string text = "hello\nworld";
    const span<const char> data(text.data(), text.size());
    const path file = dir / "a.txt";

    CHECK(writeFile(file, data).has_value());
    const auto read = readFile(file);
    CHECK(read.has_value());
    if (read) {
        CHECK(read->size() == text.size() + 1);  // trailing terminator
        CHECK(string_view(read->data()) == text);
        CHECK(read->back() == '\0');
    }

    CHECK(writeFile(file, span<const char>{}).has_value());  // truncates
    const auto empty = readFile(file);
    CHECK(empty && empty->size() == 1);

    CHECK(!readFile(dir / "missing.txt"));
    CHECK(!readFile(dir));  // a directory
    CHECK(!writeFile(dir / "no" / "such" / "dir.txt", data));

    const path target = dir / "atomic.txt";
    CHECK(writeFileAtomic(target, data).has_value());
    CHECK(string_view(readFile(target).value().data()) == text);
    CHECK(writeFileAtomic(target, span<const char>{ "new", 3 }).has_value());  // replaces existing
    CHECK(string_view(readFile(target).value().data()) == "new");

    usize leftovers = 0;
    for (const auto& entry : fs::directory_iterator(dir)) {
        leftovers += entry.path().string().contains(".tmp") ? 1 : 0;
    }
    CHECK(leftovers == 0);  // no temporary file left behind
    CHECK(!writeFileAtomic(dir / "no" / "dir.txt", data));

    fs::remove_all(dir);
}
}  // namespace

auto main() -> int {
    testHasher();
    testNumbers();
    testPackedBits();
    testStringBuilder();
    testFilesystem();

    if (failures == 0) {
        std::puts("all tests passed");
    }
    return failures == 0 ? 0 : 1;
}
