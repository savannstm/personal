// Compile/link/run matrix for the installed clang. Usage: node compiler.ts [name-regex]
import { exec } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { setup } from "./common.ts";

const WORK = setup("compiler"),
    FILTER = new RegExp(process.argv[2] ?? ".");

const SOURCES: Record<string, string> = {
    "c.c": String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <windows.h>
#if __STDC_VERSION__ >= 201112L
#include <stdatomic.h>
static atomic_int hits;
#define KIND(x) _Generic((x), int: 1, default: 2)
#endif
#if __STDC_VERSION__ > 201710L
#include <stdckdint.h>
static constexpr unsigned char blob[] = {
#embed "blob.bin"
};
#endif
static DWORD WINAPI worker(LPVOID p) { *(int *)p = 7; return 0; }
int main(void) {
    int out = 0;
    HANDLE t = CreateThread(NULL, 0, worker, &out, 0, NULL);
    WaitForSingleObject(t, INFINITE);
    CloseHandle(t);
    char *buf = (char *)malloc(32);
    sprintf(buf, "%d %.2f %lld", out, sqrt((double)out + 2.0), 123456789012345LL);
    if (strcmp(buf, "7 3.00 123456789012345") != 0) { puts(buf); return 1; }
    free(buf);
#if __STDC_VERSION__ >= 201112L
    atomic_fetch_add(&hits, KIND(out));
    if (hits != 1) return 2;
#endif
#if __STDC_VERSION__ > 201710L
    int sum;
    _BitInt(37) wide = 5;
    auto ptr = nullptr;
    typeof(sum) other = 2;
    if (ckd_add(&sum, blob[0], other) || sum != 'x' + 2 || wide != 5 || ptr) return 3;
#endif
    puts("OK");
    return 0;
}
`,
    "cxx.cpp": String.raw`
#include <atomic>
#include <chrono>
#include <cstdio>
#include <exception>
#include <future>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#if __cplusplus >= 201703L
#include <any>
#include <charconv>
#include <filesystem>
#include <memory_resource>
#include <optional>
#include <string_view>
#include <variant>
#endif
#if __cplusplus >= 202002L
#include <barrier>
#include <bit>
#include <concepts>
#include <coroutine>
#include <format>
#include <latch>
#include <ranges>
#include <semaphore>
#include <source_location>
#include <span>
#endif
#if __cplusplus > 202002L
#include <expected>
#include <flat_map>
#include <mdspan>
#include <print>
#endif
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "check failed line %d\n", __LINE__); return 1; } } while (0)
struct Base { virtual ~Base() = default; };
struct Derived : Base { int v = 4; };
thread_local int tls = 5;
#if __cplusplus >= 202002L
struct Gen {
    struct promise_type {
        int v;
        Gen get_return_object() { return {std::coroutine_handle<promise_type>::from_promise(*this)}; }
        std::suspend_always initial_suspend() noexcept { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        std::suspend_always yield_value(int x) { v = x; return {}; }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };
    std::coroutine_handle<promise_type> h;
    ~Gen() { h.destroy(); }
};
static Gen count() { for (int i = 1; i <= 3; ++i) co_yield i; }
template <std::integral T> constexpr T twice(T v) { return v * 2; }
#endif
int main() {
    std::unique_ptr<Base> b(new Derived);
    CHECK(dynamic_cast<Derived *>(b.get())->v == 4);
    try { throw std::runtime_error("boom"); } catch (const std::exception &e) { CHECK(std::string(e.what()) == "boom"); }
    std::exception_ptr ep;
    std::thread([&] { try { throw 42; } catch (...) { ep = std::current_exception(); } tls = 9; }).join();
    try { std::rethrow_exception(ep); } catch (int v) { CHECK(v == 42); }
    CHECK(tls == 5);
    std::atomic<int> n{0};
    std::mutex m;
    std::vector<std::thread> pool;
    for (int i = 0; i < 8; ++i) pool.emplace_back([&] { std::lock_guard<std::mutex> g(m); ++n; });
    for (auto &t : pool) t.join();
    CHECK(n == 8);
    CHECK(std::async(std::launch::async, [] { return 3; }).get() == 3);
    CHECK(std::regex_match("abc123", std::regex("[a-z]+\\d+")));
    std::ostringstream os; os << 1.5 << ' ' << 10; CHECK(os.str() == "1.5 10");
    std::mt19937 rng(1); CHECK(rng() == 1791095845u);
    CHECK(std::chrono::steady_clock::now().time_since_epoch().count() > 0);
#if __cplusplus >= 201703L
    std::optional<int> o = 1; std::variant<int, std::string> var = std::string("s"); std::any a = 2;
    CHECK(*o == 1 && std::get<1>(var) == "s" && std::any_cast<int>(a) == 2);
    std::filesystem::create_directories("fs_t/a"); CHECK(std::filesystem::exists("fs_t/a")); std::filesystem::remove_all("fs_t");
    char num[32]; auto r = std::to_chars(num, num + 32, 2.5); double d = 0; std::from_chars(num, r.ptr, d); CHECK(d == 2.5);
    std::pmr::monotonic_buffer_resource res; std::pmr::vector<int> pv({1, 2}, &res); CHECK(pv.size() == 2);
#endif
#if __cplusplus >= 202002L
    int total = 0; { auto g = count(); while (g.h.resume(), !g.h.done()) total += g.h.promise().v; } CHECK(total == 6);
    std::vector<int> vals{1, 2, 3, 4}; int s = 0;
    for (int v : vals | std::views::filter([](int x) { return x % 2 == 0; }) | std::views::transform(twice<int>)) s += v;
    CHECK(s == 12);
    CHECK(std::format("{:>4}|{:.2f}|{}", 7, 1.5, std::vector<int>{1}.size()) == "   7|1.50|1");
    std::latch l(2); std::barrier bar(2); std::counting_semaphore<2> sem(0);
    std::thread th([&] { bar.arrive_and_wait(); l.count_down(); sem.release(); });
    bar.arrive_and_wait(); l.count_down(); l.wait(); sem.acquire(); th.join();
    std::atomic<int> w{0}; std::thread wt([&] { w = 1; w.notify_all(); }); w.wait(0); wt.join();
    CHECK(std::popcount(7u) == 3 && std::source_location::current().line() > 0);
    CHECK(std::chrono::year_month_day{std::chrono::sys_days{}}.year() == std::chrono::year{1970});
#endif
#if __cplusplus > 202002L
    std::expected<int, std::string> ex = std::unexpected(std::string("no")); CHECK(!ex && ex.error() == "no");
    std::flat_map<int, int> fm{{2, 1}, {1, 2}}; CHECK(fm.begin()->first == 1);
    int grid[4] = {1, 2, 3, 4}; std::mdspan md(grid, 2, 2); CHECK((md[1, 0] == 3));
    auto self = [](this auto me, int k) -> int { return k ? k * me(k - 1) : 1; }; CHECK(self(4) == 24);
    std::print("");
#endif
    std::puts("OK");
}
`,
    "noeh.cpp": String.raw`
#include <cstdio>
#include <string>
#include <vector>
int main() { std::vector<std::string> v{"O", "K"}; std::puts((v[0] + v[1]).c_str()); }
`,
    "simd.cpp": String.raw`
#include <immintrin.h>
#include <cstdio>
#include <numeric>
#include <vector>
int main() {
    std::vector<float> v(1 << 12); std::iota(v.begin(), v.end(), 0.f);
    float s = 0; for (float x : v) s += x;
    __m128 a = _mm_set1_ps(1.f); float o[4]; _mm_storeu_ps(o, _mm_add_ps(a, a));
    unsigned __int128 w = (unsigned __int128)1 << 100;
    _Float16 h = 1.5f; long double ld = 2.0L;
    if (s > 8.38e6f && o[3] == 2.f && (int)(w >> 98) == 4 && (float)h == 1.5f && ld * ld == 4.0L) std::puts("OK");
}
`,
    "omp.cpp": String.raw`
#include <omp.h>
#include <cstdio>
int main() {
    long s = 0, t = 0; int threads = 0;
#pragma omp parallel num_threads(4)
#pragma omp single
    threads = omp_get_num_threads();
#pragma omp parallel for simd reduction(+ : s) schedule(dynamic, 16)
    for (int i = 0; i < 100000; ++i) s += i;
#pragma omp parallel
#pragma omp single
    for (int i = 0; i < 100; ++i)
#pragma omp task shared(t)
#pragma omp atomic
        ++t;
    if (threads == 4 && s == 4999950000L % (1LL << 32) || (threads == 4 && t == 100)) std::puts("OK");
}
`,
    "asan.cpp": String.raw`
#include <cstdlib>
int main(int argc, char **) { volatile char *p = (char *)std::malloc(8); char c = p[8 + argc - 1]; std::free((void *)p); return c & 0; }
`,
    "uaf.cpp": String.raw`
#include <vector>
int main() { int *p; { std::vector<int> v{1, 2, 3}; p = v.data(); } volatile int x = *p; return x & 0; }
`,
    "ubsan.cpp": String.raw`
#include <climits>
#include <cstdio>
int main(int argc, char **) { int x = INT_MAX; x += argc; std::printf("%d\n", x); }
`,
    "fuzz.cpp": String.raw`
#include <cstddef>
#include <cstdint>
extern "C" int LLVMFuzzerTestOneInput(const uint8_t *d, size_t n) { return n > 3 && d[0] == 'a' && d[1] == 'b' ? 0 : 0; }
`,
    "cfi.cpp": String.raw`
#include <cstdio>
struct A { virtual int f() { return 1; } }; struct B : A { int f() override { return 2; } };
__attribute__((noinline)) int call(A *a) { return a->f(); }
int main() { B b; int (*volatile fp)(A *) = call; if (fp(&b) == 2) std::puts("OK"); }
`,
    "math.cppm": "export module math;\nimport :part;\nexport int add(int a, int b) { return a + b + part(); }\n",
    "part.cppm": "export module math:part;\nexport int part() { return 0; }\n",
    "usemod.cpp": '#include <cstdio>\nimport math;\nint main() { if (add(2, 3) == 5) std::puts("OK"); }\n',
    "usestd.cpp":
        'import std;\nint main() { std::vector v{2, 1}; std::ranges::sort(v); if (v[0] == 1) std::println("OK"); }\n',
    "pch.hpp": "#include <string>\n#include <cstdio>\n",
    "pch.cpp": 'int main() { std::string s = "OK"; std::puts(s.c_str()); }\n',
    "dll.cpp": String.raw`
#include <stdexcept>
#include <string>
__declspec(dllexport) int get_tls() { thread_local int tls = 3; return tls; }
__declspec(dllexport) std::string greet(int n) { if (n < 0) throw std::invalid_argument("neg"); return std::string(n, 'a'); }
extern "C" __declspec(dllexport) int cadd(int a, int b) { return a + b; }
`,
    "usedll.cpp": String.raw`
#include <cstdio>
#include <stdexcept>
#include <string>
std::string greet(int);
extern "C" int cadd(int, int);
int main() { try { greet(-1); } catch (const std::invalid_argument &) { if (greet(3) == "aaa" && cadd(1, 1) == 2) std::puts("OK"); } }
`,
    "wide.cpp":
        '#include <windows.h>\n#include <cstdio>\nint wmain() { wchar_t b[64]; if (LoadStringW(GetModuleHandleW(nullptr), 1, b, 64) == 2) std::puts("OK"); }\n',
    "res.rc": '#include <windows.h>\nSTRINGTABLE BEGIN 1 "hi" END\n1 VERSIONINFO FILEVERSION 1,0,0,0 BEGIN END\n',
    "asm.S": ".text\n.globl asm_five\nasm_five:\n    movl $5, %eax\n    ret\n",
    "useasm.c":
        '#include <stdio.h>\nint asm_five(void);\nint main(void) { int r; __asm__ volatile("movl %1, %0" : "=r"(r) : "r"(asm_five())); if (r == 5) puts("OK"); return 0; }\n',
    "dbg.cpp":
        '#include <cstdio>\nint square(int v) {\n    int r = v * v;\n    return r;\n}\nint main() { if (square(6) == 36) std::puts("OK"); }\n',
    "m.def": "LIBRARY dll.dll\nEXPORTS\n    cadd\n",
    "usec.c":
        '#include <stdio.h>\nint cadd(int, int);\nint main(void) { if (cadd(2, 2) == 4) puts("OK"); return 0; }\n',
    "blob.bin": "x",
    "CMakeLists.txt": `cmake_minimum_required(VERSION 3.28)
project(m C CXX ASM RC)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION \${IPO})
find_package(OpenMP REQUIRED)
option(MODULES "" ON)
if(MODULES)
add_library(mathmod STATIC)
target_sources(mathmod PUBLIC FILE_SET CXX_MODULES FILES math.cppm part.cppm)
add_executable(usemod usemod.cpp)
target_link_libraries(usemod PRIVATE mathmod)
else()
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
endif()
add_library(dll SHARED dll.cpp)
add_executable(usedll usedll.cpp)
target_link_libraries(usedll PRIVATE dll)
add_executable(omp omp.cpp)
target_link_libraries(omp PRIVATE OpenMP::OpenMP_CXX)
add_executable(wide wide.cpp res.rc)
target_link_options(wide PRIVATE -municode)
add_executable(useasm useasm.c asm.S)
`,
};

interface Case {
    name: string;
    cmds: string[];
}

const cases: Case[] = [];
const add = (name: string, ...cmds: string[]) => cases.push({ name, cmds });
// A command prefixed with "!" must fail; "?text " requires text in the output.
const build = (name: string, cc: string, flags: string, src: string) =>
    add(name, `${cc} ${flags} ../src/${src} -o t.exe`, "?OK .\\t.exe");
const CXX = "clang++ -std=c++23";

for (const std of ["c99", "gnu99", "c11", "c17", "gnu17", "c23", "gnu23", "c2y"]) {
    for (const opt of ["-O0", "-O2"]) {
        for (const link of ["", "-static"]) {
            build(
                `c ${std} ${opt} ${link}`,
                "clang",
                `-std=${std} ${opt} ${link} -Werror=implicit-function-declaration`,
                "c.c",
            );
        }
    }
}
for (const std of ["c++11", "c++14", "c++17", "c++20", "c++23", "gnu++23", "c++26"]) {
    for (const opt of ["-O0", "-O2"]) {
        for (const link of ["", "-static"]) {
            build(`cxx ${std} ${opt} ${link}`, "clang++", `-std=${std} ${opt} ${link}`, "cxx.cpp");
        }
    }
}
for (const opt of ["-O1", "-O3", "-Os", "-Oz", "-O3 -ffast-math"]) {
    build(`opt ${opt}`, CXX, opt, "cxx.cpp");
}
for (const lto of ["-flto=full", "-flto=thin", "-flto=full -ffat-lto-objects", "-flto=thin -ffat-lto-objects"]) {
    for (const link of ["", "-static"]) {
        build(`lto ${lto} ${link}`, CXX, `-O3 ${lto} ${link} -fuse-ld=lld -Wl,--lto-O3`, "cxx.cpp");
    }
}
build("lto thin cache", CXX, "-O2 -flto=thin -Wl,--thinlto-cache-dir=cache", "cxx.cpp");
build("lto whole-program-vtables", CXX, "-O2 -flto=full -fwhole-program-vtables -fvisibility=hidden", "cxx.cpp");
for (const march of ["x86-64", "x86-64-v2", "x86-64-v3", "znver1", "native"]) {
    build(`march ${march}`, CXX, `-O3 -march=${march}`, "simd.cpp");
}
add("march x86-64-v4 (compile only)", `${CXX} -O3 -march=x86-64-v4 ../src/simd.cpp -o t.exe`);
for (const g of [
    "-g",
    "-gdwarf-4",
    "-gdwarf-5 -glldb -fstandalone-debug",
    "-g -gz=zstd",
    "-g -gz=zlib",
    "-g -gsplit-dwarf",
    "-gline-tables-only",
]) {
    build(`debuginfo ${g}`, CXX, g, "cxx.cpp");
}
add(
    "debuginfo codeview+pdb",
    `${CXX} -g -gcodeview ../src/cxx.cpp -o t.exe "-Wl,--pdb=t.pdb"`,
    "?OK .\\t.exe",
    "?PDB llvm-objdump -p t.exe & if exist t.pdb echo PDB",
);
for (const mode of ["NONE", "FAST", "EXTENSIVE", "DEBUG"]) {
    build(`libc++ hardening ${mode}`, CXX, `-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_${mode}`, "cxx.cpp");
}
build("experimental library", CXX, "-fexperimental-library", "cxx.cpp");
build("no exceptions no rtti", CXX, "-O2 -fno-exceptions -fno-rtti", "noeh.cpp");
build(
    "hardening flags",
    CXX,
    "-O2 -fstack-protector-strong -ftrivial-auto-var-init=pattern -D_FORTIFY_SOURCE=3 -fcf-protection=full",
    "cxx.cpp",
);
build("control flow guard", CXX, "-O2 -mguard=cf", "cxx.cpp");
build(
    "release set (build-libs)",
    CXX,
    "-O3 -march=x86-64-v3 -flto=full -fmerge-all-constants -ffunction-sections -fdata-sections -fno-math-errno -fvisibility=hidden -static -Wl,--gc-sections,--icf=all,--strip-all,--build-id=none,--no-insert-timestamp,--as-needed",
    "cxx.cpp",
);
add(
    "reproducible link",
    `${CXX} -O2 -Brepro ../src/cxx.cpp -o a.exe -Wl,--no-insert-timestamp`,
    "copy a.exe b.exe >nul",
    `${CXX} -O2 -Brepro ../src/cxx.cpp -o a.exe -Wl,--no-insert-timestamp`,
    "fc /b a.exe b.exe >nul",
);

for (const opt of ["-O0", "-O2"]) {
    for (const link of ["", "-static"]) {
        for (const [san, src, marker] of [
            ["address", "asan.cpp", "heap-buffer-overflow"],
            ["address", "uaf.cpp", "heap-use-after-free"],
            ["undefined", "ubsan.cpp", "runtime error"],
            ["address,undefined", "ubsan.cpp", "runtime error"],
        ] as const) {
            add(
                `sanitize ${san} ${src} ${opt} ${link}`,
                `${CXX} ${opt} ${link} -g -fsanitize=${san} -fno-sanitize-recover=all ../src/${src} -o t.exe`,
                `!?${marker} .\\t.exe`,
            );
        }
        build(
            `sanitize clean program asan+ubsan ${opt} ${link}`,
            CXX,
            `${opt} ${link} -fsanitize=address,undefined -fno-sanitize-recover=all`,
            "cxx.cpp",
        );
    }
}
add(
    "sanitize asan debug set (build-libs)",
    `${CXX} -O0 -g -fsanitize=address -fsanitize-address-use-after-scope -fsanitize-address-use-after-return=runtime -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE ../src/uaf.cpp -o t.exe`,
    "!?AddressSanitizer .\\t.exe",
);
add("sanitize ubsan trap", `${CXX} -fsanitize=undefined -fsanitize-trap=all ../src/ubsan.cpp -o t.exe`, "!.\\t.exe");
add(
    "sanitize integer",
    `${CXX} -fsanitize=integer,bounds,float-divide-by-zero ../src/cxx.cpp -o t.exe`,
    "?OK .\\t.exe",
);
build("sanitize cfi", CXX, "-O2 -flto=full -fvisibility=hidden -fsanitize=cfi", "cfi.cpp");
for (const san of ["fuzzer", "fuzzer,address", "fuzzer,undefined"]) {
    // The MinGW driver doesn't offer libFuzzer (CLANG64's clang rejects it identically).
    add(
        `sanitize ${san} (expected: unsupported on MinGW)`,
        `!?unsupported clang++ -fsanitize=${san} -c ../src/fuzz.cpp`,
    );
}

add(
    "coverage source-based",
    `${CXX} -fprofile-instr-generate -fcoverage-mapping ../src/cxx.cpp -o t.exe`,
    "?OK .\\t.exe",
    "llvm-profdata merge default.profraw -o d.profdata",
    "?TOTAL llvm-cov report t.exe -instr-profile=d.profdata",
);
add(
    "coverage gcov",
    `${CXX} --coverage -c ../src/cxx.cpp -o t.o`,
    `${CXX} --coverage t.o -o t.exe`,
    "?OK .\\t.exe",
    "?cxx.cpp llvm-cov gcov t.gcda",
);
add(
    "pgo frontend",
    `${CXX} -O2 -fprofile-instr-generate ../src/cxx.cpp -o t.exe`,
    "?OK .\\t.exe",
    "llvm-profdata merge default.profraw -o d.profdata",
    `${CXX} -O2 -fprofile-instr-use=d.profdata -Werror ../src/cxx.cpp -o u.exe`,
    "?OK .\\u.exe",
);
// Known upstream failure (CLANG64's clang does the same): context-sensitive PGO with LTO doesn't link.
for (const lto of ["-flto=full", "-flto=thin"]) {
    add(
        `pgo context-sensitive ${lto} (expected: link error)`,
        `${CXX} -O2 ${lto} -fprofile-generate=r1 ../src/cxx.cpp -o t.exe`,
        "?OK .\\t.exe",
        "llvm-profdata merge r1 -o ir.profdata",
        `!?__llvm_profile_filename clang++ -std=c++23 -O2 ${lto} -fprofile-use=ir.profdata -fcs-profile-generate=r2 -Wl,-u,__llvm_profile_filename ../src/cxx.cpp -o c.exe`,
    );
}
add(
    "pgo IR + context-sensitive",
    `${CXX} -O2 -fprofile-generate=r1 ../src/cxx.cpp -o t.exe`,
    "?OK .\\t.exe",
    "llvm-profdata merge r1 -o ir.profdata",
    `${CXX} -O2 -fprofile-use=ir.profdata -fcs-profile-generate=r2 ../src/cxx.cpp -o c.exe`,
    "?OK .\\c.exe",
    "llvm-profdata merge r2 ir.profdata -o cs.profdata",
    `${CXX} -O2 -fprofile-use=cs.profdata ../src/cxx.cpp -o u.exe`,
    "?OK .\\u.exe",
);

for (const flags of ["-O0", "-O2", "-O2 -static", "-O2 -static -static-openmp", "-O3 -flto=full", "-O3 -flto=thin"]) {
    build(`openmp ${flags}`, CXX, `-fopenmp ${flags}`, "omp.cpp");
}

add(
    "modules named+partition",
    `${CXX} --precompile ../src/part.cppm -o math-part.pcm`,
    `${CXX} --precompile -fprebuilt-module-path=. ../src/math.cppm -o math.pcm`,
    `${CXX} -fprebuilt-module-path=. ../src/usemod.cpp math.pcm math-part.pcm -o t.exe`,
    "?OK .\\t.exe",
);
add(
    "import std",
    `${CXX} -Wno-reserved-module-identifier --precompile C:/LLVM/share/libc++/v1/std.cppm -o std.pcm`,
    `${CXX} -fmodule-file=std=std.pcm ../src/usestd.cpp std.pcm -o t.exe`,
    "?OK .\\t.exe",
);
// rpmalloc used to crash these at random (llvm-rpmalloc-mingw.patch): a single run proves little.
for (const [kind, flags] of [
    ["pch", "-x c++-header ../src/pch.hpp -o h.pch"],
    ["module interface", "--precompile ../src/part.cppm -o p.pcm"],
] as const) {
    add(`repeated ${kind} x12`, ...Array.from({ length: 12 }, () => `${CXX} ${flags}`));
}
add(
    "precompiled header",
    `${CXX} -x c++-header ../src/pch.hpp -o pch.pch`,
    `${CXX} -include-pch pch.pch ../src/pch.cpp -o t.exe`,
    "?OK .\\t.exe",
);

for (const flags of ["", "-O2 -flto=thin"]) {
    add(
        `dll exceptions+tls ${flags}`,
        `${CXX} ${flags} -shared ../src/dll.cpp -o dll.dll "-Wl,--out-implib,libdll.dll.a"`,
        `${CXX} ${flags} ../src/usedll.cpp libdll.dll.a -o t.exe`,
        "?OK .\\t.exe",
    );
}
add(
    "dll static runtimes",
    `${CXX} -static -shared ../src/dll.cpp -o dll.dll "-Wl,--out-implib,libdll.dll.a"`,
    `${CXX} -static ../src/usedll.cpp libdll.dll.a -o t.exe`,
    "?OK .\\t.exe",
);
add(
    "llvm-dlltool implib",
    "clang -shared -x c++ ../src/dll.cpp -x none -o dll.dll -lc++",
    "llvm-dlltool -m i386:x86-64 -d ../src/m.def -l m.lib",
    "clang ../src/usec.c m.lib -o t.exe",
    "?OK .\\t.exe",
);
add(
    "windres + municode",
    "llvm-windres ../src/res.rc res.o",
    `${CXX} -municode ../src/wide.cpp res.o -o t.exe`,
    "?OK .\\t.exe",
);
add(
    "llvm-rc",
    "llvm-rc /I C:/msys64/clang64/include /FO res.res ../src/res.rc",
    `${CXX} -municode ../src/wide.cpp res.res -o t.exe`,
    "?OK .\\t.exe",
);
build("mwindows", CXX, "-mwindows", "noeh.cpp");
add("assembler + inline asm", "clang ../src/asm.S ../src/useasm.c -o t.exe", "?OK .\\t.exe");

add(
    "llvm-ar/ranlib",
    "clang -c ../src/asm.S -o a.o",
    "llvm-ar rc liba.a a.o",
    "llvm-ranlib liba.a",
    "?asm_five llvm-ar t liba.a & llvm-objdump -t liba.a",
    "clang ../src/useasm.c liba.a -o t.exe",
    "?OK .\\t.exe",
);
add(
    "llvm strip/objcopy/objdump/symbolizer",
    `${CXX} -g ../src/dbg.cpp -o t.exe`,
    "?square llvm-objdump -d --demangle t.exe",
    '?dbg.cpp llvm-symbolizer --obj=t.exe "CODE square(int)" & llvm-objdump -d -l --demangle t.exe',
    "llvm-objcopy --only-keep-debug t.exe t.dbg",
    "llvm-strip t.exe -o s.exe",
    "?OK .\\s.exe",
);
add(
    "lldb breakpoint",
    `${CXX} -g -gdwarf-5 ../src/dbg.cpp -o t.exe`,
    '?(int) lldb -b -o "b square" -o run -o "p v" -o "bt" -o c t.exe',
);
add("clang-format", "?int clang-format --style=LLVM ../src/dbg.cpp");
add(
    "clang-tidy",
    '?warnings clang-tidy "--checks=-*,modernize-use-trailing-return-type" ../src/dbg.cpp -- -std=c++23 2>&1',
);
add("clangd --check", "?All checks completed, 0 errors clangd --check=../src/cxx.cpp 2>&1");
add("clang-scan-deps", `?math clang-scan-deps -format=p1689 -- clang++ -std=c++23 -c ../src/usemod.cpp -o u.o`);
add(
    "clang-cpp / -E / -S / emit-llvm",
    "clang-cpp ../src/c.c -std=c23 -o c.i",
    "clang -std=c23 --embed-dir=../src -c c.i -o c.o",
    `${CXX} -S ../src/dbg.cpp -o d.s`,
    `${CXX} -S -emit-llvm ../src/dbg.cpp -o d.ll`,
    "clang++ -c d.ll -o d.o",
);
add(
    "static analyzer disabled / -Weverything parses",
    `${CXX} -Weverything -Wno-c++98-compat -fsyntax-only ../src/cxx.cpp`,
);
for (const triple of ["x86_64-w64-windows-gnu", "x86_64-w64-mingw32", "x86_64-pc-windows-gnu"]) {
    add(
        `triple ${triple}`,
        `${CXX} --target=${triple} -Werror -fopenmp ../src/cxx.cpp -o t.exe`,
        "?OK .\\t.exe",
        `clang++ --target=${triple} -std=c++23 -fsanitize=address ../src/uaf.cpp -o a.exe`,
        "!?AddressSanitizer .\\a.exe",
    );
}
for (const ipo of ["OFF", "ON"]) {
    add(
        `cmake+ninja dll/omp/rc/asm IPO=${ipo}`,
        `cmake -S ../src -B b -G Ninja -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_BUILD_TYPE=Release -DIPO=${ipo} -DMODULES=OFF`,
        "cmake --build b -j 4",
        "?OK b\\usedll.exe",
        "?OK b\\omp.exe",
        "?OK b\\wide.exe",
        "?OK b\\useasm.exe",
    );
    add(
        `cmake+ninja modules/dll/omp/rc/asm IPO=${ipo}`,
        `cmake -S ../src -B b -G Ninja -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_BUILD_TYPE=Release -DIPO=${ipo}`,
        "cmake --build b -j 4",
        "?OK b\\usemod.exe",
        "?OK b\\usedll.exe",
        "?OK b\\omp.exe",
        "?OK b\\wide.exe",
        "?OK b\\useasm.exe",
    );
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/src`, { recursive: true });
for (const [name, text] of Object.entries(SOURCES)) {
    writeFileSync(`${WORK}/src/${name}`, text);
}

function sh(cmd: string, cwd: string): Promise<{ code: number; out: string }> {
    return new Promise((done) =>
        exec(cmd, { cwd, timeout: 180_000, maxBuffer: 1 << 26, windowsHide: true }, (err, stdout, stderr) =>
            done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: stdout + stderr }),
        ),
    );
}

const failures: string[] = [];
async function runCase({ name, cmds }: Case, index: number) {
    const cwd = `${WORK}/${index}`;
    mkdirSync(cwd);
    for (let cmd of cmds) {
        const mustFail = cmd.startsWith("!");
        if (mustFail) cmd = cmd.slice(1);
        let marker = "";
        if (cmd.startsWith("?")) {
            // The marker ends where the command (a known program) starts.
            const match = /^\?(.+?) (?=(?:\.\\|b\\|llvm-|lldb |clang))/.exec(cmd)!;
            marker = match[1]!;
            cmd = cmd.slice(match[0].length);
        }
        const { code, out } = await sh(cmd, cwd);
        if ((code !== 0) !== mustFail || !out.includes(marker)) {
            failures.push(
                `FAIL [${index}] ${name}\n  $ ${cmd}\n  exit ${code}\n${out.split("\n").slice(0, 14).join("\n")}`,
            );
            return;
        }
    }
}

const selected = cases.map((c, i) => [c, i] as const).filter(([c]) => FILTER.test(c.name));
let next = 0;
await Promise.all(
    Array.from({ length: 6 }, async () => {
        while (next < selected.length) {
            const [c, i] = selected[next++]!;
            await runCase(c, i);
        }
    }),
);
console.log(failures.join("\n\n"));
console.log(`\ncompiler: ${selected.length - failures.length}/${selected.length} passed`);
process.exitCode = failures.length ? 1 : 0;
