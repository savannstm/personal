# ~/.claude/CLAUDE.md

## Signing commits

Do not sign commits and don't co-author.

## Engineering Philosophy

For the general code style, Ponytail skill should be used. Otherwise performance and readability together, not "clean code" rules.

- Provably-safe unsafe/unchecked operations are preferred. Rust `unsafe`, `unwrap_unchecked`, `get_unchecked`; C++ `rcast`, manual `new[]`/`delete[]`, unions, bit-packing, placement tricks, unchecked accessors - whenever the precondition is provable (or very confident from call context) or an FFI/callback ABI requires it. Don't "clean up" into safer but slower code. The one place comments are mandatory: state the invariant that makes it safe.
- Hunt micro-optimizations in every piece of code touched - unnecessary allocations, copies, repeated passes:
    - Pre-size/reserve and write once; no repeated concatenation/reallocation.
    - Building a string/vector from a collection: sizing pass, allocate once, fill in a second pass.
    - Borrow/move instead of copy or clone unless ownership is required.
    - Stack and value types over heap when size and lifetime are bounded.
    - Combine passes, drop redundant traversals, cut heap churn. Look for analogous patterns beyond these.
- Performance vs readability is situational. Gains without meaningful complexity: always apply. Larger hacks (unsafe tricks, manual memory, bit manipulation, cache-friendliness rewrites): judge by path hotness. Hot (audio thread, drawing, text layout, highlighting, table painting): justified, briefly explain the tradeoff. Not hot: plain obviously-correct code wins. Unsure which: ask or state the assumption.
- Restraint on rewrites. Flag code that is both slower and more convoluted than needed; don't rewrite working, non-bottleneck code unless asked.

## C++ Conventions

All C++ projects target C++23 and share one architecture. These are defaults for any C++ codebase; build any missing piece (`Aliases.hpp`, `FWD.hpp`, ...) in this shape. A project's own `AGENTS.md`/`CLAUDE.md` refines this and wins where they differ.

Idioms - modern over replaced, unconditionally:

- `std::expected` aliased `Result<T,E>` / `Err<E>` for fallible operations. Never exceptions, error out-params, or `optional` + side channel. `variant` only for genuine sum types.
- `ranges`/`views` over index loops when a view composes cleanly (`views::enumerate`, `filter`, `drop`, `take`, `ranges::find_if`); manual loop only when mid-iteration `break`/return needs extra bookkeeping.
- Designated initializers (`Struct{.field = value}`) for aggregates.
- Concepts over SFINAE; deducing `this`, `if consteval`, multidimensional `operator[]`, `std::unreachable()` in exhaustive switches, `std::to_underlying`.
- `std::scoped_lock`, never `lock_guard`, even for one mutex.
- Unique smart pointers over shared ownership; Shared smart pointers only when ownership is genuinely shared.
- Exceptions only at external boundaries (`fs::filesystem_error`, throwing libraries like Magick++/nuspell); catch narrowly.
- No older idioms (macro type traits, C-style casts, manual RAII where a standard wrapper exists).
- Casts only via aliases (`scast`, `rcast`, `ccast`, ...). Never raw `static_cast<...>`.

Declarations:

- Constructor call / explicit member init: `auto var = Type{...}` / `auto var = Type(...)`. `Type var{...}` and `Type var(...)` are prohibited.
- Factory/static initializer or none: concrete type - `Type var = Type::create(...);`, `Type var;`. No `auto`.
- Integers always spell the alias, never `auto`: `u32 count = parse(s);`.

No zero-initialization - don't init/default-fill anything written before it's read: `Type var;`, `array<u8, N> buf;`. Init at declaration only when something depends on the pre-write value (a flag/sentinel checked before set, a member read on a possibly-unwritten path, a type whose constructor must run). Never `= 0` / `{}` "for safety" - a read reaching an unwritten value is a control-flow bug; fix it.

Const - `constexpr` > `const` > mutable, wherever possible. Every `constexpr` variable (namespace-scope or local) is `static constexpr`, except internal-linkage constants, which go in an anonymous namespace instead of `static` (and never mark declarations inside it `static`). Never-reassigned data is `const`; never-repointed pointers are `const`, both fixed: `const T* const`. Clang only, never GCC.

Layout and naming:

- Members ordered largest to smallest type. `alignas` only for SIMD/cache-line width, external ABI, or false-sharing avoidance (e.g. audio vs UI thread).
- Names: at least 3 characters, descriptive, spelled out (`tableColumns`, not `tableCols`); shorten only when genuinely unwieldy.

Architecture - expect, and build if missing:

- `src/utilities/Aliases.hpp`: `u8`..`u64`, `i8`..`i64`, `f32`, `f64`, `usize`/`isize`, `atomicX`, `Result`/`Err`, cast aliases, `ranges`/`views`, and `using`s for common `std::` names (`tuple`, `vector`, `span`, `optional`, ...). Always use the aliases (`u32` not `uint32_t`, `vector` not `std::vector`); add a `using` when a std type becomes common. Toolkit aliases (`QUtf8SV`, `QL1SV`, `QSVList`) go in a separate header (`QtAliases.hpp`) it includes. A toolkit-free `core/` layer gets its own aliases and never depends on the toolkit.
- `FWD.hpp`: forward declarations. A file needing a type only by pointer/reference forward-declares it there - never locally, never by including the full header. Add missing ones there.
- `Enums.hpp`, `Types.hpp` (domain types), `Constants.hpp`, `Utils.hpp/.cpp` (free helpers): each concept in its matching header, never in `Aliases.hpp`. Single-purpose headers stay separate (`Numbers`, `Hasher`, `PackedBits`, `StringBuilder`, `Filesystem`, `Logger`, `Dialog`, `glazemeta`).
- `Hasher.hpp`: `HashMap<K,V>`/`HashSet<E>` on gxhash (via Rust FFI) as the only associative containers - never `std::unordered_map`/`QHash`/`std::hash`. `operator[]` is lookup-only (key must exist); add with `emplace`/`insert_or_assign`. If missing, add it: it declares `extern "C" gxhash(const void*, usize)` itself and the Rust export uses that name.
- Symbols used by more than one or two classes go in the matching `src/utilities/*.hpp`. Symbols scoped to one class or a tightly-coupled pair stay local, beside their user. Don't promote just because reuse is possible.
- One `src/<Component>/` directory per top-level UI component; shared code in `src/utilities/`, vendored in `src/3rdparty/`. A `.cpp` past ~1000 lines splits by concern (`Component{Concern1,Concern2}.cpp`); follow existing splits.

Libraries - always, not situationally:

- Numbers: only through `Numbers.hpp` (zmij/fast_float parsing/writing). Never `std::to_string`/`from_chars`/`snprintf`/`ostringstream`/`stoi` or `QString::number`/`.toInt()`/`.toDouble()`. API: `itos(int, pad = 0, padChar = ' ')`, `htos(unsigned, pad = 0, uppercase = false)`, `ftos(float, precision = -1)` (negative = shortest round-trip), `stoa<T>(view, base = 10)` -> `optional<T>`.
    - Results are stack `Digits<>` (NUL-terminated; `data()`/`size()`/`view()`); pointers/views die at the end of the full expression - never store them.
    - Qt: `qitos`/`qhtos`/`qftos` (`QtNumbers.hpp`), then `qsv(digits)` (view) or `qstr(digits)` (owning).
- Serialization: Glaze for any format, `glz::meta<T>` next to the type. Never hand-rolled parsing, other format libs, or `QJson*`.
- Enums: `enchantum` for reflection/(de)serialization and flag bitwise ops (`using namespace enchantum::bitwise_operators`). Flag enums are plain `enum`; scoped `enum class` only for closed, non-flag sets.
- Strings: `std::format` only when the result is UTF-8 and `%` concatenation would be very messy; otherwise `%` (`StringBuilder.hpp` in FLTK projects).
- `[[nodiscard]]` on every function whose dropped result is a silent bug; never `(void)`-cast it away - handle it.
- `final` on every concrete class not designed as a base.

Zero-copy - views over owning copies wherever ownership isn't needed: `string_view`/`QStringView`/`QUtf8SV`/`QL1SV`, `span<T>` instead of by-value or re-copied containers. `rcast` in place across FFI/C boundaries (FFmpeg, miniaudio, gxhash, `FFIString`/`ByteBuffer`) when layouts match. Copy explicitly (say why if unobvious) when lifetime is unclear or risky: view into a dying local, buffer another thread may mutate.

## Build and Verification

- Never build, link or launch unless asked: no `cmake --build`, `ninja`, running the app, smoke tests or link checks. Build-system targets (`update_translations`, ...) count as building: ask first.
- Verify with `-fsyntax-only`: take the changed file's exact command from `build/compile_commands.json`, replace `-o <obj>` with `-fsyntax-only`. New file: reuse a sibling's command. No database: configuring is allowed, building isn't. Then give me manual test steps.
- Rust-only changes: `cargo check` from `rust/` (with the project's features).
- Update `CHANGELOG.md` after finishing a part of the work, if the project has one.
- English docs only; don't touch translated ones (`README-ru.md`, `docs/.../{ru,zh}/`, ...).

## Rust FFI

- Rust staticlib via Corrosion; every C++ project has the gxhash FFI. The gxhash crate stays tiny `#![no_std]`; anything std-dependent or large is its own crate (own manifest, `FetchContent` + `corrosion_import_crate`).
- Tiny FFI: no `cbindgen`; C++ declares `extern "C"` itself - change the Rust signature and that declaration in the same edit. Large FFI: `cbindgen` generates the header at build time; never hand-edit it.
- `FFIString`/`ByteBuffer` are view-only unless `cap != 0`. One conversion path (`strtoffi`/`ffitostr`). Wrap results as `Result<ByteBuffer, FFIString>` etc.

## Qt

- Qt 6.8 (>= 6.8.2) under strict defines (`QT_DISABLE_DEPRECATED_UP_TO`, `QT_NO_CAST_FROM_ASCII`, `QT_NO_FOREACH`, `QT_NO_CONTEXTLESS_CONNECT`, ...): no deprecated APIs, no implicit ASCII/`QString` casts, context-bound `connect`, no `QT_BEGIN_NAMESPACE` or other legacy boilerplate. Debian stable target, so Qt may be < 6.9 (`svtostr` converts only there).
- String-view aliases (`QUtf8SV`, `QL1SV`, `QSVList`), never raw Qt names. `u"..."_qsv` by default (also as `.arg()` format string); `u"..."_s` only when a `QString` is stored or mutated.
- Strings: `%` concatenation plus one multi-argument `.arg(a, b, ...)`. No chained `.arg().arg()`, no repeated `+=`.
- `Q_DECLARE_METATYPE` for types crossing signal/slot or `QVariant`. `-> void` trailing return on lambdas passed to `connect`.
- Background work: `QtConcurrent::run(...).then(this, ...)`; always pass a context object.
- Translations: `lupdate` doesn't expand macros - register any macro wrapping a translatable literal (`-tr-function-alias`, `QT_TR_NOOP+=`) in `CMakeLists.txt`. `HEADERS` are never compiled, only there so `qt_add_translations()` sees header strings: list new headers with `tr()`; new `.cpp` go in `SOURCES`.
- User-facing messages: `Notice` (`Notice.hpp`). Constructing one _is_ logging it - never build one on a path that might not fail, never log it separately. Show with `present(parent, notice)`. Diagnostics the user never sees: `qWarning()`/`qCritical()` with `.noquote()`. Dialogs with their own buttons stay `QMessageBox`.

## FLTK

- FLTK 1.4+. Its API differs from the 1.2/1.3 that references and LLM training data assume: check installed headers (or library sources below) before assuming a method exists. No 1.2/1.3 techniques.
- `Fl_Tabs`: construct with real, non-zero geometry; lay child groups out at the same rect before `end()`. `tab_height()` derives from `child(i)->y() - y()`, so `Fl_Flex` + `client_area()` before children exist collapses the strip and hides the client area.
- Never `fl_ask.H` or `tinyfd_*` from app code: dialogs via `Dialog.hpp` (`showError`/`showWarning`/`showInfo`/`showConfirm`/`showChoice`/`pickOpenFile`/`pickSaveFile`/`pickFolder`), diagnostics via `Logger.hpp` (`logInfo`/`logWarning`/`logError`), not `cerr`/`println`.

## Licensing

A new statically-linked dependency needs `licenses/<name>/` with the real upstream license and a matching `prepare-release.lua` `LIBRARY_LIST` entry (the script fails on a mismatch either way).

## Environment

- Use Deno for all JS/TS and package management.
- On Windows, always PowerShell 7 (`pwsh`).
- The build environment (PATH, `INCLUDE`/`LIB`, rustup toolchain, ...) is dynamic, not in the shell profile. Fetch it with `deno -A C:/things/dev/set-env.ts --toolchain=msvc` (MSVC unless told otherwise); it prints ready-to-paste commands that set the toolchain and variables for the session.
    - In a fresh shell, run it and apply its output before any LLVM/Clang tool (`clang`, `clang++`, `clang-tidy`, `lld`; `clang-format` is fine standalone) or MSVC-toolchain C++ build.
    - Clang is always the GNU-style frontend (`clang`/`clang++`), never `clang-cl`; after `set-env.ts` it already targets MSVC.

## Custom Lua (`lua.exe`)

Helper scripts run on my size-stripped Lua 5.5.1 fork (source: `C:\Repos\lua`), not stock Lua. Use only what's listed.

Invocation: `lua.exe script.lua [args...]`; args arrive as `...` and in `arg` (`arg[0]` = script path). No REPL, no `-e`, no options.

Absent entirely: `package`/`require`, `coroutine`, `debug`, `math`, `utf8`. Scripts are self-contained; pull in others with `dofile("other.lua")`.

Available:

- base: `assert`, `dofile`, `error`, `getmetatable`, `ipairs`, `loadfile`, `next`, `pairs`, `pcall`, `print`, `rawequal`, `rawget`, `rawlen`, `rawset`, `select`, `setmetatable`, `tonumber`, `tostring`, `type`, `xpcall`, `_G`, `_VERSION`
- `string`: `byte`, `char`, `find`, `format`, `gmatch`, `gsub`, `len`, `lower`, `match`, `rep`, `sub`, `upper` (also as methods: `s:gsub(...)`)
- `table`: `concat`, `insert`, `remove`, `sort`, `unpack`
- `io`: `close`, `flush`, `open`, `popen`, `read`, `type`, `write`, `io.stdin`/`stdout`/`stderr`; handles have `read`, `write`, `flush`, `seek`, `close`, `setvbuf`
- `os`: `execute`, `exit`, `getenv`, `remove`, `rename`

Gone: `load`, `collectgarbage`, `warn`, `string.reverse`/`dump`/`pack`/`unpack`/`packsize`, `table.pack`/`move`/`create`, `io.lines`/`input`/`output`/`tmpfile`, `os.time`/`date`/`clock`/`difftime`/`tmpname`/`setlocale`.

- Lines: loop on `f:read("l")` or slurp with `f:read("a")`.
- `io.read` always reads stdin and `io.write` always writes stdout; use an `io.open` handle for files.
- No `math`: `//`, `%`, `^` work; `x // 1` for floor, `string.format("%d", x)` to print integers.

Other:

- `LUA_NOCVTN2S`: no number->string coercion; `"n=" .. 5` errors. Use `tostring(5)` or `string.format("n=%d", 5)`.
- `LUA_NOCVTS2N`: no string->number coercion in the VM, but string arithmetic metamethods exist, so `"10" + 1` works; `"10" < 1` still errors.
- `LUA_32BITS`: `lua_Integer` is 32-bit (wraps past ±2^31), `lua_Number` is single-precision (~7 significant digits).

## Sanity checks

For complex C/C++ libraries (Qt, FLTK - especially FLTK), read the actual source instead of guessing. Clones of every library I use are in `F:/Repos/things`.

## CLI tools

`rg` instead of `grep`, `sd` instead of `sed`, `fd` instead of `find`. All are on PATH; call them directly, don't probe or fall back.

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), use it BEFORE grep/find or reading files to understand or locate code:

- MCP tool (when available): `codegraph_explore` returns the relevant symbols' verbatim source plus call paths (including dynamic-dispatch hops grep can't follow) in one call. Name a file or symbol in the query to read its current line-numbered source. If deferred, load it by name via tool search.
- Shell: `codegraph explore "<symbol names or question>"` prints the same output.

No `.codegraph/` directory: skip CodeGraph entirely - indexing is the user's decision.
